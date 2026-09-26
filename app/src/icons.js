/**
 * Icons, as inline SVG strings — and the small pictures that stand for an
 * account, a merchant or a goal.
 *
 * Inline rather than an icon font or a sprite file: every view is a template
 * string, so an icon is just another string in it, it takes `currentColor`
 * from whatever it sits in, and there is nothing extra for the service worker
 * to cache or for the offline shell to miss.
 *
 * No imports and no DOM, so the views that use it stay importable by the unit
 * tests. Everything is drawn on a 24px grid with round caps, so the set reads
 * as one family.
 */

const P = {
  // navigation
  home: '<path d="M4 10.2 12 4l8 6.2V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9v5.5H5.5A1.5 1.5 0 0 1 4 19z"/>',
  budget: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  activity: '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M8 17v-4"/><path d="M13 17V8"/><path d="M18 17v-7"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',

  // actions
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M18.5 6l-.9 13.1A2 2 0 0 1 15.6 21H8.4a2 2 0 0 1-2-1.9L5.5 6"/><path d="M10 11v5M14 11v5"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  reset: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  'arrow-down-right': '<path d="M7 7l10 10"/><path d="M17 8v9H8"/>',

  // status & meaning
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  sparkles: '<path d="M11 3.5 12.6 8 17 9.6 12.6 11.2 11 15.7 9.4 11.2 5 9.6 9.4 8Z"/><path d="M18.5 14.5v5M16 17h5"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  'trending-up': '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  'trending-down': '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',

  // money
  card: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  bank: '<path d="M3 21h18"/><path d="M5 18v-7M9.5 18v-7M14.5 18v-7M19 18v-7"/><path d="M12 3 21 8H3z"/>',
  piggy: '<path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5z"/><path d="M2 9v1c0 1.1.9 2 2 2h1"/><path d="M16 11h.01"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.3 18"/>',
  receipt: '<path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  transfer: '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>',
  income: '<path d="M12 3v14"/><path d="m6 11 6 6 6-6"/><path d="M5 21h14"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',

  // merchants & goals
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  fuel: '<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
  pill: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  tv: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  laptop: '<rect x="3.5" y="4" width="17" height="11.5" rx="2"/><path d="M2 20h20"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  paw: '<circle cx="6.5" cy="10" r="1.8"/><circle cx="10" cy="5.5" r="1.8"/><circle cx="14.5" cy="5.5" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12.25 11.5c-2.5 0-5 3-5 5.5 0 1.9 1.4 3 3 3 .9 0 1.4-.4 2-.4s1.1.4 2 .4c1.6 0 3-1.1 3-3 0-2.5-2.5-5.5-5-5.5z"/>',
  flag: '<path d="M4 22V4"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
};

/**
 * An icon by name. Size is the default box; CSS may still resize it, since
 * the viewBox keeps the drawing in proportion.
 */
