import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRepo } from '../src/repo.js';
import { createMemoryRepo } from '../src/memory-repo.js';
import { init, flush, save, setState, state, getMonth } from '../src/state.js';

/** A repo that records every call and can be made to fail. */
function spyRepo(seed) {
  const inner = createMemoryRepo(seed);
  const calls = [];
  let failNext = null;
  const wrap = (name) => async (...args) => {
    calls.push([name, ...args.slice(0, 1)]);
    if (failNext === name || failNext === '*') {
      throw new Error(`simulated failure in ${name}`);
    }
    return inner[name](...args);
  };
  return {
    loadAll: inner.loadAll,
    saveBudget: wrap('saveBudget'),
    deleteBudget: wrap('deleteBudget'),
    saveGoals: wrap('saveGoals'),
    saveSettings: wrap('saveSettings'),
    _dump: inner._dump,
    calls,
    reset: () => { calls.length = 0; },
    fail: (name) => { failNext = name; },
    recover: () => { failNext = null; },
  };
}

const SEED = {
  months: {
    '2026-09': { ...blank(), income: 1850000 },
    '2026-08': { ...blank(), income: 1800000 },
  },
  goals: [{ id: 'g1', name: 'Emergency fund', target: 3000000, saved: 850000 }],
  settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: 'Sebas' },
};

function blank() {
  return {
    income: 0, extraIncome: [], bills: [], recurring: [], oneTime: [],
    contributions: {}, invest: 0, usedCarryover: 0,
  };
}

let repo;
beforeEach(async () => {
  repo = spyRepo(SEED);
  setRepo(repo);
  await init();
  repo.reset();
});

test('a freshly loaded state writes nothing', async () => {
  await flush();
  assert.deepEqual(repo.calls, [], 'load must not mark anything dirty');
});

test('only the month that changed is written', async () => {
  getMonth('2026-09').income = 1900000;
  await flush();
  assert.deepEqual(repo.calls, [['saveBudget', '2026-09']]);
});

test('touching two months writes both, untouched ones stay put', async () => {
  getMonth('2026-09').invest = 250000;
  getMonth('2026-07').income = 1700000; // new month
  await flush();
  const written = repo.calls.filter(c => c[0] === 'saveBudget').map(c => c[1]).sort();
  assert.deepEqual(written, ['2026-07', '2026-09']);
});

test('goals and settings are written independently of months', async () => {
  state.goals.push({ id: 'g2', name: 'Trip', target: 800000, saved: 0 });
  await flush();
  assert.deepEqual(repo.calls.map(c => c[0]), ['saveGoals']);

  repo.reset();
  state.settings.alloc.savings = 25;
  await flush();
  assert.deepEqual(repo.calls.map(c => c[0]), ['saveSettings']);
});

test('a month removed from state is deleted server-side', async () => {
  delete state.months['2026-08'];
  await flush();
  assert.deepEqual(repo.calls, [['deleteBudget', '2026-08']]);
  assert.ok(!('2026-08' in repo._dump().months), 'row must be gone, or it returns on reload');
});

test('reset erases every month on the server, not just locally', async () => {
  setState({ months: {}, goals: [], settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: '' } });
  await flush();
  const deleted = repo.calls.filter(c => c[0] === 'deleteBudget').map(c => c[1]).sort();
  assert.deepEqual(deleted, ['2026-08', '2026-09']);
  assert.deepEqual(repo._dump().months, {});
});

test('a failed write stays dirty and is retried, not silently dropped', async () => {
  getMonth('2026-09').income = 1950000;
  repo.fail('saveBudget');
  await flush();
  assert.equal(repo._dump().months['2026-09'].income, 1850000, 'server unchanged');

  repo.recover();
  repo.reset();
  await flush();
  assert.deepEqual(repo.calls, [['saveBudget', '2026-09']], 'the change is retried');
  assert.equal(repo._dump().months['2026-09'].income, 1950000);
});

test('a failure partway through leaves later work pending', async () => {
  getMonth('2026-09').income = 1975000;
  state.settings.name = 'Sebastian';
  repo.fail('saveBudget');
  await flush();

  repo.recover();
  repo.reset();
  await flush();
  const kinds = repo.calls.map(c => c[0]).sort();
  assert.deepEqual(kinds, ['saveBudget', 'saveSettings'],
    'both the failed write and the one behind it must still happen');
});

test('a second flush with no changes is a no-op', async () => {
  getMonth('2026-09').income = 2000000;
  await flush();
  repo.reset();
  await flush();
  assert.deepEqual(repo.calls, []);
});

test('save() does not write synchronously', async () => {
  getMonth('2026-09').income = 2100000;
  save();
  assert.deepEqual(repo.calls, [], 'typing must not block on a round trip');
  await flush();
  assert.equal(repo.calls.length, 1);
});
