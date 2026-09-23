/**
 * Deciding what a charge is: which budget category, which name to show.
 *
 * Shared deliberately. The browser classifies a charge you edit by hand, and
 * the ingest function classifies one that arrives from a bank email — if those
 * two disagreed, the same merchant would land in different categories
 * depending on how it got in. One implementation, one answer.
 *
 * Pure: `rules` is passed in rather than read from module state, because the
 * two callers load them from different places.
 */

export function matchRule(rules, merchantRaw, mcc) {
  const hay = String(merchantRaw || '').toUpperCase();
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const r of sorted) {
    const pat = String(r.pattern || '').toUpperCase();
    if (!pat) continue;
    let hit = false;
    if (r.matchType === 'exact') hit = hay === pat;
    else if (r.matchType === 'regex') {
      try { hit = new RegExp(r.pattern, 'i').test(merchantRaw); } catch { hit = false; }
    } else hit = hay.includes(pat);

    if (hit) {
      return {
        cat: r.cat ?? null,
        budgetLineId: r.budgetLineId ?? null,
        scope: r.scope ?? null,
        merchant: r.merchantClean ?? null,
        ruleId: r.id,
      };
    }
  }

  // Promerica supplies a merchant category; use it only when no rule matched.
  const fromMcc = MCC_DEFAULTS[String(mcc || '').toUpperCase()];
  if (fromMcc) return { cat: fromMcc, budgetLineId: null, scope: null, merchant: null, ruleId: null };

  return null;
}

/** Coarse defaults. A rule always beats these. */
const MCC_DEFAULTS = {
  'GAS STATIONS': 'needs',
  'GROCERY STORES': 'needs',
  'SUPERMARKETS': 'needs',
  PHARMACIES: 'needs',
  'DRUG STORES': 'needs',
  'MEDICAL SERVICES': 'needs',
  UTILITIES: 'needs',
  'CARE AN REPAIR': 'needs',
  RESTAURANTS: 'wants',
  'FAST FOOD': 'wants',
  'EATING PLACES': 'wants',
  'BARS AND TAVERNS': 'wants',
  'RECORD STORES': 'wants',
  'SPORTING GOODS': 'wants',
};
