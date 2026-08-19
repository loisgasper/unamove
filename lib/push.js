'use strict';
/**
 * Web Push for Unamove.
 *
 * Uses VAPID, which is the open standard behind browser push. There is no
 * Firebase, no third-party service and no bill: your server signs each message
 * and hands it to whichever push service the browser already uses (FCM for
 * Chrome, APNs for Safari, Mozilla's for Firefox). Those are free to you.
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');

const KEY_FILE = path.join(db.DATA_DIR, 'vapid.json');

let keys = null;

function init(contact = 'mailto:admin@unamove.local') {
  if (fs.existsSync(KEY_FILE)) {
    keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2));
    console.log('  Generated VAPID keys in data/vapid.json. Keep this file — losing it');
    console.log('  invalidates every existing notification subscription.\n');
  }
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  db.load('subscriptions');
  return keys.publicKey;
}

const publicKey = () => keys && keys.publicKey;

/** One account can have several devices, so subscriptions are keyed by endpoint. */
function subscribe(accountId, subscription) {
  if (!subscription || !subscription.endpoint) return false;
  const list = db.subscriptions();
  const existing = list.find((s) => s.endpoint === subscription.endpoint);
  if (existing) {
    existing.accountId = accountId;
    existing.seenAt = new Date().toISOString();
  } else {
    list.push({
      accountId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      createdAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
    });
  }
  db.save('subscriptions');
  return true;
}

function unsubscribe(endpoint) {
  const list = db.subscriptions();
  const i = list.findIndex((s) => s.endpoint === endpoint);
  if (i === -1) return false;
  list.splice(i, 1);
  db.save('subscriptions');
  return true;
}

function drop(endpoint) {
  unsubscribe(endpoint);
}

/**
 * Send to every device belonging to an account.
 * payload: { title, body, url, tag, renotify, requireInteraction }
 */
async function sendTo(accountId, payload) {
  if (!keys) return;
  const targets = db.subscriptions().filter((s) => s.accountId === accountId);
  const body = JSON.stringify(payload);

  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 600, urgency: payload.urgency || 'normal' }
        );
      } catch (err) {
        // 404 and 410 mean the browser threw the subscription away. Clean up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          drop(sub.endpoint);
        } else {
          console.error(`Push failed for ${accountId}:`, err.statusCode || err.message);
        }
      }
    })
  );
}

async function sendToMany(accountIds, payload) {
  await Promise.all([...new Set(accountIds)].map((id) => sendTo(id, payload)));
}

async function sendToAdmins(payload) {
  const admins = db.accounts().filter((a) => a.role === 'admin').map((a) => a.id);
  await sendToMany(admins, payload);
}

module.exports = { init, publicKey, subscribe, unsubscribe, sendTo, sendToMany, sendToAdmins };
