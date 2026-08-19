/* Shared helpers for every Unamove page. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABELS = {
  pending: 'Waiting for a rider',
  assigned: 'Rider assigned',
  accepted: 'Rider on the way',
  picked_up: 'Items bought',
  in_transit: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const FLOW = ['pending', 'assigned', 'accepted', 'picked_up', 'in_transit', 'delivered'];

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
    opts.method = opts.method || 'POST';
  }
  const res = await fetch(url, opts);
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function timeOf(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function peso(amount) {
  return `₱${Number(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

/** The signature route board: where it starts, where it ends. */
function routeBoard(order, small = false) {
  return `<div class="routeboard${small ? ' small' : ''}">
    <span class="from" title="${esc(order.pickup.label)}">${esc(order.pickup.label)}</span>
    <span class="arrow" aria-hidden="true">&rarr;</span>
    <span class="to" title="${esc(order.dropoff.label)}">${esc(order.dropoff.label)}</span>
  </div>`;
}

function statusPill(status) {
  const cls = status === 'delivered' ? 'good' : status === 'cancelled' ? 'warn' : FLOW.indexOf(status) > 1 ? 'live' : '';
  return `<span class="pill ${cls}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

function timelineHtml(order) {
  const reached = new Map(order.timeline.map((t) => [t.status, t.at]));
  if (order.status === 'cancelled') {
    return `<ul class="timeline">
      <li class="done"><div><div class="t-name">Booked</div><div class="t-time">${timeOf(order.createdAt)}</div></div></li>
      <li class="now"><div><div class="t-name">Cancelled</div><div class="t-time">${timeOf(reached.get('cancelled'))}</div></div></li>
    </ul>`;
  }
  const current = FLOW.indexOf(order.status);
  return `<ul class="timeline">${FLOW.map((step, i) => {
    const cls = i < current ? 'done' : i === current ? 'now' : '';
    const at = reached.get(step);
    return `<li class="${cls}"><div>
      <div class="t-name">${esc(STATUS_LABELS[step])}</div>
      <div class="t-time">${at ? timeOf(at) : '—'}</div>
    </div></li>`;
  }).join('')}</ul>`;
}

/* ---------------- Map (Leaflet + OpenStreetMap, both free) ---------------- */

const PH_CENTER = [10.3157, 123.8854]; // Cebu City

function makeMap(elementId, center = PH_CENTER, zoom = 13) {
  const map = L.map(elementId, { zoomControl: true }).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 120);
  return map;
}

function pinIcon(letter, background) {
  return L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 2px;transform:rotate(45deg);
      background:${background};border:2px solid #12231d;display:grid;place-items:center;">
      <span style="transform:rotate(-45deg);font:700 11px/1 'Archivo Narrow',sans-serif;color:#12231d">${letter}</span></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  });
}

const riderIcon = L.divIcon({ className: '', html: '<div class="marker-rider"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

/** Keeps one moving rider marker in sync with incoming GPS fixes. */
function riderTracker(map) {
  let marker = null;
  let trail = null;
  const points = [];
  return {
    update(fix, follow = true) {
      if (!fix || !Number.isFinite(fix.lat)) return;
      const pos = [fix.lat, fix.lng];
      points.push(pos);
      if (points.length > 200) points.shift();
      if (!marker) {
        marker = L.marker(pos, { icon: riderIcon, zIndexOffset: 1000 }).addTo(map);
        trail = L.polyline(points, { color: '#12231d', weight: 3, opacity: 0.5 }).addTo(map);
      } else {
        marker.setLatLng(pos);
        trail.setLatLngs(points);
      }
      marker.bindTooltip(`Last fix ${timeOf(fix.at)}`, { direction: 'top', offset: [0, -10] });
      if (follow) map.panTo(pos, { animate: true });
    },
    clear() {
      if (marker) map.removeLayer(marker);
      if (trail) map.removeLayer(trail);
      marker = null;
      trail = null;
      points.length = 0;
    },
  };
}

/* ---------------- Chat ---------------- */

function renderChat(logEl, messages, myId) {
  logEl.innerHTML = messages
    .map((m) => {
      const mine = m.senderId === myId;
      const cls = `msg${mine ? ' mine' : ''}${!mine && m.senderRole === 'admin' ? ' admin' : ''}`;
      return `<div class="${cls}">
        <div class="meta">${esc(m.senderName)} · ${esc(m.senderRole)} · ${timeOf(m.at)}</div>
        <div class="bubble">${esc(m.text)}</div>
      </div>`;
    })
    .join('');
  logEl.scrollTop = logEl.scrollHeight;
}

/* ---------------- Session ---------------- */

async function requireRole(role) {
  try {
    const { account } = await api('/api/me');
    if (account.role !== role) {
      location.href = `/${account.role}`;
      return null;
    }
    const box = $('#whoami');
    if (box) {
      box.innerHTML = `<strong>${esc(account.fullName)}</strong>${esc(account.username)} · ${esc(account.role)}`;
    }
    return account;
  } catch (_) {
    location.href = '/';
    return null;
  }
}

function wireLogout() {
  const btn = $('#logout');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/';
  });
}
