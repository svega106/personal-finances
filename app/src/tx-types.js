/**
 * Transaction types: what a charge is for, and so whether it counts.
 *
 * Every transaction has one, stored in `transactions.scope` as a key. Two are
 * built in — Personal, which is what spending means, and Work, money spent
 * for the company and expected back — and more can be added in Settings: a
 * shared expense, a loan to someone, medical the insurer pays back.
 *
 * Each type says two things:
 *
 *   spending      it counts towards spending: the budget, the category
 *                 totals, the dashboard, the year
 *   reimbursable  its charges are money owed back to you, tracked under
 *                 "Owed to you" on Accounts until they are paid back
 *
 * The definitions live in settings, synced like the rest of them. A charge
 * carries only the key, so renaming a type renames it everywhere at once.
 *
 * Personal always counts and is never owed back: that is what it means. The
 * company's own card is not a type at all — its charges are never your money,
 * whatever they are marked (tx.js `countsAsSpending`).
 */
import { state, save } from './state.js';

export const BUILTIN = Object.freeze([
  Object.freeze({ key: 'personal', label: 'Personal', spending: true, reimbursable: false, builtin: true }),
  Object.freeze({ key: 'work', label: 'Work', spending: false, reimbursable: true, builtin: true }),
]);

/** What `transactions.scope` accepts (0014). */
export const KEY = /^[a-z][a-z0-9-]{0,39}$/;

const clean = (label, fallback) => String(label ?? '').trim().slice(0, 40) || fallback;

/**
 * The full list from what settings hold: the built-ins first and always
 * present, with any edits applied, then the added ones in the order they
 * were added. Anything malformed is dropped rather than trusted.
 */
export function resolveTypes(stored) {
  // A missing key must not pass as the word "undefined", which the pattern allows.
  const list = (Array.isArray(stored) ? stored : [])
    .filter((t) => t && typeof t === 'object' && typeof t.key === 'string' && KEY.test(t.key));
  const byKey = new Map(list.map((t) => [t.key, t]));

  const builtins = BUILTIN.map((b) => {
    const s = byKey.get(b.key) ?? {};
    const personal = b.key === 'personal';
    return {
      ...b,
      label: clean(s.label, b.label),
      spending: personal ? true : (typeof s.spending === 'boolean' ? s.spending : b.spending),
      reimbursable: personal ? false : (typeof s.reimbursable === 'boolean' ? s.reimbursable : b.reimbursable),
    };
  });

  const added = list
    .filter((t) => !BUILTIN.some((b) => b.key === t.key))
    .map((t) => ({
      key: t.key, label: clean(t.label, 'Untitled'),
      spending: !!t.spending, reimbursable: !!t.reimbursable, builtin: false,
    }));

  return [...builtins, ...added];
}

/**
 * The type a key names. An unknown one — a type removed on another device —
 * reads as Personal: counted, rather than quietly left out of every total.
 */
export function typeFor(key, types) {
  return types.find((t) => t.key === (key || 'personal')) ?? types[0];
}

/** A key for a new type, unlike any in use. */
export function newTypeKey(types, now = Date.now()) {
  let n = now;
  let key;
  do { key = `t${(n++).toString(36)}`; } while (types.some((t) => t.key === key));
  return key;
}

/* -------------------------------------------------- the user's own list */

export function txTypes() {
  return resolveTypes(state.settings?.txTypes);
}

export function typeOf(t) {
  return typeFor(t?.scope, txTypes());
}

/** Keys of the types whose charges are money owed back. */
export function owedTypeKeys() {
  return txTypes().filter((t) => t.reimbursable).map((t) => t.key);
}

function store(types) {
  state.settings.txTypes = types.map(({ key, label, spending, reimbursable }) => ({ key, label, spending, reimbursable }));
  save();
}

/** Change one type. Personal's two flags are fixed; anything else may change. */
export function updateType(key, patch) {
  const types = txTypes();
  const t = types.find((x) => x.key === key);
  if (!t) return null;
  if (patch.label !== undefined) t.label = clean(patch.label, t.label);
  if (key !== 'personal') {
    if (typeof patch.spending === 'boolean') t.spending = patch.spending;
    if (typeof patch.reimbursable === 'boolean') t.reimbursable = patch.reimbursable;
  }
  store(types);
  return t;
}

/**
 * Add a type. New ones start as not spending and not owed back — the reason
 * to add a type is usually to keep something out of spending.
 */
export function addType(label) {
  const name = String(label ?? '').trim();
  if (!name) return { error: 'Give the type a name' };
  const types = txTypes();
  if (types.some((t) => t.label.toLowerCase() === name.toLowerCase())) {
    return { error: `There is already a type called ${name}` };
  }
  const type = { key: newTypeKey(types), label: clean(name, 'Untitled'), spending: false, reimbursable: false, builtin: false };
  store([...types, type]);
  return { type };
}

/** Remove an added type. The built-ins stay. Its transactions are moved by the caller. */
export function removeType(key) {
  const types = txTypes();
  const t = types.find((x) => x.key === key);
  if (!t || t.builtin) return false;
  store(types.filter((x) => x.key !== key));
  return true;
}
