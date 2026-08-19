# Unamove

Pabili and padala booking with live rider tracking. Three account types, JSON files for
storage, no merchants, no automated matching — a person at the store runs everything.

## Run it

```bash
cd unamove
npm install
npm start
```

Open http://localhost:3000

On first run the server prints an admin account:

```
username: admin
password: unamove-admin
```

Change it before anyone else can reach the server: `ADMIN_PASSWORD=something-else npm start`
on a fresh `data/accounts.json`, or edit the record after signing in.

## The three roles

**Customer** — signs up at `/`. Gives full name, age, exact address, mobile, a photo of an ID,
and a Facebook link. They can sign in immediately but cannot book until an admin marks them
verified.

**Rider** — cannot sign up. Admin registers them from the Riders tab while they are standing at
the store, then hands over the username and password.

**Admin** — verifies customers, registers riders, assigns every booking to a rider, reads and
joins every chat, watches the whole fleet on one map.

## Install it like an app (PWA)

There is no Play Store build and no $25 fee. People install it from the browser.

**Android / Chrome** — a banner offers "Install app", or Menu → Add to Home screen.
Notifications work from a normal browser tab, before installing.

**iPhone / Safari** — Share → **Add to Home Screen**, then open it from the new icon.
This step is not optional: Apple only allows web notifications for home-screen web apps
(iOS 16.4+), and it must be Safari, not Chrome. The rider and customer pages detect this and
show the install steps instead of a button that would not work.

## Notifications

Web Push with VAPID. No Firebase, no OneSignal, no bill — your server signs each message and
hands it to the push service the browser already uses (FCM for Chrome, APNs for Safari).

Keys are generated on first run into `data/vapid.json`. **Back that file up.** Losing it
invalidates every subscription and everyone has to turn notifications on again.
Set `PUSH_CONTACT=mailto:you@yourdomain.com` so push services can reach you about problems.

| Event | Who gets buzzed |
|---|---|
| Customer signs up | Admin |
| Booking created | Admin |
| Rider assigned | That rider, and the customer (with the rider's name and plate) |
| Rider accepts / bought / on the way / delivered | Customer |
| Booking cancelled | The other side |
| Chat message | Everyone in the booking except the sender — **and except anyone who already has that chat open** |

That last rule matters: without it, a back-and-forth chat buzzes your phone in your hand while
you are typing.

`data/subscriptions.json` holds one row per device, so a customer with a phone and a laptop gets
both. Dead subscriptions (browser cleared, app uninstalled) are deleted automatically when the
push service returns 404 or 410.

### What notifications cannot do

- **iPhone, not installed to Home Screen: nothing arrives.** No workaround exists.
- **They do not fix background GPS.** A notification can reach a closed app; a *web* app still
  cannot send its location with the screen off. The rider must keep Unamove open and the screen
  awake while riding. Budget a phone mount and a charger, or revisit the Capacitor path later.
- iOS may evict a PWA's storage if it goes unused for weeks, which can silently drop the
  subscription. Riders who use it daily will not hit this.

## Where the free GPS comes from

Nothing here needs an API key or a credit card:

| Piece | What it is | Cost |
|---|---|---|
| Position | `navigator.geolocation.watchPosition()` in the rider's browser | free, built into the phone |
| Transport | Socket.IO over WebSocket | free, self-hosted |
| Map tiles | OpenStreetMap standard tiles | free, attribution required (already in the code) |
| Address search | OpenStreetMap Nominatim, proxied through `/api/geocode` | free, limit 1 request/sec (enforced server-side) |

**The rider page must be served over HTTPS.** Browsers only give out location on `https://` or
`localhost`. On a phone over plain `http://` the toggle will fail. Put it behind Caddy, nginx +
Let's Encrypt, or a tunnel like Cloudflare Tunnel.

If you outgrow OSM's tile server (their policy expects light traffic), swap the one tile URL in
`public/js/common.js` for MapTiler or Stadia — both have free tiers.

## Data model

Three files in `/data`, joined by id the way tables would be.

```
accounts.json     orders.json                messages.json
  id         <───── customerId                  orderId ──> orders.id
  role              riderId  ──> accounts.id    senderId ──> accounts.id
  username          status                      senderRole
  passwordHash      pickup  {label,lat,lng}     senderName
  salt              dropoff {label,lat,lng}     text
  fullName          instructions                at
  age               budget
  address           deliveryFee
  phone             createdAt / assignedAt
  idPhoto           completedAt
  facebookLink      timeline[]
  status
  lastLocation
```

`accounts.json` holds all three roles in one list, separated by `role`. Rider-only fields
(`plateNumber`, `vehicle`, `licenseNumber`, `isOnline`, `lastLocation`) and customer-only fields
(`age`, `idPhoto`, `facebookLink`, `reviewNote`) sit on the same records and stay empty for roles
that don't use them.

Order status moves in one direction:

```
pending ─> assigned ─> accepted ─> picked_up ─> in_transit ─> delivered
   └──────────────┴──> cancelled
```

Writes go to a temp file and get renamed over the real one, so a crash mid-write cannot leave a
half-written JSON file. Everything is held in memory while the server runs.

### Who can see what

The Facebook link and the ID photo never leave the admin routes. ID photos are stored in
`private_uploads/`, which is **not** served statically — the only way to see one is
`GET /api/admin/id-photo/:id` with an admin session. A customer sees their rider's name, plate,
vehicle and mobile. A rider sees their customer's name, mobile and address. Neither sees more.

## Things you should know before trusting this with real people

- **I could not run it.** The machine I built it on has no network access, so `npm install` never
  happened and nothing was executed. The syntax checks out; the behaviour is unverified. Click
  through every flow locally before putting it in front of anyone.
- **Sessions live in memory.** Restarting the server signs everyone out. Fine for one store.
- **JSON is not concurrent.** One process only. Do not run two copies against the same `/data`
  folder, and do not put this behind a load balancer without moving to SQLite first.
- **ID photos sit unencrypted on disk.** You are holding government IDs of real people. Back up
  `/data` and `/private_uploads` somewhere private, and delete photos once an account is verified
  if you don't need to keep them.
- **No rate limit on sign-in.** Add one before this faces the open internet.
- **No payments.** Cash is settled between the customer and the rider, in the chat.
- **Push needs real HTTPS.** Service workers refuse to register on plain `http://`, same as
  geolocation. `localhost` is exempt for testing.

## Layout

```
server.js              all routes, sockets, GPS relay, auth
lib/db.js              JSON store: load, save, atomic write
lib/push.js            VAPID keys, subscription store, delivery
data/*.json            the database (accounts, orders, messages, subscriptions)
data/vapid.json        push signing keys — back this up, never commit it
private_uploads/       ID photos, admin-only
public/index.html      sign in + customer sign-up
public/manifest.webmanifest  makes it installable
public/sw.js           service worker: receives push, opens the right page
public/offline.html    shown when the connection drops
public/icons/          app icons
public/js/push.js      notification opt-in, iOS install detection
public/customer.html   book, track, chat
public/rider.html      GPS toggle, jobs, chat
public/admin.html      verify, register riders, assign, fleet map
public/app.css         shared styles
public/js/common.js    shared browser helpers
```
