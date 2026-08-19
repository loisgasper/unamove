'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Server } = require('socket.io');

const db = require('./lib/db');
const push = require('./lib/push');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'private_uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

// --- ID photos are never served as static files. Admin-only route below. ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 5);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|heic)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error('ID photo must be a JPG, PNG or WEBP image.'));
  },
});

// ==========================================================================
// Passwords and sessions
// ==========================================================================

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(account, password) {
  if (!account || !account.salt) return false;
  const { hash } = hashPassword(password, account.salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(account.passwordHash));
}

// token -> accountId. Held in memory, so a restart signs everyone out.
const sessions = new Map();

function startSession(res, accountId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, accountId);
  res.cookie('unamove_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14,
  });
  return token;
}

function accountFromToken(token) {
  if (!token) return null;
  const id = sessions.get(token);
  if (!id) return null;
  const account = db.findAccount(id);
  if (!account || account.status === 'suspended') return null;
  return account;
}

function currentAccount(req) {
  return accountFromToken(req.cookies && req.cookies.unamove_session);
}

function requireAuth(...roles) {
  return (req, res, next) => {
    const account = currentAccount(req);
    if (!account) return res.status(401).json({ error: 'Sign in to continue.' });
    if (roles.length && !roles.includes(account.role)) {
      return res.status(403).json({ error: 'This area is for a different account type.' });
    }
    req.account = account;
    next();
  };
}

// ==========================================================================
// What each role is allowed to see about another account
// ==========================================================================

/** Full record minus credentials. Admin eyes only. */
function adminView(a) {
  const { passwordHash, salt, ...rest } = a;
  return { ...rest, hasIdPhoto: Boolean(a.idPhoto) };
}

/** The signed-in person's own record. Never includes the Facebook link. */
function selfView(a) {
  return {
    id: a.id,
    role: a.role,
    username: a.username,
    fullName: a.fullName,
    phone: a.phone,
    address: a.address || '',
    age: a.age || null,
    status: a.status,
    vehicle: a.vehicle || '',
    plateNumber: a.plateNumber || '',
    reviewNote: a.reviewNote || '',
  };
}

/** What a customer sees about their rider, and a rider about their customer. */
function counterpartView(a, viewerRole) {
  if (!a) return null;
  const card = { id: a.id, role: a.role, fullName: a.fullName, phone: a.phone };
  if (a.role === 'rider') {
    card.vehicle = a.vehicle || '';
    card.plateNumber = a.plateNumber || '';
  }
  // A rider needs the delivery address to actually get there.
  if (a.role === 'customer' && viewerRole === 'rider') card.address = a.address || '';
  return card;
}

// ==========================================================================
// Orders
// ==========================================================================

const STATUS_LABELS = {
  pending: 'Waiting for a rider',
  assigned: 'Rider assigned',
  accepted: 'Rider on the way',
  picked_up: 'Items bought',
  in_transit: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// Which status a rider may move an order to, from where.
const RIDER_MOVES = {
  assigned: ['accepted'],
  accepted: ['picked_up'],
  picked_up: ['in_transit'],
  in_transit: ['delivered'],
};

const OPEN_STATUSES = ['pending', 'assigned', 'accepted', 'picked_up', 'in_transit'];

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function point(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const label = String(raw.label || '').trim().slice(0, 200);
  if (!label) return null;
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return { label, lat: ok ? lat : null, lng: ok ? lng : null };
}

function orderView(order, viewer) {
  const customer = db.findAccount(order.customerId);
  const rider = order.riderId ? db.findAccount(order.riderId) : null;
  const base = {
    ...order,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    customer: null,
    rider: null,
  };
  if (viewer.role === 'admin') {
    base.customer = customer ? { id: customer.id, fullName: customer.fullName, phone: customer.phone, address: customer.address } : null;
    base.rider = rider ? { id: rider.id, fullName: rider.fullName, phone: rider.phone, plateNumber: rider.plateNumber } : null;
  } else {
    base.customer = counterpartView(customer, viewer.role);
    base.rider = counterpartView(rider, viewer.role);
  }
  return base;
}

function canSeeOrder(order, account) {
  if (!order) return false;
  if (account.role === 'admin') return true;
  if (account.role === 'customer') return order.customerId === account.id;
  if (account.role === 'rider') return order.riderId === account.id;
  return false;
}

function pushTimeline(order, status, byId) {
  order.timeline.push({ status, at: new Date().toISOString(), by: byId });
}

/**
 * True when the account has this booking open right now. Used to skip the push,
 * because buzzing someone about a message they are already reading is noise.
 */
function isWatching(accountId, orderId) {
  const room = `order:${orderId}`;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.account && socket.data.account.id === accountId && socket.rooms.has(room)) return true;
  }
  return false;
}

