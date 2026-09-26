/**
 * Sample data for working on the screens: `npm run dev`, then open `/?demo`.
 *
 * Only the dev server ever loads this — main.js imports it behind
 * `import.meta.env.DEV`, so a production build does not contain it — and it
 * installs the in-memory repository, so nothing done here can reach the real
 * database. Dates are generated relative to today, so the month on screen
 * always has something in it.
 */
import { createMemoryRepo } from './memory-repo.js';
import { crDay, crMonth, CR_OFFSET } from './cr-date.js';
import { shiftMonth } from './state.js';

const card = (id, label, issuer, brand, last4, currency, extra = {}) => ({
  id, label, type: 'card', issuer, brand, last4, currency, scope: 'personal',
  institution: { bac: 'BAC Credomatic', davivienda: 'Davivienda', promerica: 'Banco Promerica', bncr: 'Banco Nacional' }[issuer],
  ...extra,
});

const ACCOUNTS = [
  card('c-visa', 'BAC VISA ₡', 'bac', 'visa', '4477', 'CRC'),
  card('c-visa-usd', 'BAC VISA $', 'bac', 'visa', '4477', 'USD'),
  card('c-amex', 'BAC AMEX ₡', 'bac', 'amex', '9654', 'CRC'),
  card('c-amex-usd', 'BAC AMEX $', 'bac', 'amex', '9654', 'USD'),
  card('c-davi', 'Davivienda ₡', 'davivienda', 'visa', '5131', 'CRC'),
  card('c-davi-usd', 'Davivienda $', 'davivienda', 'visa', '5131', 'USD'),
  card('c-prom', 'Promerica ₡', 'promerica', null, '1763', 'CRC'),
  card('c-prom-usd', 'Promerica $', 'promerica', null, '1763', 'USD'),
  card('c-bncr', 'BNCR VISA ₡ (work)', 'bncr', 'visa', '0828', 'CRC', { scope: 'work' }),
  card('c-bncr-usd', 'BNCR VISA $ (work)', 'bncr', 'visa', '0828', 'USD', { scope: 'work' }),
  { id: 's-ahorros', label: 'Ahorros ₡', type: 'savings', issuer: 'bac', brand: 'mastercard',
    last4: '2207', currency: 'CRC', scope: 'personal', institution: 'BAC Credomatic' },
  { id: 's-ahorros-usd', label: 'Ahorros USD', type: 'savings', issuer: null, brand: null,
    last4: null, currency: 'USD', scope: 'personal', institution: 'Davivienda' },
  { id: 'i-fondo', label: 'Fondo de inversión', type: 'investment', issuer: null, brand: null,
    last4: null, currency: 'CRC', scope: 'personal', institution: 'BN Fondos' },
  { id: 'a-cash', label: 'Efectivo', type: 'cash', issuer: null, brand: null,
    last4: null, currency: 'CRC', scope: 'personal', institution: null },
];

const GOALS = [
  { id: 'g-emerg', name: 'Emergency fund', target: 3000000, saved: 1450000, monthly: 120000, deadline: '' },
  { id: 'g-japan', name: 'Trip to Japan', target: 2500000, saved: 620000, monthly: 80000, deadline: 'Apr 2027' },
  { id: 'g-laptop', name: 'New laptop', target: 900000, saved: 310000, monthly: 50000, deadline: 'Dec 2026' },
];

/** One month's plan. Line ids carry the month, as `copyMonth()` makes them. */
function plan(month, { extra = 150000, oneTime = true, invest = 150000 } = {}) {
  const id = (base) => `${base}-${month}`;
  return {
    income: 1850000,
    extraIncome: extra ? [{ id: id('x-consult'), name: 'Consulting', amount: extra }] : [],
    bills: [
      { id: id('b-rent'), name: 'Rent', amount: 450000 },
      { id: id('b-power'), name: 'Electricity & water', amount: 38000 },
      { id: id('b-phone'), name: 'Phone & internet', amount: 42000 },
      { id: id('b-insurance'), name: 'Health insurance', amount: 55000 },
    ],
    recurring: [
      { id: id('r-groc'), name: 'Groceries', amount: 260000, cat: 'needs' },
      { id: id('r-gas'), name: 'Fuel & tolls', amount: 90000, cat: 'needs' },
      { id: id('r-eat'), name: 'Eating out', amount: 110000, cat: 'wants' },
      { id: id('r-subs'), name: 'Subscriptions', amount: 25000, cat: 'wants' },
      { id: id('r-padel'), name: 'Padel', amount: 45000, cat: 'wants' },
    ],
    oneTime: oneTime ? [{ id: id('o-racket'), name: 'Padel racket', amount: 95000, cat: 'wants' }] : [],
    contributions: { 'g-emerg': 120000, 'g-japan': 80000, 'g-laptop': 50000 },
    invest,
    usedCarryover: 0,
  };
}

