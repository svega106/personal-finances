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
 * is the hour that survives being read back in any nearby zone.
 */
export function crNoon(day) {
  return `${day}T12:00:00${CR_OFFSET}`;
}