/** Short route line for notification bodies: "Aling Nena → Purok 3". */
function routeLine(order) {
  const trim = (t) => (t.length > 28 ? `${t.slice(0, 27)}\u2026` : t);
  return `${trim(order.pickup.label)} \u2192 ${trim(order.dropoff.label)}`;
}

function broadcastOrder(order) {
  const room = `order:${order.id}`;
  for (const socket of io.sockets.sockets.values()) {
    const account = socket.data.account && db.findAccount(socket.data.account.id);
    if (!account) continue;
    if (socket.rooms.has(room) || account.role === 'admin') {
      socket.emit('order:update', orderView(order, account));
    }
  }
}

// ==========================================================================
// Auth routes
// ==========================================================================

app.post('/api/register', upload.single('idPhoto'), (req, res) => {
  const b = req.body || {};
  const required = ['username', 'password', 'fullName', 'age', 'address', 'phone'];
  for (const field of required) {
    if (!String(b[field] || '').trim()) {
      return res.status(400).json({ error: `Fill in your ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}.` });
    }
  }
  if (String(b.password).length < 8) {
    return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  }
  if (db.findByUsername(b.username)) {
    return res.status(409).json({ error: 'That username is taken. Pick another one.' });
  }
  const age = Number(b.age);
  if (!Number.isFinite(age) || age < 15 || age > 120) {
    return res.status(400).json({ error: 'Enter a valid age.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Attach a photo of your ID. Admin checks this by hand.' });
  }

  const { salt, hash } = hashPassword(b.password);
  const account = {
    id: newId('acc'),
    role: 'customer',
    username: String(b.username).trim(),
    passwordHash: hash,
    salt,
    fullName: String(b.fullName).trim(),
    age,
    address: String(b.address).trim(),
    phone: String(b.phone).trim(),
    idPhoto: req.file.filename,
    facebookLink: String(b.facebookLink || '').trim(), // admin verification only
    status: 'pending',
    reviewNote: '',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.accounts().push(account);
  db.save('accounts');

  io.to('admins').emit('admin:newSignup', adminView(account));
  push.sendToAdmins({
    title: 'New customer to verify',
    body: `${account.fullName} signed up and is waiting for verification.`,
    url: '/admin',
    tag: 'signups',
    renotify: true,
  });
  startSession(res, account.id);
  res.json({ account: selfView(account) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = db.findByUsername(username);
  if (!account || !checkPassword(account, password)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (account.status === 'suspended') {
    return res.status(403).json({ error: 'This account is suspended. Visit the store to sort it out.' });
  }
  startSession(res, account.id);
  res.json({ account: selfView(account) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.unamove_session;
  if (token) sessions.delete(token);
  res.clearCookie('unamove_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.status(401).json({ error: 'Sign in to continue.' });
  res.json({ account: selfView(account) });
});

// ==========================================================================
// Customer routes
// ==========================================================================

app.post('/api/orders', requireAuth('customer'), (req, res) => {
  if (req.account.status !== 'verified') {
    return res.status(403).json({ error: 'Admin has not verified your account yet.' });
  }
  const b = req.body || {};
  const pickup = point(b.pickup);
  const dropoff = point(b.dropoff);
  if (!pickup) return res.status(400).json({ error: 'Name the store or pickup point.' });
  if (!dropoff) return res.status(400).json({ error: 'Name the drop-off point.' });
  const instructions = String(b.instructions || '').trim();
  if (!instructions) return res.status(400).json({ error: 'Write what the rider should buy or bring.' });

  const order = {
    id: newId('ord'),
    customerId: req.account.id,
    riderId: null,
    status: 'pending',
    pickup,
    dropoff,
    instructions: instructions.slice(0, 2000),
    budget: Number(b.budget) || 0,
    deliveryFee: 0,
    createdAt: new Date().toISOString(),
    assignedAt: null,
    completedAt: null,
    cancelReason: '',
    timeline: [{ status: 'pending', at: new Date().toISOString(), by: req.account.id }],
  };
  db.orders().push(order);
  db.save('orders');

  io.to('admins').emit('admin:newOrder', order);
  push.sendToAdmins({
    title: 'New booking',
    body: `${req.account.fullName}: ${routeLine(order)}`,
    url: '/admin',
    tag: 'bookings',
    renotify: true,
    urgency: 'high',
  });
  res.json({ order: orderView(order, req.account) });
});

app.get('/api/orders', requireAuth('customer', 'rider'), (req, res) => {
  const key = req.account.role === 'customer' ? 'customerId' : 'riderId';
  const list = db
    .orders()
    .filter((o) => o[key] === req.account.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => orderView(o, req.account));
  res.json({ orders: list });
});

app.get('/api/orders/:id', requireAuth(), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!canSeeOrder(order, req.account)) return res.status(404).json({ error: 'Booking not found.' });
  const view = orderView(order, req.account);
  if (order.riderId) {
    const live = liveLocations.get(order.riderId);
    if (live) view.riderLocation = live;
  }
  res.json({ order: view });
});

app.post('/api/orders/:id/cancel', requireAuth('customer', 'admin'), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!canSeeOrder(order, req.account)) return res.status(404).json({ error: 'Booking not found.' });
  if (!OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'This booking is already closed.' });
  }
  if (req.account.role === 'customer' && !['pending', 'assigned'].includes(order.status)) {
    return res.status(400).json({ error: 'The rider already started. Message them or ask admin to cancel.' });
  }
  order.status = 'cancelled';
  order.cancelReason = String((req.body && req.body.reason) || '').slice(0, 300);
  order.completedAt = new Date().toISOString();
  pushTimeline(order, 'cancelled', req.account.id);
  db.save('orders');
  broadcastOrder(order);
  const tellThese = req.account.role === 'admin'
    ? [order.customerId, order.riderId]
    : [order.riderId];
  push.sendToMany(tellThese.filter(Boolean), {
    title: 'Booking cancelled',
    body: routeLine(order),
    url: `/${req.account.role === 'admin' ? 'customer' : 'rider'}`,
    tag: `order-${order.id}`,
    renotify: true,
  });
  res.json({ order: orderView(order, req.account) });
});

// ==========================================================================
// Rider routes
// ==========================================================================

app.post('/api/orders/:id/status', requireAuth('rider'), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!order || order.riderId !== req.account.id) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  const next = String((req.body && req.body.status) || '');
  const allowed = RIDER_MOVES[order.status] || [];
  if (!allowed.includes(next)) {
    return res.status(400).json({ error: `You cannot move this booking to ${next} right now.` });
  }
  order.status = next;
  if (next === 'delivered') order.completedAt = new Date().toISOString();
  pushTimeline(order, next, req.account.id);
  db.save('orders');
  broadcastOrder(order);

  const headline = {
    accepted: 'Your rider is on the way',
    picked_up: 'Your rider bought the items',
    in_transit: 'Your order is out for delivery',
    delivered: 'Delivered',
  }[next];
  if (headline) {
    push.sendTo(order.customerId, {
      title: headline,
      body: `${req.account.fullName} \u00b7 ${req.account.plateNumber || 'no plate on file'}`,
      url: '/customer',
      tag: `order-${order.id}`,
      renotify: true,
      urgency: 'high',
    });
  }
  res.json({ order: orderView(order, req.account) });
});