export function icon(name, { size = 20, cls = '', stroke = 1.8 } = {}) {
  const body = P[name] ?? P.receipt;
  return `<svg class="i${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(P, name); }

/* ------------------------------------------------------------------ banks */

/**
 * The banks the email sync knows, with a colour to recognise each by.
 *
 * Monograms, not logos: a letter on the bank's own colour is enough to find a
 * card at a glance, and it cannot go stale the way a copied logo would.
 */
const BANKS = {
  bac: { name: 'BAC Credomatic', mono: 'BAC' },
  davivienda: { name: 'Davivienda', mono: 'D' },
  promerica: { name: 'Promerica', mono: 'P' },
  bncr: { name: 'Banco Nacional', mono: 'BN' },
};

/**
 * Which bank an account belongs to. A card knows its issuer; a savings account
 * usually only has a free-text institution, so that is read as a fallback.
 */
export function bankOf(a) {
  if (!a) return null;
  if (a.issuer && BANKS[a.issuer]) return { key: a.issuer, ...BANKS[a.issuer] };
  const inst = String(a.institution || '').toLowerCase();
  if (/\bbac\b|credomatic/.test(inst)) return { key: 'bac', ...BANKS.bac };
  if (/davivienda/.test(inst)) return { key: 'davivienda', ...BANKS.davivienda };
  if (/promerica/.test(inst)) return { key: 'promerica', ...BANKS.promerica };
  if (/nacional|\bbncr\b|\bbn\b/.test(inst)) return { key: 'bncr', ...BANKS.bncr };
  return null;
}

/** The card network's mark, drawn small enough to sit on a card picture. */
export function networkMark(brand) {
  if (brand === 'visa') return '<span class="nw nw-visa">VISA</span>';
  if (brand === 'amex') return '<span class="nw nw-amex">AMEX</span>';
  if (brand === 'mastercard') {
    return '<svg class="nw nw-mc" viewBox="0 0 26 16" aria-hidden="true"><circle cx="9" cy="8" r="7" fill="#eb001b"/><circle cx="17" cy="8" r="7" fill="#f79e1b" fill-opacity=".92"/></svg>';
  }
  return '';
}

/**
 * The colour a card is drawn in. An AMEX gets its own, so two cards from one
 * bank are still told apart at a glance.
 */
export function cardArt(a) {
  if (a?.brand === 'amex') return 'art-amex';
  const bank = bankOf(a);
  return bank ? `art-${bank.key}` : 'art-none';
}

/**
 * A card, drawn as a card: the bank's colour, the network's mark, the last
 * four digits when there is room for them.
 */
export function cardThumb(a, { size = 'md' } = {}) {
  const bank = bankOf(a);
  const mark = networkMark(a?.brand) || (bank ? `<span class="nw nw-mono">${bank.mono}</span>` : '');
  const digits = size === 'lg' && a?.last4 ? `<span class="ct-num">•••• ${a.last4}</span>` : '';
  return `<span class="ct ct-${size} ${cardArt(a)}" aria-hidden="true"><span class="ct-chip"></span>${digits}${mark}</span>`;
}

/**
 * The picture beside an account, anywhere it is listed.
 *
 *   card        — a small card in the bank's colours, with its network
 *   savings     — the bank's monogram when it is known, a piggy bank if not
 *   investment  — a rising line
 *   cash        — a banknote
 */
export function accountIcon(a, { size = 'md' } = {}) {
  if (!a) return `<span class="ai ai-${size} ai-none" aria-hidden="true">${icon('wallet')}</span>`;
  if (a.type === 'card') return cardThumb(a, { size });
  // Beside a charge, an account with a debit card is shown as that card: it
  // is what was used, and a monogram has no room at this size anyway.
  if (size === 'xs' && a.last4 && a.issuer) return cardThumb(a, { size });
  if (a.type === 'cash') return `<span class="ai ai-${size} ai-cash" aria-hidden="true">${icon('cash')}</span>`;
  if (a.type === 'investment') return `<span class="ai ai-${size} ai-invest" aria-hidden="true">${icon('trending-up')}</span>`;
  const bank = bankOf(a);
  if (bank) {
    return `<span class="ai ai-${size} ai-bank bank-${bank.key}" aria-hidden="true"><b>${bank.mono}</b><span class="ai-badge">${icon('piggy', { size: 10, stroke: 2.4 })}</span></span>`;
  }
  return `<span class="ai ai-${size} ai-savings" aria-hidden="true">${icon('piggy')}</span>`;
}

/* -------------------------------------------------------------- merchants */

/**
 * A few words in a merchant's name are enough to guess what kind of place it
 * is. Only the picture depends on this — the category is still the one the
 * rules or the person chose.
 */
const MERCHANTS = [
  [/uber ?eats|pedidos ?ya|rappi|didi ?food|restaur|burger|pizza|subway|mc ?donald|\bkfc\b|taco|sushi|hikari|dupla|\bsoda\b|grill|\bwok\b|bistro|pollo/i, 'utensils'],
  [/starbucks|\bcaf[eé]|coffee|dunkin|musmanni|panavieja|panader|britt|juan valdez/i, 'coffee'],
  [/auto ?mercado|fresh ?market|pricesmart|walmart|mas ?x ?menos|maxi ?pal|\bpal[ií]\b|mega ?super|supermercado|\bferia\b|perimercado|\bsuper\b/i, 'cart'],
  [/\bdelta\b|fuel|gasolin|servicentro|\bpuma\b|total ?energ|\bshell\b|texaco/i, 'fuel'],
  [/farmacia|fischel|medismart|pharma|cl[ií]nica|hospital|laborator|dental|m[eé]dic/i, 'pill'],
  [/\buber\b|\bdidi\b|taxi|ruta ?27|global ?via|peaje|parqueo|parking|cabify|indriver/i, 'car'],
  [/spotify|apple ?music|deezer|youtube ?music|tidal/i, 'music'],
  [/netflix|disney|\bhbo\b|paramount|viacom|prime ?video|crunchyroll|twitch|\bmax\.com/i, 'tv'],
  [/padel|playtomic|canchas|\bgym\b|smart ?fit|crossfit|gimnasio|decathlon|sport/i, 'pulse'],
  [/\bice\b|telefon|k[oö]lbi|claro|movistar|liberty|\btigo\b|cabletica/i, 'phone'],
  [/\bcnfl\b|electric|\baya\b|acueducto|jasec|\besph\b/i, 'zap'],
  [/amazon|aliexpress|shein|temu|ebay|samsung|apple\.com|best ?buy|ishop|\bmonge\b|gollo|verdugo|store|tienda/i, 'bag'],
  [/facebk|facebook|meta ?ads|instagram|google ?ads|linkedin/i, 'megaphone'],
  [/microsoft|google|adobe|flutterflow|github|openai|anthropic|notion|figma|\bzeo\b|dropbox|icloud|chatgpt|1password|vercel|cloudflare/i, 'cloud'],
  [/airbnb|booking|hotel|avianca|copa ?air|airline|volaris|jetblue|expedia|sansa|aerol[ií]nea/i, 'plane'],
  [/cine|cinema|cinepolis|steam|playstation|xbox|nintendo|ticket/i, 'ticket'],
  [/veterinar|\bvet\b|\bpet/i, 'paw'],
];

/** The icon for a charge: what kind of place it was, or failing that its kind. */
export function merchantIconName(t) {
  if (t.kind === 'transfer') return 'transfer';
  if (t.kind === 'income') return 'income';
  const text = `${t.merchant || ''} ${t.merchantRaw || ''}`;
  for (const [re, name] of MERCHANTS) if (re.test(text)) return name;
  if (t.scope === 'work') return 'briefcase';
  return 'receipt';
}

/** The colour family a charge is drawn in: its category, or what sets it apart. */
export function toneOf(t) {
  if (t.kind === 'transfer') return 'transfer';
  if (t.kind === 'income') return 'income';
  if (t.scope === 'work') return 'work';
  return t.cat || 'none';
}

export function merchantIcon(t, { size = 'md' } = {}) {
  return `<span class="mi mi-${size} tone-${toneOf(t)}" aria-hidden="true">${icon(merchantIconName(t))}</span>`;
}

/* ------------------------------------------------------------------ goals */

const GOALS = [
  [/emergenc|colch[oó]n|safety|rainy|imprevist/i, 'shield'],
  [/trip|travel|viaje|vacation|vacaci|japan|jap[oó]n|europ|flight|vuelo/i, 'plane'],
  [/\b(car|carro|auto|moto|vehicle|veh[ií]culo)\b/i, 'car'],
  [/house|\bhome\b|\bcasa\b|apartment|apartamento|mortgage|hipoteca|down ?payment|\bprima\b/i, 'home'],
  [/laptop|computer|computadora|macbook|\bpc\b|phone|iphone|tech/i, 'laptop'],
  [/school|college|universi|educa|study|estudio|course|curso|master|maestr/i, 'cap'],
  [/wedding|boda|\bring\b|anillo/i, 'heart'],
  [/gift|regalo|christmas|navidad|aguinaldo|bonus/i, 'gift'],
  [/retire|retiro|pension|invest|inversi/i, 'trending-up'],
];

export function goalIconName(g) {
  for (const [re, name] of GOALS) if (re.test(g?.name || '')) return name;
  return 'flag';
}

/**
 * A tint per goal, by its place in the list. A hash of the id would survive
 * reordering, but with four tints it hands two of three goals the same one
 * more often than not; by position, neighbours never match.
 */
export function goalTint(index) {
  return ['savings', 'invest', 'wants', 'needs'][Math.max(0, index) % 4];
}
