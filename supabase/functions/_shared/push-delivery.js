/**
 * One notification to every device a person has switched on, and the devices
 * that turn out to be gone.
 *
 * Shared by the cutoff reminders and the new-charge alerts, so what counts as
 * a dead subscription is decided once.
 *
 * @param {object} deps
 *   send(device, payload)         { ok } or { ok: false, gone, error }
 *   removeSubscription(endpoint)  a device that no longer exists
 * @param {Array<{endpoint: string}>} devices
 * @param {object} payload
 * @returns {Promise<{ delivered: number, gone: string[], errors: string[] }>}
 */
export async function sendToDevices(deps, devices, payload) {
  const out = { delivered: 0, gone: [], errors: [] };
  for (const device of devices) {
    const r = await deps.send(device, payload);
    if (r.ok) {
      out.delivered += 1;
    } else if (r.gone) {
      // 404 or 410: the browser unsubscribed, or the app was uninstalled.
      // Keeping the row would fail again on every send.
      await deps.removeSubscription(device.endpoint);
      out.gone.push(device.endpoint);
    } else {
      out.errors.push(r.error);
    }
  }
  return out;
}
