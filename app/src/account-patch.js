/**
 * What an account save writes back.
 *
 * Its own module, with no imports, so it can be tested without a browser —
 * and because the bug it exists to prevent was a decision made in the middle
 * of a DOM event handler, where nothing could see it.
 */

/**
 * What to save, given what the form actually offered.
 *
 * The form
 * rendered the card fields for savings and cash accounts but not for cards —
 * the number being the card's own identity rather than something attached to
 * it. The handler read those inputs anyway, got '' back because they were not
 * on the page, and wrote issuer and last4 as null. Every card that was renamed
 * lost the number the email sync matches on, so nothing could be attached to
 * any account until a migration put them back.
 *
 * So `fields` carries only what the form rendered, and an absent key means
 * "unchanged", never "cleared". Returns `{row}` to save or `{error}` to show.
 */
export function accountPatch(existing, fields) {
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  const label = String(fields.label ?? '').trim();
  if (!label) return { error: 'Give the account a name' };

  const issuer = has('issuer') ? (fields.issuer || '') : (existing?.issuer || '');
  const last4 = has('last4')
    ? String(fields.last4 ?? '').replace(/\D/g, '')
    : (existing?.last4 || '');

  if (issuer && last4.length !== 4) return { error: 'A card needs its last 4 digits' };
  if (last4 && !issuer) return { error: 'Choose which bank the card is from' };

  // A card's type never changes: a card cannot become savings, and an
  // account with a history of its own cannot become a card.
  const type = existing?.type === 'card' ? 'card' : (fields.type || existing?.type || 'savings');
  if (existing && existing.type !== 'card' && type === 'card') {
    return { error: 'An existing account cannot become a card — add the card instead' };
  }
  // And a card is identified by its number. Without one, no charge can ever
  // reach it — it is not a field to be left blank.
  if (type === 'card' && !(issuer && last4)) {
    return { error: 'A card account needs its bank and last 4 digits' };
  }

  // A billing cutoff: the day of the month the statement closes, and how many
  // days before it to be reminded. Same rule as above — absent is unchanged.
  let cutoffDay = existing?.cutoffDay ?? null;
  let cutoffWarnDays = existing?.cutoffWarnDays ?? 3;
  if (has('cutoffDay')) {
    const raw = String(fields.cutoffDay ?? '').trim();
    cutoffDay = raw === '' ? null : Number(raw);
    if (cutoffDay !== null && !(Number.isInteger(cutoffDay) && cutoffDay >= 1 && cutoffDay <= 31)) {
      return { error: 'The cutoff is a day of the month, 1 to 31' };
    }
  }
  if (has('cutoffWarnDays')) {
    const raw = String(fields.cutoffWarnDays ?? '').trim();
    cutoffWarnDays = raw === '' ? 3 : Number(raw);
    if (!(Number.isInteger(cutoffWarnDays) && cutoffWarnDays >= 0 && cutoffWarnDays <= 31)) {
      return { error: 'Remind between 0 and 31 days before the cutoff' };
    }
  }
  // Only a credit card has a bill. A savings account — even the one with a
  // debit card on it — never has a cutoff; the database refuses one too.
  if (type !== 'card') cutoffDay = null;

  return {
    row: {
      id: existing?.id,
      label,
      type,
      // Fixed once the account exists; its balance and charges are already
      // denominated.
      currency: existing ? existing.currency : (fields.currency || 'CRC'),
      institution: String(fields.institution ?? '').trim() || null,
      // Who pays a card is chosen when it is added: the company's card is
      // kept out of personal spending and net position from then on.
      scope: existing?.scope || (fields.scope === 'work' ? 'work' : 'personal'),
      issuer: issuer || null,
      brand: issuer ? ((has('brand') ? fields.brand : existing?.brand) || null) : null,
      last4: last4 || null,
      cutoffDay,
      cutoffWarnDays,
      // Carried through, or saving an account moved it to the end of every
      // list: the repository writes a default when this is missing.
      sortOrder: existing?.sortOrder,
    },
  };
}
