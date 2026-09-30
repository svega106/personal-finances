/**
 * Notifications on this device — each new charge, and the cutoff reminders:
 * the permission, the subscription, which kinds this device gets, and saying
 * plainly when any of it is not possible.
 *
 * Permission is only ever asked for from the Settings switch — never on load.
 * A browser that has been asked once and refused will not ask again, so the
 * question is saved for the moment someone has decided they want the answer.
 *
 * Every way this can fail is a state of its own, because each has a different
 * remedy:
 *
 *   unsupported    the browser has no Web Push at all
 *   needs-install  iPhone / iPad in Safari: push exists only for an app added
 *                  to the Home Screen
 *   no-worker      no service worker (the dev server runs without one)
 *   denied         refused; only the browser's own settings can undo that
 *   off            possible, not switched on here
 *   on             this device receives notifications
 *
 * Which kinds — new charges, cutoff reminders — is kept per device on its
 * subscription row, so a phone can have both and a laptop only one.
 */
import { getRepo } from './repo.js';
import { VAPID_PUBLIC_KEY } from './push-config.js';

function isAppleMobile() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState() {
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPush) return isAppleMobile() && !isInstalled() ? 'needs-install' : 'unsupported';
  const reg = await registration();
  if (!reg) return 'no-worker';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/** A base64url key as the bytes `subscribe` wants. */
function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function toRow(sub) {
  const j = sub.toJSON();
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, userAgent: navigator.userAgent };
}

/**
 * Ask, subscribe, and tell the server where to send. Returns the new state.
 * A subscription the server could not save is taken back, so this device
 * never shows "on" while nothing would ever reach it.
 */
export async function enablePush() {
  const state = await pushState();
  if (state !== 'off') return state;

  const answer = await Notification.requestPermission();
  if (answer !== 'granted') return answer === 'denied' ? 'denied' : 'off';

  const reg = await registration();
  if (!reg) return 'no-worker';
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(VAPID_PUBLIC_KEY),
  });
  try {
    await getRepo().savePushSubscription(toRow(sub));
  } catch (err) {
    await sub.unsubscribe().catch(() => {});
    throw err;
  }
  return 'on';
}

export async function disablePush() {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const { endpoint } = sub;
    await sub.unsubscribe();
    await getRepo().deletePushSubscription(endpoint);
  }
  return pushState();
}

/**
 * A browser may rotate a subscription on its own. Re-saving it at start-up —
 * an upsert, so harmless when nothing changed — keeps the server's copy the
 * one that works. Quiet: a failure here is not worth interrupting anyone for.
 */
export async function refreshPushSubscription() {
  try {
    if ((await pushState()) !== 'on') return;
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) await getRepo().savePushSubscription(toRow(sub));
  } catch (err) {
    console.warn('[push]', err.message);
  }
}

async function currentEndpoint() {
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/**
 * Which kinds this device gets: { charges, cutoffs }. Both on when the server
 * has no row for it yet — a new subscription starts that way.
 */
export async function pushPrefs() {
  const endpoint = await currentEndpoint();
  if (!endpoint) return null;
  return (await getRepo().getPushPrefs(endpoint)) ?? { charges: true, cutoffs: true };
}

/** Switch one kind on or off for this device. */
export async function setPushPref(kind, on) {
  const endpoint = await currentEndpoint();
  if (!endpoint) throw new Error('Notifications are not on for this device.');
  await getRepo().savePushPrefs(endpoint, { [kind]: on });
}

/** Shows a notification shaped like a new-charge alert now, through the service worker. */
export async function testNotification() {
  const reg = await registration();
  if (!reg) throw new Error('No service worker on this page.');
  await reg.showNotification('Notifications are on', {
    body: 'A new charge will look like this: its amount and where, then the card it was on.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'test',
    data: { url: '/?view=settings' },
  });
}
