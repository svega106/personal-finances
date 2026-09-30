/**
 * The daily reminder run: find the cutoffs that are close, and tell each
 * person's devices once per billing cycle.
 *
 * Everything that decides anything is here, with the database and the push
 * service passed in, so it is covered by the node tests; the edge function is
 * only the wiring. When email is added it becomes another delivery in the
 * loop below — `dueReminders` already answers "who, and when" for any channel.
 *
 * @param {object} deps
 *   listCards()                credit-card account rows for everyone, app shape plus `userId`
 *   listSent(today)            reminders already recorded for cutoffs on or after today,
 *                              as { userId, cardKey, cutoffDate }
 *   listSubscriptions(userId, kind)  that person's devices with `kind` switched on
 *                              ('cutoffs' here): { endpoint, p256dh, auth }
 *   claim(entry)               record the reminder; false if it was already recorded
 *   release(entry)             take the record back when nothing could be delivered
 *   send(subscription, payload)  { ok } or { ok: false, gone, error }
 *   removeSubscription(endpoint) a device that no longer exists
 * @param {string} today  'YYYY-MM-DD', Costa Rica
 */
import { dueReminders, sentKey, reminderText } from './cutoff.js';
import { sendToDevices } from './push-delivery.js';

export async function runReminders(deps, today) {
  const accounts = await deps.listCards();
  const already = new Set((await deps.listSent(today)).map(sentKey));
  const due = dueReminders(accounts, today, already);

  const report = { today, due: due.length, sent: [], noDevice: [], failed: [], removedDevices: 0 };

  for (const entry of due) {
    const devices = await deps.listSubscriptions(entry.userId, 'cutoffs');

    // Not recorded: a reminder nobody could receive is still owed, and goes
    // out on the first run after a device is subscribed — if the cutoff has
    // not passed by then.
    if (!devices.length) {
      report.noDevice.push(entry.name);
      continue;
    }

    // Recorded before sending, not after. Two runs overlapping (a manual one
    // and the trigger) must not both send; the unique key lets one win.
    if (!(await deps.claim(entry))) continue;

    const payload = {
      kind: 'cutoff',
      ...reminderText(entry),
      // The same tag on every device, so a phone that is also sent it twice
      // shows one notification, replaced rather than stacked.
      tag: `cutoff:${entry.cardKey}:${entry.cutoffDate}`,
      url: '/?view=accounts',
    };

    const r = await sendToDevices(deps, devices, payload);
    report.removedDevices += r.gone.length;
    for (const error of r.errors) report.failed.push({ card: entry.name, error });

    if (r.delivered) {
      report.sent.push(entry.name);
    } else {
      // Nothing arrived anywhere. Taking the record back means the next run
      // tries again, instead of the cycle's reminder being lost to one outage.
      await deps.release(entry);
    }
  }

  return report;
}