app.post('/api/orders/:id/decline', requireAuth('rider'), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!order || order.riderId !== req.account.id || order.status !== 'assigned') {
    return res.status(400).json({ error: 'You can only hand back a booking you have not accepted.' });
  }
  order.riderId = null;
  order.status = 'pending';
  order.assignedAt = null;
  pushTimeline(order, 'pending', req.account.id);
  db.save('orders');
  broadcastOrder(order);
  io.to('admins').emit('admin:newOrder', order);
  res.json({ ok: true });
});

// ==========================================================================
// Chat
// ==========================================================================

app.get('/api/orders/:id/messages', requireAuth(), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!canSeeOrder(order, req.account)) return res.status(404).json({ error: 'Booking not found.' });
  const list = db.messages().filter((m) => m.orderId === order.id);
  res.json({ messages: list });
});

// ==========================================================================
// Admin routes
// ==========================================================================

app.get('/api/admin/accounts', requireAuth('admin'), (req, res) => {
  const { role, status } = req.query;
  let list = db.accounts();
  if (role) list = list.filter((a) => a.role === role);
  if (status) list = list.filter((a) => a.status === status);
  res.json({
    accounts: list
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(adminView),
  });
});

app.get('/api/admin/id-photo/:id', requireAuth('admin'), (req, res) => {
  const account = db.findAccount(req.params.id);
  if (!account || !account.idPhoto) return res.status(404).send('No ID photo on file.');
  const file = path.join(UPLOAD_DIR, path.basename(account.idPhoto));
  if (!fs.existsSync(file)) return res.status(404).send('No ID photo on file.');
  res.sendFile(file);
});