/**
 * [day, time, merchant, raw, amount, account, cat, line, extra]
 * `line` is the plan line's base id; it is suffixed with the month below.
 */
const THIS_MONTH = [
  [1, '09:10', 'Auto Mercado', 'AUTO MERCADO HEREDIA', 48350, 'c-visa', 'needs', 'r-groc'],
  [1, '13:40', 'Starbucks', 'STARBUCKS OXIGENO', 4950, 'c-amex', 'wants', 'r-eat'],
  [2, '07:55', 'Delta', 'DELTA PIRRO', 28000, 'c-davi', 'needs', 'r-gas'],
  [3, '12:30', 'Uber Eats', 'UBER EATS COSTA RICA', 12450, 'c-amex', 'wants', 'r-eat'],
  [3, '21:29', 'Spotify', 'SPOTIFY', 5900, 'c-amex', 'wants', 'r-subs'],
  [4, '18:20', 'Fischel', 'FARMACIA FISCHEL HEREDIA', 15780, 'c-visa', 'needs', null],
  [5, '10:00', 'ICE', 'Telefonia ICE', 22500, 'c-visa', 'needs', 'b-phone'],
  [6, '11:15', 'PriceSmart', 'PRICESMART HEREDIA', 96420, 'c-visa', 'needs', 'r-groc'],
  [7, '19:45', 'Art Padel', 'ART PADEL', 18000, 'c-prom', 'wants', 'r-padel'],
  [8, '08:30', 'Ruta 27', 'GLOBAL VIA RUTA 27', 2100, 'c-davi', 'needs', 'r-gas'],
  [9, '13:05', 'FlutterFlow', 'FLUTTERFLOW', 30, 'c-amex-usd', null, null, { scope: 'work', reimbursement: { status: 'pending' } }],
  [10, '21:10', 'Paramount+', 'VIACOMCBS STREAMING', 7.99, 'c-amex-usd', 'wants', 'r-subs'],
  [11, '12:00', 'Amazon', 'AMAZON MKTPLACE PMTS', 64.9, 'c-visa-usd', 'wants', null],
  [12, '09:40', 'Auto Mercado', 'AUTO MERCADO HEREDIA', 37900, 'c-visa', 'needs', 'r-groc'],
  [13, '20:30', 'PedidosYa', 'PedidosYa*Pizza Hub', 9850, 'c-amex', 'wants', 'r-eat'],
  [14, '16:00', null, 'KIOSKO SAMSUNG SLC MAL', 89000, 'c-visa', null, null, { reviewed: false }],
  [15, '06:30', 'Facebook Ads', 'FACEBK SWRK766KH4', 79.96, 'c-bncr-usd', null, null, { scope: 'work' }],
  [15, '10:10', 'Uber', 'UBER BV', 3450, 'c-amex', 'wants', null],
  [16, '19:00', 'Hikari', 'RESTAURANTE HIKARI', 32400, 'c-prom', 'wants', 'r-eat'],
  [17, '07:50', 'Cyber Fuel', 'CYBER FUEL SANTA ANA', 30000, 'c-davi', 'needs', 'r-gas'],
  [18, '12:15', 'Subway', 'SUBWAY LINDORA', 5600, 's-ahorros', 'wants', 'r-eat'],
  [19, '17:20', 'Fresh Market', 'FRESH MARKET ESCAZU', 21300, 'c-visa', 'needs', 'r-groc'],
  [20, '13:59', 'Microsoft', 'MICROSOFT*365', 9.99, 'c-amex-usd', 'wants', 'r-subs'],
  [21, '18:45', 'Uber Eats', 'UBER EATS COSTA RICA', 12450, 'c-amex', 'wants', 'r-eat'],
  [21, '20:38', 'Auto Mercado', 'AUTO MERCADO HEREDIA', 6980, 'c-visa', 'needs', 'r-groc'],
  [22, '09:00', null, 'MEDISMART SAN RAFAEL', 25000, 'c-visa', null, null, { reviewed: false }],
  [23, '11:30', 'Playtomic', 'PLAYTOMIC', 12000, 'c-prom', 'wants', 'r-padel'],
  [24, '14:00', 'Mas Padel', 'Mas Padel Store', 95000, 'c-visa', 'wants', 'o-racket'],
  [24, '17:05', 'Dunkin', 'DUNKIN ESCAZU', 3900, 'a-cash', 'wants', null],
  [25, '08:05', null, 'MUSMANNI HEREDIA', 2850, 's-ahorros', null, null, { reviewed: false }],
];

