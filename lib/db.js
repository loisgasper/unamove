'use strict';
/**
 * Tiny JSON file store.
 *
 * Every collection is one file in /data. Files are held in memory while the
 * server runs, so reads are instant. Writes are debounced and then written to a
 * temp file and renamed over the real one, which means a crash mid-write cannot
 * leave a half-written JSON file behind.
 *
 * Records are linked by id the same way tables would be:
 *   orders.customerId  -> accounts.id
 *   orders.riderId     -> accounts.id
 *   messages.orderId   -> orders.id
 *   messages.senderId  -> accounts.id
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const SHAPES = {
  accounts: { accounts: [] },
  orders: { orders: [] },
  messages: { messages: [] },
  subscriptions: { subscriptions: [] },
};

const cache = {};
const pending = {};

fs.mkdirSync(DATA_DIR, { recursive: true });

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name) {
  if (cache[name]) return cache[name];
  const file = fileFor(name);
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    cache[name] = raw ? JSON.parse(raw) : structuredClone(SHAPES[name]);
  } else {
    cache[name] = structuredClone(SHAPES[name]);
    writeNow(name);
  }
  return cache[name];
}

function writeNow(name) {
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 2));
  fs.renameSync(tmp, file);
}

/** Mark a collection dirty. The file is written ~80ms later. */
function save(name) {
  if (pending[name]) return;
  pending[name] = setTimeout(() => {
    delete pending[name];
    try {
      writeNow(name);
    } catch (err) {
      console.error(`Could not save ${name}.json:`, err.message);
    }
  }, 80);
}

function flush() {
  for (const name of Object.keys(pending)) {
    clearTimeout(pending[name]);
    delete pending[name];
  }
  for (const name of Object.keys(cache)) {
    try {
      writeNow(name);
    } catch (err) {
      console.error(`Could not save ${name}.json:`, err.message);
    }
  }
}

// Collection helpers -------------------------------------------------------

const accounts = () => load('accounts').accounts;
const orders = () => load('orders').orders;
const messages = () => load('messages').messages;
const subscriptions = () => load('subscriptions').subscriptions;

const findAccount = (id) => accounts().find((a) => a.id === id) || null;
const findByUsername = (u) =>
  accounts().find((a) => a.username.toLowerCase() === String(u || '').toLowerCase()) || null;
const findOrder = (id) => orders().find((o) => o.id === id) || null;

module.exports = {
  DATA_DIR,
  load,
  save,
  flush,
  accounts,
  orders,
  messages,
  subscriptions,
  findAccount,
  findByUsername,
  findOrder,
};
