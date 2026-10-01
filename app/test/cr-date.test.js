/**
 * Costa Rica dates, and a guard against the way they keep going wrong.
 *
 * Postgres returns `timestamptz` in UTC and Costa Rica is six hours behind
 * it, so slicing the first ten characters off a timestamp gives tomorrow's
 * date for anything after 6pm. That has been wrong three times: grouping the
 * list, dating a new expense, and the edit sheet's date field — where it was
 * worst, because saving wrote the wrong date back and replaced the charge's
 * real time with noon.
 *
 * The last test here reads the source. It is the only thing that stops a
 * fourth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  crDay, crMonth, crDayLabel, crTimeLabel, crNoon, CR_OFFSET,
  crClock, crStamp, crAt, pickedInstant, crDayAfter, snapshotCut, snapshotDay,
} from '../src/cr-date.js';

/* ------------------------------------------------------------ the helpers */

test('an evening charge belongs to the day it was made', () => {
  // The BAC Spotify charge: 21:29 on 24 September in Costa Rica, which
  // Postgres hands back as the 25th.
  assert.equal(crDay('2026-09-25T03:29:00+00:00'), '2026-09-24');
});

test('the same instant written in local time agrees', () => {
  assert.equal(crDay('2026-09-24T21:29:00-06:00'), '2026-09-24');
});

test('a late charge on the last of the month stays in that month', () => {
  assert.equal(crMonth('2026-10-01T03:29:00+00:00'), '2026-09');
});

test('a midday charge is unaffected', () => {
  assert.equal(crDay('2026-09-24T18:00:00+00:00'), '2026-09-24');
  assert.equal(crMonth('2026-09-24T18:00:00+00:00'), '2026-09');
});

test('the time shown is the time it happened in Costa Rica', () => {
  assert.equal(crTimeLabel('2026-09-25T03:29:00+00:00'), '09:29 PM');
});

test('a day label is not dragged into its neighbour', () => {
  // 21 September 2026 was a Monday.
  assert.equal(crDayLabel('2026-09-21'), 'Mon, Sep 21');
});

test('a picked date becomes noon, and reads back as that date', () => {
  assert.equal(crNoon('2026-09-30'), `2026-09-30T12:00:00${CR_OFFSET}`);
  assert.equal(crDay(crNoon('2026-09-30')), '2026-09-30');
});

test('a date survives the round trip the edit sheet makes', () => {
  // Open a 9pm charge, change nothing, save. It must not move.
  const stored = '2026-09-25T03:29:00+00:00';
  const shownInTheField = crDay(stored);
  const writtenBack = crNoon(shownInTheField);
  assert.equal(crDay(writtenBack), crDay(stored));
});

/* ------------------------------------------------------- times of day */

test('the time a field shows is the Costa Rica clock, 24-hour', () => {
  assert.equal(crClock('2026-09-25T03:29:00+00:00'), '21:29');
  assert.equal(crClock('2026-09-25T06:05:00+00:00'), '00:05', 'midnight is 00, not 24');
});

test('a new entry is stamped with the moment it is made, to the second', () => {
  const at = new Date('2026-09-30T21:07:42Z'); // 3:07:42 pm in Costa Rica
  assert.equal(crStamp(at), `2026-09-30T15:07:42${CR_OFFSET}`);
  assert.equal(Date.parse(crStamp(at)), at.getTime());
});

test('a picked day and time becomes that instant', () => {
  assert.equal(crAt('2026-09-30', '15:05'), `2026-09-30T15:05:00${CR_OFFSET}`);
  assert.equal(crAt('2026-09-30', ''), crNoon('2026-09-30'), 'no usable time: noon, as before');
});

test('a sheet left alone keeps the exact instant it opened with', () => {
  const email = '2026-09-25T03:29:17+00:00'; // 9:29:17 pm, with seconds
  assert.equal(pickedInstant(email, '2026-09-24', '21:29'), email);
  const started = crStamp(new Date('2026-09-30T21:07:42Z'));
  assert.equal(pickedInstant(started, '2026-09-30', '15:07'), started);
});

test('changing the day or the time rebuilds it from what was picked', () => {
  const email = '2026-09-25T03:29:17+00:00';
  assert.equal(pickedInstant(email, '2026-09-24', '08:15'), `2026-09-24T08:15:00${CR_OFFSET}`);
  assert.equal(pickedInstant(email, '2026-09-23', '21:29'), `2026-09-23T21:29:00${CR_OFFSET}`);
  // No time field: the day moves, the time of day stays — never noon.
  assert.equal(pickedInstant(email, '2026-09-23'), `2026-09-23T21:29:00${CR_OFFSET}`);
});

test('the day after rolls over months and years', () => {
  assert.equal(crDayAfter('2026-09-30'), '2026-10-01');
  assert.equal(crDayAfter('2026-12-31'), '2027-01-01');
  assert.equal(crDayAfter('2028-02-28'), '2028-02-29');
});

test('a balance entered today stands for that moment; a backdated one for the end of its day', () => {
  const typed = '2026-09-30T15:05:00-06:00';
  assert.equal(snapshotCut({ asOf: '2026-09-30', recordedAt: typed }), typed);
  assert.equal(snapshotCut({ asOf: '2026-09-28', recordedAt: typed }), `2026-09-29T00:00:00${CR_OFFSET}`);
  assert.equal(snapshotCut({ asOf: '2026-09-28' }), `2026-09-29T00:00:00${CR_OFFSET}`, 'no record of when: end of day');
});

test('a balance dated ahead is as of the day it was entered, and that moment', () => {
  const typed = '2026-09-30T22:36:00-06:00';
  assert.equal(snapshotDay({ asOf: '2026-10-01', recordedAt: typed }), '2026-09-30');
  assert.equal(snapshotCut({ asOf: '2026-10-01', recordedAt: typed }), typed);
  assert.equal(snapshotDay({ asOf: '2026-09-28', recordedAt: typed }), '2026-09-28', 'backdated stays backdated');
});

/* ------------------------------------------------ and the guard on the source */

test('no module takes a date by slicing a timestamp', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const offenders = [];

  for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
    if (file === 'cr-date.js') continue; // where the zone is allowed to be known
    const text = readFileSync(join(src, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
      // `.slice(0, 10)` / `.slice(0, 7)` on anything, and toISOString() at all:
      // both read the UTC calendar, which is never the one we mean.
      if (/\.slice\(\s*0\s*,\s*(7|10|16)\s*\)/.test(line) || /toISOString\(\)/.test(line)) {
        offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    `Use crDay() / crMonth() from cr-date.js.\n  ${offenders.join('\n  ')}`);
});

test('no module writes the Costa Rica offset by hand', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const offenders = [];

  for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
    if (file === 'cr-date.js') continue;
    const text = readFileSync(join(src, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
      if (/['"`][^'"`]*-06:00/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(offenders, [], `Use CR_OFFSET or crNoon().\n  ${offenders.join('\n  ')}`);
});
