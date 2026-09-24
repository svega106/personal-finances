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

  // A card's type never changes: a card cannot become savings.
  const type = existing?.type === 'card' ? 'card' : (fields.type || 'savings');
  // And a card is identified by its number. Without one, no charge can ever
  // reach it — it is not a field to be left blank.
  if (type === 'card' && !(issuer && last4)) {
    return { error: 'A card account needs its bank and last 4 digits' };
  }

  return {
    row: {
      id: existing?.id,
      label,
      type,
      // Fixed once the account exists; its balance and charges are already
      // denominated.
      currency: existing ? existing.currency : (fields.currency || 'CRC'),
      institution: String(fields.institution ?? '').trim() || null,
      scope: existing?.scope || 'personal',
      issuer: issuer || null,
      brand: issuer ? (existing?.brand || null) : null,
      last4: last4 || null,
    },
  };
}
