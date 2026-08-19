/* Notification enrolment, shared by all three role pages.
 *
 * Android/Chrome: works from a normal browser tab.
 * iPhone/Safari:  only works once the site is on the Home Screen, so we detect
 *                 that case and show install steps instead of a dead button.
 */

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let swReg = null;

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
    return swReg;
  } catch (err) {
    console.warn('Service worker did not register:', err.message);
    return null;
  }
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!pushSupported) throw new Error('This browser cannot do notifications.');
  if (isIOS && !isStandalone) throw new Error('Add Unamove to your Home Screen first.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked. Turn them back on in your browser settings for this site.'
        : 'Notifications were not turned on.'
    );
  }

  const reg = swReg || (await registerWorker());
  if (!reg) throw new Error('Could not start the background worker.');
  await navigator.serviceWorker.ready;

  const { publicKey } = await api('/api/push/key');
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await api('/api/push/subscribe', { body: { subscription } });
  return true;
}

async function disablePush() {
  const reg = swReg || (await navigator.serviceWorker.getRegistration());
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

async function isPushOn() {
  if (!pushSupported || Notification.permission !== 'granted') return false;
  const reg = swReg || (await navigator.serviceWorker.getRegistration());
  if (!reg) return false;
  return Boolean(await reg.pushManager.getSubscription());
}

/**
 * Drops a notification control into #pushSlot on any page that has one.
 * Handles the four states: on, off, blocked, and "install it first" on iPhone.
 */
async function mountPushControl(roleHint = '') {
  const slot = document.getElementById('pushSlot');
  if (!slot) return;

  await registerWorker();

  async function paint() {
    if (!pushSupported) {
      slot.innerHTML = `<div class="notice"><strong>Notifications unavailable</strong>
        This browser does not support them. Chrome on Android or Safari on iPhone will work.</div>`;
      return;
    }

    if (isIOS && !isStandalone) {
      slot.innerHTML = `<div class="notice"><strong>Turn on notifications — iPhone</strong>
        Apple only allows these once Unamove is on your Home Screen.
        In <b>Safari</b>, tap the Share button, choose <b>Add to Home Screen</b>, then open Unamove
        from the new icon and come back here. It must be Safari, not Chrome.</div>`;
      return;
    }

    if (Notification.permission === 'denied') {
      slot.innerHTML = `<div class="notice bad"><strong>Notifications are blocked</strong>
        Open your browser's site settings for Unamove and allow notifications, then reload.</div>`;
      return;
    }

    const on = await isPushOn();
    slot.innerHTML = `<div class="notice ${on ? 'good' : ''}">
      <strong>${on ? 'Notifications are on' : 'Turn on notifications'}</strong>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <span style="flex:1;min-width:180px">${
          on
            ? 'This device will buzz for new messages and updates, even with Unamove closed.'
            : roleHint || 'Get told when something happens without keeping this page open.'
        }</span>
        <button class="${on ? 'ghost' : 'primary'} sm" id="pushToggle">${on ? 'Turn off' : 'Turn on'}</button>
      </div></div>`;

    document.getElementById('pushToggle').onclick = async (e) => {
      e.target.disabled = true;
      try {
        if (on) {
          await disablePush();
          toast('Notifications turned off.');
        } else {
          await enablePush();
          toast('Notifications are on.');
        }
      } catch (err) {
        toast(err.message, true);
      }
      paint();
    };
  }

  paint();
}
