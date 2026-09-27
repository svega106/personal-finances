/**
 * Billing cutoffs, and when to be reminded of them.
 *
 * One module, three callers: the dashboard (which cutoffs are coming, which
 * are close), the daily reminder job (which to send now), and — when email is
 * added — the email sender, which will ask this same question rather than
 * working out its own answer. Pure, no imports, dates as 'YYYY-MM-DD' keys in
 * Costa Rica time; the caller says what day it is.
 *
 * A cutoff is a day of the month, recurring. A card is two account rows (the
 * colón and the dollar halves share one bill), so everything here is per
 * physical card — issuer and last four — and never per row.
 */

const pad = (n) => String(n).padStart(2, '0');

/** Days in a month, `month` 1-based. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The cutoff in a given month. A day the month does not have means its last
 * day — "the 31st" in April is the 30th — rather than no cutoff at all.
 */
export function cutoffIn(year, month, cutoffDay) {
  const day = Math.min(cutoffDay, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The next cutoff on or after `today`. A cutoff falling today is today's. */
export function nextCutoff(cutoffDay, today) {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = cutoffIn(y, m, cutoffDay);
  if (thisMonth >= today) return thisMonth;
  return m === 12 ? cutoffIn(y + 1, 1, cutoffDay) : cutoffIn(y, m + 1, cutoffDay);
}

/** Whole days from one key to another. Computed in UTC, so no DST can shift it. */
export function daysBetween(from, to) {
  const at = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86400000);
}

/** A physical card: both currency halves share it. */
export function cardKey(a) {
  return `${a.issuer}:${a.last4}`;
}

/** What a reminder is remembered by: one per card per billing cycle. */
export function sentKey(entry) {
  return `${entry.userId ?? ''}|${entry.cardKey}|${entry.cutoffDate}`;
}

export const DEFAULT_WARN_DAYS = 3;

/** "BAC VISA ₡" and "BAC VISA $" are one card. */
function cardName(label) {
  return String(label || '').replace(/[₡$]/g, '').replace(/\((work|trabajo)\)/i, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Every credit card with a cutoff set, soonest first.
 *
 * `accounts` in the app's shape: { id, userId?, label, type, issuer, last4,
 * currency, active?, cutoffDay, cutoffWarnDays }. `userId` is only needed
 * when more than one person's cards are in the list, as they are for the
 * reminder job.
 *
 * Returns { userId, cardKey, name, accountIds, cutoffDay, warnDays,
 * cutoffDate, daysLeft, warning } — `warning` when the cutoff is within the
 * card's own number of days.
 */
export function upcomingCutoffs(accounts, today) {
  const cards = new Map();

  for (const a of accounts ?? []) {
    // A debit card lives on a savings row, so `type` alone keeps it out: it
    // has no bill, and so no cutoff.
    if (a.type !== 'card' || !a.cutoffDay || a.active === false) continue;
    if (!a.issuer || !a.last4) continue;

    const key = `${a.userId ?? ''}|${cardKey(a)}`;
    const seen = cards.get(key);
    if (seen) {
      seen.accountIds.push(a.id);
      // The two halves are written together and should agree. If they ever
      // do not, the colón half speaks for the card, so the answer is stable.
      if (a.currency === 'CRC' && seen.currency !== 'CRC') Object.assign(seen, pick(a));
      continue;
    }
    cards.set(key, { ...pick(a), accountIds: [a.id] });
  }

  return [...cards.values()]
    .map((c) => {
      const cutoffDate = nextCutoff(c.cutoffDay, today);
      const daysLeft = daysBetween(today, cutoffDate);
      return {
        userId: c.userId,
        cardKey: c.cardKey,
        name: c.name,
        accountIds: c.accountIds,
        cutoffDay: c.cutoffDay,
        warnDays: c.warnDays,
        cutoffDate,
        daysLeft,
        warning: daysLeft <= c.warnDays,
      };
    })
    .sort((x, y) => x.daysLeft - y.daysLeft || x.name.localeCompare(y.name));
}

function pick(a) {
  const warn = Number(a.cutoffWarnDays);
  return {
    userId: a.userId,
    cardKey: cardKey(a),
    currency: a.currency,
    name: cardName(a.label),
    cutoffDay: Number(a.cutoffDay),
    warnDays: Number.isFinite(warn) && a.cutoffWarnDays !== null && a.cutoffWarnDays !== undefined
      ? warn : DEFAULT_WARN_DAYS,
  };
}

/**
 * The reminders to send now: cards inside their warning window that have not
 * been reminded about this cutoff yet.
 *
 * "Inside the window", not "exactly N days before": a daily job that misses a
 * day still sends the next time it runs, and `alreadySent` (a Set of
 * `sentKey`s) is what keeps it to one reminder per card per cycle.
 */
export function dueReminders(accounts, today, alreadySent = new Set()) {
  return upcomingCutoffs(accounts, today)
    .filter((c) => c.warning && !alreadySent.has(sentKey(c)));
}

/** The words of a reminder, shared by every channel that sends one. */
export function reminderText(entry) {
  const when = entry.daysLeft === 0 ? 'today'
    : entry.daysLeft === 1 ? 'tomorrow'
      : `in ${entry.daysLeft} days`;
  return {
    title: `${entry.name} closes ${when}`,
    body: `Billing cutoff on the ${ordinal(Number(entry.cutoffDate.split('-')[2]))}. `
      + 'Anything charged after it goes on next month’s statement.',
  };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
