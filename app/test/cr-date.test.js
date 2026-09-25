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
import { crDay, crMonth, crDayLabel, crTimeLabel, crNoon, CR_OFFSET } from '../src/cr-date.js';

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