app.post('/api/admin/accounts/:id/review', requireAuth('admin'), (req, res) => {
  const account = db.findAccount(req.params.id);
  if (!account || account.role !== 'customer') return res.status(404).json({ error: 'Customer not found.' });
  const status = String((req.body && req.body.status) || '');
  if (!['verified', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Set the account to verified, rejected or pending.' });
  }
  account.status = status;
  account.reviewNote = String((req.body && req.body.note) || '').slice(0, 500);
  account.reviewedBy = req.account.id;
  account.reviewedAt = new Date().toISOString();
  db.save('accounts');
  io.to(`user:${account.id}`).emit('account:update', selfView(account));
  if (status === 'verified') {
    push.sendTo(account.id, {
      title: 'Your account is verified',
      body: 'You can book a rider now.',
      url: '/customer',
      tag: 'account',
    });
  } else if (status === 'rejected') {
    push.sendTo(account.id, {
      title: 'Account not verified',
      body: account.reviewNote || 'Visit the store with your ID to sort this out.',
      url: '/customer',
      tag: 'account',
    });
  }
  res.json({ account: adminView(account) });
});

app.post('/api/admin/riders', requireAuth('admin'), (req, res) => {
  const b = req.body || {};
  for (const field of ['username', 'password', 'fullName', 'phone', 'plateNumber']) {
    if (!String(b[field] || '').trim()) {
      return res.status(400).json({ error: `Fill in the rider's ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}.` });
    }
  }
  if (String(b.password).length < 8) {
    return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  }
  if (db.findByUsername(b.username)) {
    return res.status(409).json({ error: 'That username is taken. Pick another one.' });
  }
  const { salt, hash } = hashPassword(b.password);
  const rider = {
    id: newId('acc'),
    role: 'rider',
    username: String(b.username).trim(),
    passwordHash: hash,
    salt,
    fullName: String(b.fullName).trim(),
    age: Number(b.age) || null,
    address: String(b.address || '').trim(),
    phone: String(b.phone).trim(),
    vehicle: String(b.vehicle || 'Motorcycle').trim(),
    plateNumber: String(b.plateNumber).trim().toUpperCase(),
    licenseNumber: String(b.licenseNumber || '').trim(),
    status: 'active',
    isOnline: false,
    lastLocation: null,
    registeredBy: req.account.id,
    createdAt: new Date().toISOString(),
  };
  db.accounts().push(rider);
  db.save('accounts');
  res.json({ account: adminView(rider) });
});

app.post('/api/admin/accounts/:id/suspend', requireAuth('admin'), (req, res) => {
  const account = db.findAccount(req.params.id);
  if (!account || account.role === 'admin') return res.status(404).json({ error: 'Account not found.' });
  if (account.status === 'suspended') {
    account.status = account.previousStatus || (account.role === 'rider' ? 'active' : 'pending');
    account.previousStatus = null;
  } else {
    account.previousStatus = account.status;
    account.status = 'suspended';
  }
  db.save('accounts');
  res.json({ account: adminView(account) });
});

app.get('/api/admin/orders', requireAuth('admin'), (req, res) => {
  const list = db
    .orders()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => orderView(o, req.account));
  res.json({ orders: list });
});

