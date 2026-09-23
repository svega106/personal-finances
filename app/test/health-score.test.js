/**
 * The health score, once real spending exists.
 *
 * The rule being pinned down: actual spending can only ever make the score
 * worse than the plan implied. Half-way through a month you have always spent
 * less than you planned, so a score that read actuals directly would award
 * 100 on the 3rd and claw it back by the 30th.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthScore } from '../src/scoring.js';



/** A month living comfortably within its income. */
const sound = {
  income: 1000000, planned: 800000, remaining: 200000,
  pSavings: 20, pNeeds: 40,
};

test('with no actuals, the score is the plan', () => {
  assert.equal(healthScore(sound, 0).score, healthScore(sound).score);
});

test('spending less than planned does not inflate the score', () => {
  const early = healthScore(sound, 50000);   // 3rd of the month
  const plan = healthScore(sound, 0);
  assert.equal(early.score, plan.score, 'being early in the month is not an achievement');
});

test('spending exactly to plan does not change it either', () => {
  assert.equal(healthScore(sound, 800000).score, healthScore(sound, 0).score);
});

test('overspending past income pulls the score down', () => {
  const over = healthScore(sound, 1200000);
  assert.ok(over.score < healthScore(sound, 0).score,
    `expected a worse score, got ${over.score} vs ${healthScore(sound, 0).score}`);
});

test('overspending the plan but staying inside income is not punished', () => {
  // Still living within your means, just not where you said you would.
  assert.equal(healthScore(sound, 950000).score, healthScore(sound, 0).score);
});

test('no income is still no data', () => {
  assert.equal(healthScore({ ...sound, income: 0 }, 500000).label, 'No data');
});