const LAST_MONTH = [
  [1, '10:20', 'Auto Mercado', 'AUTO MERCADO HEREDIA', 52100, 'c-visa', 'needs', 'r-groc'],
  [3, '08:10', 'Delta', 'DELTA PIRRO', 31000, 'c-davi', 'needs', 'r-gas'],
  [3, '21:29', 'Spotify', 'SPOTIFY', 5900, 'c-amex', 'wants', 'r-subs'],
  [5, '10:00', 'ICE', 'Telefonia ICE', 22500, 'c-visa', 'needs', 'b-phone'],
  [6, '13:00', 'Adobe', 'Adobe *Creative Cloud', 22.99, 'c-amex-usd', null, null,
    { scope: 'work', reimbursement: { status: 'reimbursed', on: 'SETTLED' } }],
  [8, '19:30', 'Uber Eats', 'UBER EATS COSTA RICA', 14200, 'c-amex', 'wants', 'r-eat'],
  [10, '11:00', 'PriceSmart', 'PRICESMART HEREDIA', 88300, 'c-visa', 'needs', 'r-groc'],
  [12, '07:45', 'Zeo Route Planner', 'ZEO ROUTE PLANNER', 14.99, 'c-visa-usd', null, null,
    { scope: 'work', reimbursement: { status: 'pending' } }],
  [14, '20:00', 'Hikari', 'RESTAURANTE HIKARI', 28900, 'c-prom', 'wants', 'r-eat'],
  [15, '06:30', 'Facebook Ads', 'FACEBK SWRK766KH4', 65.4, 'c-bncr-usd', null, null, { scope: 'work' }],
  [17, '08:00', 'Cyber Fuel', 'CYBER FUEL SANTA ANA', 29500, 'c-davi', 'needs', 'r-gas'],
  [19, '18:10', 'Fischel', 'FARMACIA FISCHEL HEREDIA', 9870, 'c-visa', 'needs', null],
  [22, '12:40', 'Auto Mercado', 'AUTO MERCADO HEREDIA', 61200, 'c-visa', 'needs', 'r-groc'],
  [24, '19:15', 'Art Padel', 'ART PADEL', 18000, 'c-prom', 'wants', 'r-padel'],
  [27, '13:30', 'Amazon', 'AMAZON MKTPLACE PMTS', 42.5, 'c-visa-usd', 'wants', null],
  [29, '20:45', 'PedidosYa', 'PedidosYa*Burger Shop', 11600, 'c-amex', 'wants', 'r-eat'],
];

function build(rows, month, { upTo = 31 } = {}) {
  const currencyOf = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.currency]));
  return rows
    .filter(([day]) => day <= upTo)
    .map(([day, time, merchant, raw, amount, accountId, cat, line, extra = {}], i) => {
      const currency = currencyOf[accountId];
      const postedAt = `${month}-${String(day).padStart(2, '0')}T${time}:00${CR_OFFSET}`;
      const reimbursement = extra.reimbursement?.on === 'SETTLED'
        ? { status: 'reimbursed', on: `${shiftMonth(month, 1)}-05` }
        : extra.reimbursement ?? null;
      return {
        id: `demo-${month}-${i}`,
        extId: `demo:${month}:${i}`,
        kind: 'expense',
        postedAt,
        merchantRaw: raw,
        merchant,
        amount,
        currency,
        amountCrc: currency === 'CRC' ? amount : null,
        fxRate: null,
        accountId,
        scope: 'personal',
        cat,
        budgetLineId: line ? `${line}-${month}` : null,
        source: 'email',
        method: 'card',
        status: 'settled',
        reviewed: true,
        note: null,
        ...extra,
        reimbursement,
      };
    });
}

export function installDemoRepo() {
  const now = new Date();
  const month = crMonth(now);
  const prev = shiftMonth(month, -1);
  const today = Number(crDay(now).split('-')[2]);

  const months = {};
  for (let i = 8; i >= 1; i -= 1) {
    const key = shiftMonth(month, -i);
    months[key] = plan(key, { extra: i % 3 === 0 ? 0 : 150000, oneTime: i % 4 === 0, invest: 100000 + (i % 3) * 50000 });
  }
  months[month] = plan(month);

  window.__REPO__ = createMemoryRepo({
    months,
    goals: GOALS,
    settings: { alloc: { needs: 50, wants: 30, savings: 20 }, name: 'Sebas' },
    accounts: ACCOUNTS,
    rules: [],
    fxRates: [{ month: prev, currency: 'USD', rate: 505.4 }],
    transactions: [...build(THIS_MONTH, month, { upTo: today }), ...build(LAST_MONTH, prev)],
    snapshots: [
      { id: 'sn1', accountId: 's-ahorros', asOf: `${month}-01`, balance: 2450000, currency: 'CRC', note: null },
      { id: 'sn2', accountId: 's-ahorros-usd', asOf: `${shiftMonth(month, -2)}-28`, balance: 3200, currency: 'USD', note: null },
      { id: 'sn3', accountId: 'i-fondo', asOf: `${month}-01`, balance: 1850000, currency: 'CRC', note: null },
      { id: 'sn4', accountId: 'a-cash', asOf: `${month}-01`, balance: 45000, currency: 'CRC', note: null },
    ],
  });
}