app.post('/api/admin/orders/:id/assign', requireAuth('admin'), (req, res) => {
  const order = db.findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Booking not found.' });
  if (!OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'This booking is already closed.' });
  }
  const rider = db.findAccount(String((req.body && req.body.riderId) || ''));
  if (!rider || rider.role !== 'rider' || rider.status !== 'active') {
    return res.status(400).json({ error: 'Pick an active rider.' });
  }
  order.riderId = rider.id;
  order.assignedAt = new Date().toISOString();
  if (order.status === 'pending') order.status = 'assigned';
  order.deliveryFee = Number(req.body.deliveryFee) || order.deliveryFee || 0;
  pushTimeline(order, 'assigned', req.account.id);
  db.save('orders');
  broadcastOrder(order);
  io.to(`user:${rider.id}`).emit('rider:newJob', orderView(order, rider));
  push.sendTo(rider.id, {
    title: 'New booking assigned to you',
    body: routeLine(order),
    url: '/rider',
    tag: `order-${order.id}`,
    renotify: true,
    requireInteraction: true,
    urgency: 'high',
  });
  push.sendTo(order.customerId, {
    title: 'You have a rider',
    body: `${rider.fullName} \u00b7 ${rider.plateNumber} is taking your booking.`,
    url: '/customer',
    tag: `order-${order.id}`,
    renotify: true,
  });
  res.json({ order: orderView(order, req.account) });
});

app.get('/api/admin/fleet', requireAuth('admin'), (req, res) => {
  const riders = db.accounts().filter((a) => a.role === 'rider' && a.status === 'active');
  res.json({
    riders: riders.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      plateNumber: r.plateNumber,
      phone: r.phone,
      isOnline: r.isOnline,
      location: liveLocations.get(r.id) || r.lastLocation || null,
      activeOrders: db.orders().filter((o) => o.riderId === r.id && OPEN_STATUSES.includes(o.status)).length,
    })),
  });
});

// ==========================================================================
// Push notifications
// ==========================================================================

app.get('/api/push/key', requireAuth(), (req, res) => {
  const key = push.publicKey();
  if (!key) return res.status(503).json({ error: 'Notifications are not set up on this server.' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', requireAuth(), (req, res) => {
  const ok = push.subscribe(req.account.id, req.body && req.body.subscription);
  if (!ok) return res.status(400).json({ error: 'That subscription was not valid.' });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth(), (req, res) => {
  push.unsubscribe(String((req.body && req.body.endpoint) || ''));
  res.json({ ok: true });
});

// ==========================================================================
// Address search - OpenStreetMap Nominatim, proxied so we can send a real
// User-Agent as their usage policy asks. Free, rate limited to 1 req/sec.
// ==========================================================================

let lastGeocodeAt = 0;
app.get('/api/geocode', requireAuth(), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ph&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Unamove/0.1 (self-hosted booking app)' } });
    const data = await r.json();
    res.json({
      results: data.map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) })),
    });
  } catch (err) {
    res.status(502).json({ error: 'Address search is unavailable. Drop a pin on the map instead.' });
  }
});

// ==========================================================================
// Sockets: chat + live GPS
// ==========================================================================

/** riderId -> { lat, lng, accuracy, heading, speed, at } */
const liveLocations = new Map();
const lastPersisted = new Map();

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const account = accountFromToken(cookies.unamove_session);
  if (!account) return next(new Error('Sign in to continue.'));
  socket.data.account = { id: account.id, role: account.role };
  next();
});

