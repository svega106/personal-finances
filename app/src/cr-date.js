/**
 * What day it is, in Costa Rica.
 *
 * Its own module with no imports, because everything needs it and nothing
 * should have to reach through a view to get it.
 *
 * Postgres returns `timestamptz` normalized to UTC, so the obvious thing —
 * slicing the first ten characters off the string — gives the UTC date.
 * Costa Rica is six hours behind, with no daylight saving, so every charge
 * after 6pm local is already tomorrow there. That has now been wrong in three
 * separate places:
 *
 *   - grouping the transactions list, which filed an 8pm charge under the
 *     next day and sorted it below a midday one;
 *   - dating a manually added expense, which on the last evening of a month
 *     put it in the next month, where it saved and could not be seen;
 *   - the edit sheet's date field, which showed a 9pm charge as tomorrow —
 *     and, because saving writes that field back, moved the charge there for
 *     good and threw away the time it happened.
 *
 * `app/test/cr-date.test.js` fails if a raw slice appears in the source
 * again. Three times is enough.
 */

/** No daylight saving here, so the offset is a constant. */
export const CR_OFFSET = '-06:00';
const ZONE = 'America/Costa_Rica';

/** The Costa Rica calendar day of an instant, as YYYY-MM-DD. */
export function crDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE });
}

/** The Costa Rica calendar month of an instant, as YYYY-MM. */
export function crMonth(iso) {
  return crDay(iso).slice(0, 7);
}

/**
 * A day key read back as a label.
 *
 * Built from local noon, so the label cannot be dragged into the neighbouring
 * day by an offset the way a bare `new Date('2026-09-21')` — which is UTC
 * midnight — would be.
 */
export function crDayLabel(key) {
  return new Date(`${key}T12:00:00${CR_OFFSET}`).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: ZONE,
  });
}

/** The wall-clock time an instant happened at, in Costa Rica. */
export function crTimeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: ZONE,
  });
}

/** The hour of the day in Costa Rica, 0–23 — for saying good morning. */
export function crHour(when = new Date()) {
  return Number(new Date(when).toLocaleString('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: ZONE,
  }));
}

/** A day written out in full: "Friday, September 25". */
export function crLongDate(when = new Date()) {
  return new Date(when).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: ZONE,
  });
}

/**
 * A day key as a short date — "Sep 25" — with the year only when it is not
 * this one. Built from local noon, like `crDayLabel`.
 */
export function crShortDate(key, now = new Date()) {
  const sameYear = key.split('-')[0] === crDay(now).split('-')[0];
  return new Date(`${key}T12:00:00${CR_OFFSET}`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: ZONE,
  });
}

/**
 * A date the user picked, as an instant.
 *
 * Noon rather than midnight: a date with no time is only ever a day, and noon
 * is the hour that survives being read back in any nearby zone. Only a
 * fallback now — the sheets ask for the time as well (`crAt`).
 */
export function crNoon(day) {
  return `${day}T12:00:00${CR_OFFSET}`;
}

/** An instant's wall-clock fields in Costa Rica, zero-padded, 24-hour. */
function fields(when) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(when)).map((p) => [p.type, p.value]));
}

/** The time of day an instant happened at in Costa Rica, as a time field holds it: "21:29". */
export function crClock(iso) {
  const f = fields(iso);
  return `${f.hour}:${f.minute}`;
}

/**
 * An instant written in Costa Rica time, to the second — the moment something
 * is entered, kept as it was rather than rounded to the day.
 */
export function crStamp(when = new Date()) {
  const f = fields(when);
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}${CR_OFFSET}`;
}

/** A picked day and time of day ("21:29"), as an instant. Noon when the time is unusable. */
export function crAt(day, clock) {
  return /^\d{2}:\d{2}$/.test(clock ?? '') ? `${day}T${clock}:00${CR_OFFSET}` : crNoon(day);
}

/**
 * The instant a sheet should store, given the one it opened with.
 *
 * Left alone, the original is kept exactly: a bank email's minute and second,
 * or the moment a new entry was started. Change the day or the time and it is
 * rebuilt from what was picked. With no time given at all, the day moves and
 * the time of day stays.
 */
export function pickedInstant(original, day, clock) {
  const time = clock ?? crClock(original);
  if (crDay(original) === day && crClock(original) === time) return original;
  return crAt(day, time);
}

/** The day after a day key. */
export function crDayAfter(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** The first instant of a Costa Rica day. */
export function crDayStart(day) {
  return `${day}T00:00:00${CR_OFFSET}`;
}

/**
 * The day a recorded balance is really as of. It cannot be a day that had not
 * happened when it was entered: dated ahead, it is as of the day it was
 * entered (0015).
 */
export function snapshotDay({ asOf, recordedAt }) {
  if (!recordedAt) return asOf;
  const entered = crDay(recordedAt);
  return asOf > entered ? entered : asOf;
}

/**
 * The instant a recorded balance stands for: the moment it was entered, when
 * it is as of the day it was entered — "what the account holds right now" —
 * or the end of its day when it was backdated. Anything after this counts on
 * top of it; anything before is already in it. Mirrors
 * `account_balances.snapshot_cut` (0013, 0015).
 */
export function snapshotCut(snap) {
  const day = snapshotDay(snap);
  if (snap.recordedAt && crDay(snap.recordedAt) === day) return snap.recordedAt;
  return crDayStart(crDayAfter(day));
}