io.on('connection', (socket) => {
  const { id: accountId, role } = socket.data.account;
  socket.join(`user:${accountId}`);
  if (role === 'admin') socket.join('admins');

  if (role === 'rider') {
    const rider = db.findAccount(accountId);
    if (rider) {
      rider.isOnline = true;
      db.save('accounts');
      io.to('admins').emit('fleet:presence', { riderId: accountId, isOnline: true });
    }
  }

  socket.on('order:join', (payload, ack) => {
    const order = db.findOrder(String((payload && payload.orderId) || ''));
    const account = db.findAccount(accountId);
    if (!canSeeOrder(order, account)) {
      if (typeof ack === 'function') ack({ error: 'Booking not found.' });
      return;
    }
    socket.join(`order:${order.id}`);
    const history = db.messages().filter((m) => m.orderId === order.id);
    if (typeof ack === 'function') {
      ack({
        order: orderView(order, account),
        messages: history,
        riderLocation: order.riderId ? liveLocations.get(order.riderId) || null : null,
      });
    }
  });

  socket.on('order:leave', (payload) => {
    const id = String((payload && payload.orderId) || '');
    if (id) socket.leave(`order:${id}`);
  });

  socket.on('chat:send', (payload, ack) => {
    const account = db.findAccount(accountId);
    const order = db.findOrder(String((payload && payload.orderId) || ''));
    if (!canSeeOrder(order, account)) {
      if (typeof ack === 'function') ack({ error: 'Booking not found.' });
      return;
    }
    const text = String((payload && payload.text) || '').trim().slice(0, 1000);
    if (!text) return;
    const message = {
      id: newId('msg'),
      orderId: order.id,
      senderId: account.id,
      senderRole: account.role,
      senderName: account.fullName,
      text,
      at: new Date().toISOString(),
    };
    db.messages().push(message);
    db.save('messages');
    io.to(`order:${order.id}`).emit('chat:message', message);
    io.to('admins').emit('chat:message', message);

    // Everyone in this booking except the sender and anyone already reading it.
    const inChat = [order.customerId, order.riderId].filter(Boolean);
    const admins = db.accounts().filter((a) => a.role === 'admin').map((a) => a.id);
    const recipients = [...new Set([...inChat, ...admins])]
      .filter((id) => id !== account.id && !isWatching(id, order.id));

    for (const recipientId of recipients) {
      const recipient = db.findAccount(recipientId);
      if (!recipient) continue;
      push.sendTo(recipientId, {
        title: `${account.fullName} (${account.role})`,
        body: text.length > 120 ? `${text.slice(0, 119)}\u2026` : text,
        url: `/${recipient.role}`, // land each person on their own screen
        tag: `chat-${order.id}`,
        renotify: true,
        urgency: 'high',
      });
    }

    if (typeof ack === 'function') ack({ ok: true });
  });

  // The rider's phone sends this every few seconds from watchPosition().
  socket.on('rider:location', (payload) => {
    if (role !== 'rider') return;
    const lat = Number(payload && payload.lat);
    const lng = Number(payload && payload.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    const fix = {
      riderId: accountId,
      lat,
      lng,
      accuracy: Number(payload.accuracy) || null,
      heading: Number.isFinite(Number(payload.heading)) ? Number(payload.heading) : null,
      speed: Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : null,
      at: new Date().toISOString(),
    };
    liveLocations.set(accountId, fix);

    // Push to whoever is watching this rider's open bookings.
    for (const order of db.orders()) {
      if (order.riderId === accountId && OPEN_STATUSES.includes(order.status)) {
        io.to(`order:${order.id}`).emit('rider:location', { ...fix, orderId: order.id });
      }
    }
    io.to('admins').emit('fleet:location', fix);

    // Persist at most every 20s so the last known pin survives a restart.
    if (Date.now() - (lastPersisted.get(accountId) || 0) > 20000) {
      lastPersisted.set(accountId, Date.now());
      const rider = db.findAccount(accountId);
      if (rider) {
        rider.lastLocation = fix;
        db.save('accounts');
      }
    }
  });

  socket.on('disconnect', () => {
    if (role !== 'rider') return;
    const stillConnected = [...io.sockets.sockets.values()].some(
      (s) => s.id !== socket.id && s.data.account && s.data.account.id === accountId
    );
    if (stillConnected) return;
    const rider = db.findAccount(accountId);
    if (rider) {
      rider.isOnline = false;
      db.save('accounts');
    }
    liveLocations.delete(accountId);
    io.to('admins').emit('fleet:presence', { riderId: accountId, isOnline: false });
  });
});

// ==========================================================================
// Page routing + first run
// ==========================================================================

app.get('/', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.sendFile(path.join(ROOT, 'public', 'index.html'));
  res.redirect(`/${account.role}`);
});
app.get('/customer', (req, res) => res.sendFile(path.join(ROOT, 'public', 'customer.html')));
app.get('/rider', (req, res) => res.sendFile(path.join(ROOT, 'public', 'rider.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

function seedAdmin() {
  if (db.accounts().some((a) => a.role === 'admin')) return;
  const password = process.env.ADMIN_PASSWORD || 'unamove-admin';
  const { salt, hash } = hashPassword(password);
  db.accounts().push({
    id: newId('acc'),
    role: 'admin',
    username: 'admin',
    passwordHash: hash,
    salt,
    fullName: 'Store Admin',
    phone: '',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  db.save('accounts');
  console.log(`\n  First run: admin account created.`);
  console.log(`  username: admin`);
  console.log(`  password: ${password}`);
  console.log(`  Change this before anyone else can reach the server.\n`);
}

db.load('accounts');
db.load('orders');
db.load('messages');
db.load('subscriptions');
push.init(process.env.PUSH_CONTACT || 'mailto:admin@unamove.local');
seedAdmin();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    db.flush();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Unamove is running at http://localhost:${PORT}`);
});
