import {
  state, setState, save, uid, money, MONTHS, MONTHS_ABBR,
  DEFAULT_ALLOC, monthKey, monthLabel, shiftMonth, blankMonth, getMonth,
} from './state.js';
import { renderTransactions, amountCell, dayName } from './views-tx.js';
import { renderAccounts } from './views-accounts.js';
import { actualsFor, cachedMonth, spendByDay } from './tx.js';
import { healthScore } from './scoring.js';
import { icon, merchantIcon, goalIconName, goalTint } from './icons.js';
import { chartSlot, drawCharts, resetCharts, donut } from './charts.js';
import { crDay, crMonth, crHour, crLongDate, crTimeLabel } from './cr-date.js';

let currentMonth = monthKey();
let annualYear = +currentMonth.slice(0,4);

/* ---------------- Computation engine ---------------- */
// Planned amounts for a month, independent of any carry-over usage.
function plannedParts(m){
  const extra = m.extraIncome.reduce((s,x)=>s+(+x.amount||0),0);
  const base = (+m.income||0);
  const billsTotal = m.bills.reduce((s,x)=>s+(+x.amount||0),0);
  const recNeeds = m.recurring.filter(x=>x.cat==='needs').reduce((s,x)=>s+(+x.amount||0),0);
  const recWants = m.recurring.filter(x=>x.cat!=='needs').reduce((s,x)=>s+(+x.amount||0),0);
  const otNeeds = m.oneTime.filter(x=>x.cat==='needs').reduce((s,x)=>s+(+x.amount||0),0);
  const otWants = m.oneTime.filter(x=>x.cat!=='needs').reduce((s,x)=>s+(+x.amount||0),0);
  const needs = billsTotal + recNeeds + otNeeds;
  const wants = recWants + otWants;
  const goalsTotal = Object.values(m.contributions).reduce((s,v)=>s+(+v||0),0);
  const invest = (+m.invest||0);
  const savings = goalsTotal + invest;
  const planned = needs + wants + savings;
  return { base, extra, billsTotal, needs, wants, goalsTotal, invest, savings, planned };
}

/* Net-worth / accumulated-savings ledger.
   Each month contributes (base+extra − planned) to the pool. Money pulled in via
   usedCarryover is already in the pool, so it cancels out and never inflates net worth
   unless it is actually spent. Returns { key:{opening, net, closing} } in chronological order. */
function carryoverChain(){
  const keys = Object.keys(state.months).sort();
  let bal = 0; const map = {};
  for(const k of keys){
    const p = plannedParts(state.months[k]);
    const net = (p.base + p.extra) - p.planned;        // surplus that flows to the pool
    map[k] = { opening: bal, net, closing: bal + net };
    bal += net;
  }
  return map;
}
// Total goal savings, included in "true net worth".
function goalsSavedTotal(){ return state.goals.reduce((s,g)=>s+(+g.saved||0),0); }

function compute(key){
  const m = getMonth(key);
  const a = state.settings.alloc;
  const p = plannedParts(m);

  const chain = carryoverChain();
  const carryAvailable = chain[key] ? chain[key].opening : 0;   // pool banked from prior months
  const used = Math.max(0, Math.min(+m.usedCarryover||0, carryAvailable));

  const earned = p.base + p.extra;                     // money actually earned this month
  const income = earned + used;                        // spendable income incl. pulled savings
  const planned = p.planned;
  const remaining = income - planned;                  // free / unallocated this month
  const netToPool = earned - planned;                  // what this month adds to the pool
  const closing = carryAvailable + netToPool;          // pool balance after this month
  const netWorth = closing + goalsSavedTotal();        // true net worth incl. goals

  const tNeeds = income * a.needs/100;
  const tWants = income * a.wants/100;
  const tSavings = income * a.savings/100;
  const afterNeedsSavings = income - p.needs - p.savings;

  return {
    m, earned, income, extra:p.extra, billsTotal:p.billsTotal, needs:p.needs, wants:p.wants,
    savings:p.savings, goalsTotal:p.goalsTotal, invest:p.invest,
    planned, remaining, afterNeedsSavings,
    carryAvailable, used, netToPool, closing, netWorth,
    tNeeds, tWants, tSavings,
    pNeeds: income? p.needs/income*100:0,
    pWants: income? p.wants/income*100:0,
    pSavings: income? p.savings/income*100:0,
  };
}


/* Advisor insights. `icon` names an icon from icons.js. */
function buildAdvice(c){
  const out = [];
  const a = state.settings.alloc;
  if(c.income<=0){ out.push({cls:"warn",icon:"sparkles",t:"Start by entering your expected income for the month to get recommendations."}); return out; }
  if(c.remaining<0){
    out.push({cls:"bad",icon:"alert",t:`Your plan exceeds your income by <b>${money(-c.remaining)}</b>. Trim discretionary spending or adjust your goals.`});
  } else {
    out.push({cls:"good",icon:"check-circle",t:`You have <b>${money(c.remaining)}</b> unassigned. Consider moving it into savings or investments.`});
  }
  if(c.pSavings < a.savings){
    const gap = c.tSavings - c.savings;
    out.push({cls:"warn",icon:"piggy",t:`You're saving <b>${c.pSavings.toFixed(0)}%</b>. The target is ${a.savings}% — set aside <b>${money(gap)}</b> more to "pay yourself first".`});
  } else {
    out.push({cls:"good",icon:"piggy",t:`You're saving <b>${c.pSavings.toFixed(0)}%</b> of your income. Above the ${a.savings}% target!`});
  }
  if(c.pNeeds > 60){
    out.push({cls:"warn",icon:"home",t:`Your essentials are <b>${c.pNeeds.toFixed(0)}%</b> of income (ideal ≤${a.needs}%). Review fixed bills to free up room.`});
  }
  if(c.pWants > a.wants+5){
    out.push({cls:"warn",icon:"coffee",t:`Planned discretionary spending (<b>${c.pWants.toFixed(0)}%</b>) is above the recommended ${a.wants}%.`});
  }
  if(c.netToPool>0 && c.remaining>=0){
    out.push({cls:"good",icon:"trending-up",t:`This month you'll add <b>${money(c.netToPool)}</b> to your net worth (projected balance ${money(c.closing)}).`});
  }
  return out;
}

/* ---------------- Rendering ---------------- */
const views = document.getElementById('views');
let activeView = 'dashboard';

export function getActiveView(){ return activeView; }

/* ---- who is signed in, for the greeting and the avatar ---- */
let user = { name: '', email: '', avatar: '' };

export function setUser(u){ user = { ...user, ...u }; paintUser(); }

function displayName(){ return String(state.settings?.name || user.name || '').trim(); }

function initials(){
  const n = displayName();
  if (n) return n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (user.email || 'F')[0].toUpperCase();
}

function avatarInner(){
  return `<span>${esc(initials())}</span>${user.avatar
    ? `<img src="${esc(user.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}`;
}

function paintUser(){
  document.querySelectorAll('[data-avatar]').forEach((el) => { el.innerHTML = avatarInner(); });
  const e = document.getElementById('acctEmail');
  if (e) { e.textContent = displayName() || user.email || 'Demo data'; e.title = user.email || ''; }
}

function greeting(){
  const h = crHour();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = displayName().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

const HEADERS = {
  dashboard: () => [greeting(), `Here's how ${monthLabel(currentMonth)} is going`, crLongDate()],
  plan: () => ['Budget', `Plan ${monthLabel(currentMonth)}: what comes in, what goes out, what you keep`],
  transactions: () => ['Activity', `Everything spent in ${monthLabel(currentMonth)}, by day`],
  accounts: () => ['Accounts', 'What you have, what you owe, and what work owes you'],
  goals: () => ['Goals', 'Track progress toward what you are saving for'],
  annual: () => ['Year in review', `${annualYear}, month by month: totals and trends`],
  settings: () => ['Settings', 'Appearance, budgeting strategy and your data'],
};
const TAB_NAMES = { dashboard:'Home', plan:'Budget', transactions:'Activity', accounts:'Accounts', goals:'Goals', annual:'Year in review', settings:'Settings' };

function updateHeader(){
  const [title, sub, eyebrow = ''] = HEADERS[activeView]();
  document.getElementById('viewTitle').textContent = title;
  document.getElementById('viewSub').textContent = sub;
  document.getElementById('viewEyebrow').textContent = eyebrow;
  document.title = activeView === 'dashboard' ? 'Finances' : `${TAB_NAMES[activeView]} · Finances`;
}

export function setView(v){
  if(!HEADERS[v]) v = 'dashboard';
  activeView = v;
  if(v==='annual') annualYear = +currentMonth.slice(0,4);
  document.querySelectorAll('#nav button[data-view], #tabbar button[data-view]')
    .forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  const app = document.getElementById('app');
  if (app) app.dataset.view = v;
  window.scrollTo(0, 0);
  render();
  enter();
}

/* A view arriving eases in. Navigation only: a repaint when data lands must
   not move anything, so the class comes off once the animation is done. */
let enterT;
function enter(){
  views.classList.remove('enter');
  void views.offsetWidth;
  views.classList.add('enter');
  clearTimeout(enterT);
  enterT = setTimeout(() => views.classList.remove('enter'), 450);
}

export function render(){
  updateHeader();
  if (typeof window !== 'undefined') window.__txMonth = currentMonth;
  resetCharts();
  if(activeView==='dashboard') renderDashboard();
  else if(activeView==='plan') renderPlan();
  else if(activeView==='goals') renderGoals();
  else if(activeView==='annual') renderAnnual();
  else if(activeView==='transactions') renderTransactions(views, currentMonth);
  else if(activeView==='accounts') renderAccounts(views, currentMonth);
  else if(activeView==='settings') renderSettings();
  renderMonthSelector();
}

function renderMonthSelector(){
  const sel = document.getElementById('monthSel');
  const keys = new Set(Object.keys(state.months));
  for(let i=-3;i<=6;i++) keys.add(shiftMonth(monthKey(),i));
  keys.add(currentMonth);
  const sorted = [...keys].sort();
  sel.innerHTML = sorted.map(k=>`<option value="${k}" ${k===currentMonth?'selected':''}>${monthLabel(k)}</option>`).join('');
}

/* ---- shared pieces ---- */
function tile({ ic, tone, label, value, foot = '', onclick = '' }){
  return `<section class="card tile"${onclick ? ` role="button" tabindex="0" style="cursor:pointer" onclick="${onclick}" onkeydown="if(event.key==='Enter')this.click()"` : ''}>
    <div class="tile-top"><span class="ti tone-${tone}">${icon(ic)}</span><h3>${label}</h3></div>
    <div class="stat">${value}</div>
    <div class="tile-foot">${foot}</div>
  </section>`;
}
const pill = (text, cls) => `<span class="pill ${cls}">${text}</span>`;
const TONE = { good: 'good', warn: 'warn', bad: 'bad' };

function daysIn(key){ const [y,m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); }

/** How far into a month today is: all of a past month, none of a future one. */
function dayOfMonth(key){
  const now = crMonth(new Date());
  if (key < now) return daysIn(key);
  if (key > now) return 0;
  return Number(crDay(new Date()).split('-')[2]);
}

function monthName(key){ return MONTHS[+key.split('-')[1]-1]; }

/** A goal's colour, from its place in the list. */
const tintOf = (g) => goalTint(state.goals.indexOf(g));

/* ---- Dashboard ---- */
function renderDashboard(){
  const c = compute(currentMonth);
  const a = state.settings.alloc;
  const act = actualsFor(currentMonth, render);
  const adv = buildAdvice(c);

  // Real spending only counts once some has actually been recorded. An empty
  // month should keep reading as a plan, not as "you have spent nothing".
  const hasActuals = !act.loading && act.count > 0;
  const spent = act.total;
  const h = healthScore(c, hasActuals ? spent : 0);
  const rows = cachedMonth(currentMonth) || [];

  const savingsTile = tile({ ic:'piggy', tone:'savings', label:'Savings + investing', value: money(c.savings),
    foot: pill(`${c.pSavings.toFixed(0)}% of income`, c.pSavings>=a.savings?'good':'warn') });
  const worthTile = tile({ ic:'trending-up', tone:'invest', label:'Net worth', value: money(c.netWorth),
    foot: `${c.netToPool>=0?'+':''}${money(c.netToPool)} this month` });
  const incomeTile = tile({ ic:'income', tone:'income', label:'Income this month', value: money(c.income),
    foot: c.used>0 ? `incl. ${money(c.used)} from savings` : 'expected income' });

  const kpis = hasActuals
    ? [incomeTile, savingsTile, worthTile,
       tile({ ic:'inbox', tone:'warn', label:'Needs review', value: money(act.uncategorized),
         foot: act.uncategorized>0 ? pill('not categorized yet','warn') : pill('everything categorized','good'),
         onclick: "setView('transactions')" })]
    : [incomeTile,
       tile({ ic:'receipt', tone:'needs', label:'Planned spending', value: money(c.planned), foot: `essentials ${money(c.needs)}` }),
       savingsTile, worthTile];

  // Two columns of their own rather than rows of pairs: these cards differ a
  // lot in height, and a row is as tall as its tallest card. Each carries its
  // place in the single column a phone shows them in.
  const place = (card, order) => `<div style="--o:${order}">${card}</div>`;
  const [left, right] = hasActuals
    ? [[place(recentCard(rows), 1), place(allocationCard(c), 4), place(netWorthCard(c), 5)],
       [place(goalsCard(), 2), place(targetsCard(c, act, true), 3), place(tipsCard(adv), 6)]]
    : [[place(targetsCard(c, act, false), 1), place(netWorthCard(c), 4)],
       [place(allocationCard(c), 2), place(goalsCard(), 3), place(tipsCard(adv), 5)]];

  views.innerHTML = `
    <div class="dash-top">
      ${heroCard(c, act, hasActuals)}
      ${healthCard(h, hasActuals && spent > c.planned)}
    </div>
    <div class="kpis">${kpis.join('')}</div>
    ${hasActuals ? `<div class="dash-row r-8-4">${paceCard(c, rows)}${whereCard(act)}</div>` : ''}
    <div class="dash-cols"><div class="stack">${left.join('')}</div><div class="stack">${right.join('')}</div></div>
  `;
  drawCharts(views);
}

/**
 * The figure the dashboard leads with. What it is depends on what the month
 * has: real spending against a plan, spending with no plan, a plan with no
 * spending yet, or nothing at all.
 */
function heroCard(c, act, hasActuals){
  const name = monthName(currentMonth);
  if (hasActuals && c.planned > 0) {
    const spent = act.total;
    const left = c.planned - spent;
    const pct = Math.min(100, spent / c.planned * 100);
    const days = daysIn(currentMonth);
    const isNow = currentMonth === crMonth(new Date());
    const daysLeft = isNow ? days - dayOfMonth(currentMonth) + 1 : 0;
    const perDay = daysLeft > 0 && left > 0 ? left / daysLeft : 0;
    return `<section class="hero">
      <div class="hero-label">${icon('wallet')}Left to spend in ${name}</div>
      <div class="hero-value">${money(left)}</div>
      <div class="hero-sub"><b>${money(spent)}</b> spent of ${money(c.planned)} planned${left < 0 ? ` &nbsp;${pill(`${icon('alert')}over the plan`, '')}` : ''}</div>
      <div class="hero-bar${left < 0 ? ' over' : ''}"><i style="width:${pct}%"></i></div>
      <div class="hero-stats">
        <div><span>Transactions</span><b>${act.count}</b></div>
        ${daysLeft ? `<div><span>Days left</span><b>${daysLeft}</b></div>` : ''}
        ${perDay ? `<div><span>Per day</span><b>${money(perDay)}</b></div>` : ''}
      </div>
    </section>`;
  }
  if (hasActuals) {
    return `<section class="hero">
      <div class="hero-label">${icon('activity')}Spent in ${name}</div>
      <div class="hero-value">${money(act.total)}</div>
      <div class="hero-sub">${act.count} transaction${act.count===1?'':'s'} · there is no plan for ${name} yet</div>
      <div style="margin-top:18px"><button class="btn on-hero" onclick="setView('plan')">${icon('budget')}Plan this month</button></div>
    </section>`;
  }
  if (c.income > 0) {
    const pct = Math.min(100, c.planned / c.income * 100);
    return `<section class="hero">
      <div class="hero-label">${icon('coins')}Available to assign in ${name}</div>
      <div class="hero-value">${money(c.remaining)}</div>
      <div class="hero-sub"><b>${money(c.planned)}</b> planned of ${money(c.income)} income</div>
      <div class="hero-bar${c.remaining < 0 ? ' over' : ''}"><i style="width:${pct}%"></i></div>
      <div class="hero-stats">
        <div><span>Essentials</span><b>${money(c.needs)}</b></div>
        <div><span>Discretionary</span><b>${money(c.wants)}</b></div>
        <div><span>Saving</span><b>${money(c.savings)}</b></div>
      </div>
    </section>`;
  }
  return `<section class="hero">
    <div class="hero-label">${icon('sparkles')}${monthLabel(currentMonth)}</div>
    <div class="hero-value" style="font-size:32px">Plan your month</div>
    <div class="hero-sub">Enter what you expect to earn and spend, and the advisor will suggest a budget that pays you first.</div>
    <div style="margin-top:18px"><button class="btn on-hero" onclick="setView('plan')">${icon('arrow-right')}Start planning ${name}</button></div>
  </section>`;
}

function healthCard(h, over){
  const R = 52, C = 2*Math.PI*R;
  const off = C*(1-h.score/100);
  const col = h.cls==='good'?'var(--pos-mark)':h.cls==='warn'?'var(--warn-mark)':'var(--neg-mark)';
  return `<section class="card">
    <div class="card-head"><h3>Financial health</h3>${pill(h.label, h.cls)}</div>
    <div class="health">
      <div class="ring">
        <svg width="100%" height="100%" viewBox="0 0 124 124" aria-hidden="true">
          <circle cx="62" cy="62" r="${R}" fill="none" style="stroke:var(--surface-3)" stroke-width="12"/>
          <circle cx="62" cy="62" r="${R}" fill="none" style="stroke:${col}" stroke-width="12" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
        </svg>
        <div class="score"><b>${h.score}</b><span>of 100</span></div>
      </div>
      <p>${over
        ? 'Based on your savings rate, how well essentials are controlled, and whether you live within your income — measured against what you have actually spent, which is now past the plan.'
        : 'Based on your savings rate, how well essentials are controlled, and whether you live within your income.'}</p>
    </div>
  </section>`;
}

function paceCard(c, rows){
  const days = daysIn(currentMonth);
  const upto = dayOfMonth(currentMonth);
  const byDay = spendByDay(rows);
  const cum = [];
  let run = 0;
  for (let d = 1; d <= upto; d += 1) {
    run += byDay[`${currentMonth}-${String(d).padStart(2, '0')}`] || 0;
    cum.push(run);
  }
  const pace = c.planned * upto / days;
  const diff = pace - run;
  const status = c.planned > 0 && upto > 0
    ? (diff >= 0
      ? pill(`${icon('trending-down')}${money(diff)} under pace`, 'good')
      : pill(`${icon('trending-up')}${money(-diff)} over pace`, 'warn'))
    : '';
  return `<section class="card">
    <div class="card-head">
      <div><h3>Spending pace</h3><div class="card-sub">Spent so far, against an even pace to ${money(c.planned)}</div></div>
      ${status}
    </div>
    ${chartSlot('pace', { days, cum, planned: c.planned, month: currentMonth }, {
      height: 210,
      label: `Spending pace: ${money(run)} spent by day ${upto} of ${days}, against ${money(pace)} at an even pace.`,
    })}
    <div class="chart-foot">
      <span><i class="key-line"></i>Spent</span>
      ${c.planned > 0 ? '<span><i class="key-line dashed"></i>Even pace to the plan</span>' : ''}
    </div>
  </section>`;
}

function whereCard(act){
  const segs = [
    { tone:'needs', label:'Essentials', value: act.needs },
    { tone:'wants', label:'Discretionary', value: act.wants },
    { tone:'savings', label:'Savings', value: act.savings },
    { tone:'none', label:'Uncategorized', value: act.uncategorized },
  ];
  const total = act.total || 1;
  const legend = segs.filter(s=>s.value>0).map(s=>`
    <div class="legend-item tone-${s.tone}">
      <span class="li-l"><span class="swatch"></span>${s.label}</span>
      <span class="li-v"><b>${money(s.value)}</b><span class="pct">${Math.round(s.value/total*100)}%</span></span>
    </div>`).join('');
  return `<section class="card where">
    <div class="card-head"><div><h3>Where it went</h3><div class="card-sub">Personal spending by category</div></div></div>
    <div class="donut-wrap">
      ${donut(segs, { value: money(act.total), label: 'spent' })}
      <div class="legend rows" style="flex:1;margin:0;min-width:0">${legend || '<span class="muted">Nothing spent yet.</span>'}</div>
    </div>
    ${act.uncategorized > 0 ? `<div class="card-note">${money(act.uncategorized)} is not in any category yet —
      <button class="linkbtn" onclick="setView('transactions')">categorize it</button> to see where it really lands.</div>` : ''}
    ${act.pendingCount > 0 ? `<div class="card-note">${act.pendingCount} foreign charge${act.pendingCount===1?'':'s'} excluded — no exchange rate set for this month.</div>` : ''}
  </section>`;
}

function recentCard(rows){
  const list = rows.filter((t) => t.status !== 'voided')
    .sort((x, y) => new Date(y.postedAt) - new Date(x.postedAt))
    .slice(0, 5);
  const item = (t) => `
    <div class="item tap" role="button" tabindex="0" onclick="txEdit('${esc(t.id)}')" onkeydown="if(event.key==='Enter')this.click()">
      ${merchantIcon(t, { size: 'sm' })}
      <div class="item-main">
        <div class="item-title"><span class="t">${esc(t.merchant || t.merchantRaw || '(no merchant)')}</span>${t.reviewed ? '' : '<span class="tx-dot" title="Not reviewed"></span>'}</div>
        <div class="item-sub">${dayName(crDay(t.postedAt), { short: true })} · ${crTimeLabel(t.postedAt)}</div>
      </div>
      ${amountCell(t)}
    </div>`;
  return `<section class="card recent">
    <div class="card-head" style="margin-bottom:2px">
      <h3>Recent activity</h3>
      <button class="card-link" onclick="setView('transactions')">See all${icon('chevron-right')}</button>
    </div>
    ${list.length ? list.map(item).join('') : '<div class="list-empty">No transactions this month yet.</div>'}
  </section>`;
}

function goalsCard(){
  const body = state.goals.length ? state.goals.slice(0, 4).map(g=>{
    const pct = g.target>0?Math.min(100,g.saved/g.target*100):0;
    const tint = tintOf(g);
    return `<div class="goal-mini">
      <div class="goal-mini-top"><span class="gi tone-${tint}">${icon(goalIconName(g))}</span><span class="gname">${esc(g.name)}</span><span class="gpct">${pct.toFixed(0)}%</span></div>
      <div class="meter"><i class="tone-${tint}" style="width:${pct}%"></i></div>
      <div class="goal-mini-meta"><span>${money(g.saved)}</span><span>of ${money(g.target)}</span></div>
    </div>`;
  }).join('') : `<div class="empty" style="padding:18px 0 6px">
      <div class="empty-ic">${icon('target')}</div>
      <p>No goals yet.</p>
      <button class="btn soft sm" onclick="setView('goals')">${icon('plus')}Create one</button>
    </div>`;
  return `<section class="card">
    <div class="card-head" style="margin-bottom:4px">
      <h3>Goal progress</h3>
      ${state.goals.length ? `<button class="card-link" onclick="setView('goals')">All goals${icon('chevron-right')}</button>` : ''}
    </div>
    ${body}
  </section>`;
}

function targetsCard(c, act, hasActuals){
  const a = state.settings.alloc;
  const rows = hasActuals
    ? [['needs','Essentials',act.needs,c.tNeeds],['wants','Discretionary',act.wants,c.tWants],['savings','Savings / investing',c.savings,c.tSavings]]
    : [['needs','Essentials',c.needs,c.tNeeds],['wants','Discretionary',c.wants,c.tWants],['savings','Savings / investing',c.savings,c.tSavings]];
  const body = rows.map(([k,name,val,target])=>{
    const max = Math.max(val, target, 1);
    return `<div class="target-row">
      <div class="target-top">
        <span class="target-name"><span class="swatch tone-${k}"></span>${name}</span>
        <span class="target-vals"><b>${money(val)}</b> / ${money(target)}</span>
      </div>
      <div class="meter"><i class="tone-${k}" style="width:${val/max*100}%"></i>${target>0?`<span class="mark" style="left:${target/max*100}%" title="Target ${money(target)}"></span>`:''}</div>
    </div>`;
  }).join('');
  return `<section class="card">
    <div class="card-head"><div>
      <h3>${hasActuals ? 'Actual spending vs. target' : 'Plan vs. target'}</h3>
      <div class="card-sub">${hasActuals ? 'What you have really spent, not what you planned to' : 'Your plan, against the split you are aiming for'}</div>
    </div></div>
    ${body}
    <div class="chart-foot"><span><i style="display:inline-block;width:2px;height:12px;border-radius:2px;background:var(--text);opacity:.75"></i>Target for a ${a.needs}/${a.wants}/${a.savings} split</span></div>
  </section>`;
}

function allocationCard(c){
  const segs = [['needs','Essentials',c.needs],['wants','Discretionary',c.wants],['savings','Savings',c.goalsTotal],['invest','Investing',c.invest]];
  const bar = segs.filter(s=>s[2]>0).map(([k,l,v])=>`<i class="tone-${k}" style="flex:${v} 1 0" title="${l}: ${money(v)}"></i>`).join('')
    + (c.remaining>0?`<i class="rest" style="flex:${c.remaining} 1 0" title="Unassigned: ${money(c.remaining)}"></i>`:'');
  const legend = segs.map(([k,l,v])=>`<div class="legend-item tone-${k}"><span class="swatch"></span>${l} <b>${money(v)}</b></div>`).join('')
    + (c.remaining>0?`<div class="legend-item"><span class="swatch" style="background:var(--surface-3)"></span>Unassigned <b>${money(c.remaining)}</b></div>`:'');
  return `<section class="card">
    <div class="card-head"><div><h3>Income allocation</h3><div class="card-sub">Where the plan puts ${money(c.income)} of income</div></div></div>
    <div class="stackbar">${bar || '<i class="rest" style="flex:1 1 0"></i>'}</div>
    <div class="legend">${legend}</div>
  </section>`;
}

function netWorthCard(c){
  const up = c.netToPool >= 0;
  return `<section class="card">
    <div class="card-head">
      <div><h3>Net worth</h3><div class="card-sub">Accumulated savings plus what is in your goals</div></div>
      ${pill(`${up?'+':''}${money(c.netToPool)} this month`, up?'good':'bad')}
    </div>
    <div class="nw-big">${money(c.netWorth)}</div>
    <div class="kv"><span><span class="swatch tone-savings" style="display:inline-block;margin-right:8px"></span>Available savings</span><b>${money(c.closing)}</b></div>
    <div class="kv"><span><span class="swatch tone-invest" style="display:inline-block;margin-right:8px"></span>Saved in goals</span><b>${money(goalsSavedTotal())}</b></div>
    <div class="card-sub" style="margin:16px 0 2px;font-weight:600;color:var(--text-2)">This month's savings pool</div>
    <div class="kv"><span>Available at start of month</span><b>${money(c.carryAvailable)}</b></div>
    <div class="kv"><span>Used as income this month</span><b>${money(c.used)}</b></div>
    <div class="kv"><span>Added this month</span><b class="${up?'pos':'neg'}">${up?'+':''}${money(c.netToPool)}</b></div>
    <div class="kv"><span>Projected end-of-month balance</span><b>${money(c.closing)}</b></div>
    <div class="card-note">Unspent money isn't lost between months: it accumulates here and you can use it whenever you need it.</div>
  </section>`;
}

function tipsCard(adv){
  return `<section class="card tips">
    <div class="card-head" style="margin-bottom:2px"><h3>Advisor tips</h3></div>
    ${adv.map(x=>`<div class="tip-item"><span class="tip-ic tone-${TONE[x.cls]}">${icon(x.icon)}</span><div>${x.t}</div></div>`).join('')}
  </section>`;
}

/* ---- Plan ---- */

/**
 * Only two things here are worth a colour: you have gone over a line, or
 * you are within a whisker of it.
 *
 * Under-spending is deliberately left uncoloured. Half the lines are under
 * on the 9th of the month purely because the month is not over, so painting
 * them green would be congratulating you for the calendar.
 */
function overClass(planned, spent){
  if(!planned || !spent) return '';
  if(spent > planned) return ' li-over';
  if(spent >= planned*0.9) return ' li-close';
  return '';
}

/**
 * How a line's spending compares with what was planned for it.
 * Nothing planned and nothing spent reads as neither good nor bad.
 */
function spentCell(act, id, planned){
  if(act.loading) return `<div class="line-spent"><span class="li-actual loading muted">…</span></div>`;
  const spent = act.byLine[id] || 0;
  if(!spent) return `<div class="line-spent"><span class="li-actual li-none">—</span></div>`;
  const pct = planned > 0 ? Math.min(100, spent/planned*100) : 100;
  const tone = planned && spent > planned ? 'bad' : planned && spent >= planned*0.9 ? 'warn' : 'accent';
  return `<div class="line-spent">
    <span class="li-actual"><b>${money(spent)}</b>${planned ? ` <span class="faint">· ${Math.round(spent/planned*100)}%</span>` : ''}</span>
    <div class="meter thin"><i class="tone-${tone}" style="width:${pct}%"></i></div>
  </div>`;
}

function moneyInput(v, handler, { label = 'Amount', attrs = '' } = {}){
  return `<label class="money-inp"><span>₡</span><input type="number" inputmode="numeric" value="${v||''}" placeholder="0" aria-label="${label}" oninput="${handler}"${attrs}></label>`;
}

function groupTotals(m, c){
  const sum = (arr) => arr.reduce((s,x)=>s+(+x.amount||0),0);
  return { income: c.earned, extra: c.extra, bills: c.billsTotal, recurring: sum(m.recurring), oneTime: sum(m.oneTime), goals: c.goalsTotal, invest: c.invest };
}

function group({ ic, tone, title, total, desc = '', body }){
  return `<section class="card group">
    <div class="group-head">
      <span class="gi tone-${tone}">${icon(ic)}</span>
      <h4>${title}</h4>
      ${total ? `<span class="group-total" data-total="${total[0]}">${money(total[1])}</span>` : ''}
    </div>
    ${desc ? `<p class="group-desc">${desc}</p>` : ''}
    <div class="group-body">${body}</div>
  </section>`;
}

function planSummaryInner(c){
  const segs = [['needs','Essentials',c.needs],['wants','Discretionary',c.wants],['savings','Savings',c.goalsTotal],['invest','Investing',c.invest]];
  const bar = segs.filter(s=>s[2]>0).map(([k,l,v])=>`<i class="tone-${k}" style="flex:${v} 1 0" title="${l}: ${money(v)}"></i>`).join('')
    + (c.remaining>0?`<i class="rest" style="flex:${c.remaining} 1 0" title="Unassigned: ${money(c.remaining)}"></i>`:'');
  return `<div class="ps-top">
      <div><div class="ps-label">Unassigned this month</div><div class="ps-value${c.remaining<0?' neg':''}">${money(c.remaining)}</div></div>
      <div class="ps-side">
        <div><span>Income</span><b>${money(c.income)}</b></div>
        <div><span>Planned</span><b>${money(c.planned)}</b></div>
      </div>
    </div>
    <div class="stackbar">${bar || '<i class="rest" style="flex:1 1 0"></i>'}</div>
    <div class="legend">${segs.map(([k,l,v])=>`<div class="legend-item tone-${k}"><span class="swatch"></span>${l} <b>${money(v)}</b></div>`).join('')}</div>`;
}

function planStickyInner(c){
  return `<span>Unassigned</span><b class="${c.remaining<0?'neg':''}">${money(c.remaining)}</b><span>of ${money(c.income)}</span>`;
}

function usedNote(c){ return `Using <b>${money(c.used)}</b> of your accumulated savings.`; }
function surplusNote(c){ return `This month's surplus (<b>${money(Math.max(0,c.netToPool))}</b>) will automatically be added to your accumulated savings.`; }

function recoLine(name,key,pct,target,actual){
  let cls, status;
  if(key==='savings'){ cls = actual>=target?'good':'warn'; status = actual>=target ? 'on target' : 'below target'; }
  else { cls = actual<=target*1.05?'good':'warn'; status = actual<=target*1.05 ? 'within target' : 'over target'; }
  const max = Math.max(target, actual, 1);
  return `<div class="reco">
    <div class="reco-top">
      <span class="reco-name"><span class="swatch tone-${key}"></span>${name} <small>${pct}%</small></span>
      ${pill(status, cls)}
    </div>
    <div class="meter thin"><i class="tone-${key}" style="width:${actual/max*100}%"></i>${target>0?`<span class="mark" style="left:${target/max*100}%"></span>`:''}</div>
    <div class="reco-vals" style="margin-top:7px"><b>${money(actual)}</b> of ${money(target)} target</div>
  </div>`;
}

function advisorHtml(c){
  const a = state.settings.alloc;
  return `
    <div class="card-head"><div><h3>Recommended budget</h3><div class="card-sub">${a.needs}/${a.wants}/${a.savings} strategy · pay yourself first</div></div></div>
    <div class="kv"><span>Total income</span><b>${money(c.income)}</b></div>
    ${recoLine("Essentials",'needs',a.needs,c.tNeeds,c.needs)}
    ${recoLine("Discretionary",'wants',a.wants,c.tWants,c.wants)}
    ${recoLine("Savings + investing",'savings',a.savings,c.tSavings,c.savings)}
    <div class="remain-box">
      <div class="lbl">Unassigned available</div>
      <div class="big-remain ${c.remaining<0?'neg':c.remaining>0?'pos':''}">${money(c.remaining)}</div>
      <p>After essentials + savings you have <b>${money(c.afterNeedsSavings)}</b> to spend freely.</p>
    </div>
    ${buildAdvice(c).slice(0,3).map(x=>`<div class="advice"><span class="tip-ic tone-${TONE[x.cls]}">${icon(x.icon)}</span><span>${x.t}</span></div>`).join('')}`;
}

function renderPlan(){
  const m = getMonth(currentMonth);
  const c = compute(currentMonth);

  // What was actually spent this month, by plan line. Loads in the background
  // the first time and re-renders, so this stays a synchronous view.
  const act = actualsFor(currentMonth, render);
  const totals = groupTotals(m, c);

  /**
   * `withSpent` is off for income: money coming in has nothing to compare
   * against a plan line, and a "Spent" column beside it just reads as broken.
   */
  function itemRows(arr,kind,withCat,withSpent=true){
    const mods = `${withSpent?' has-spent':''}${withCat?' has-cat':''}`;
    const head = `<div class="li-head${mods}"><span>Item</span><span class="r">${withSpent?'Planned':'Amount'}</span>${withSpent?'<span class="r">Spent</span>':''}${withCat?'<span>Type</span>':''}<span></span></div>`;
    const rows = arr.map((it,i)=>{
      const spent = act.byLine[it.id]||0;
      const planned = +it.amount||0;
      return `
      <div class="line${mods}${withSpent?overClass(planned, spent):''}" data-line="${kind}:${i}">
        <input class="line-name" value="${esc(it.name||'')}" placeholder="Name" aria-label="Name" oninput="updItem('${kind}',${i},'name',this.value)">
        ${moneyInput(it.amount, `updItem('${kind}',${i},'amount',this.value)`, { label: withSpent ? 'Planned amount' : 'Amount' })}
        ${withSpent?spentCell(act, it.id, planned):''}
        ${withCat?`<select class="inp cat" aria-label="Type" onchange="updItem('${kind}',${i},'cat',this.value)">
          <option value="needs" ${it.cat==='needs'?'selected':''}>Essential</option>
          <option value="wants" ${it.cat!=='needs'?'selected':''}>Discretionary</option>
        </select>`:''}
        <button class="line-del" onclick="delItem('${kind}',${i})" title="Remove" aria-label="Remove ${esc(it.name||'this line')}">${icon('x')}</button>
      </div>`;
    }).join('');
    return rows ? head + rows : `<div class="muted" style="font-size:13px;padding:2px 0 4px">Nothing yet.</div>`;
  }

  /**
   * Spending that fell in a category but matched no line.
   *
   * Shown as its own row rather than folded into a total: the gap between the
   * plan and reality is the interesting part, and hiding it is how a budget
   * quietly stops describing anything.
   */
  function unmatchedRow(cat){
    if(act.loading) return '';
    const v = act.unbudgetedByCat[cat]||0;
    if(!v) return '';
    return `<div class="li-unmatched">
      ${icon('info', { size: 16 })}
      <span>Spent but not on a line above</span>
      <span class="amt">${money(v)}</span>
      <button class="btn ghost sm" onclick="setView('transactions')">Assign${icon('arrow-right')}</button>
    </div>`;
  }

  const goalRows = state.goals.length ? state.goals.map(g=>{
    const v = m.contributions[g.id]||'';
    const suggested = g.monthly||0;
    return `<div class="line goal-line">
      <div class="line-label"><span class="gi tone-${tintOf(g)}" style="width:30px;height:30px;border-radius:9px">${icon(goalIconName(g), { size: 16 })}</span><span>${esc(g.name)}</span></div>
      ${moneyInput(v, `updContribution('${g.id}',this.value)`, { label: `Contribution to ${esc(g.name)}` })}
      <button class="btn ghost sm" onclick="updContribution('${g.id}',${suggested});render()" title="Use the suggested contribution"><small>Suggested</small>${suggested?money(suggested):'—'}</button>
    </div>`;
  }).join('') : `<div class="muted" style="font-size:13px">No goals yet. <button class="linkbtn" onclick="setView('goals')">Create one on the Goals tab</button>.</div>`;

  views.innerHTML = `
  <div class="plan-sticky" id="planSticky">${planStickyInner(c)}</div>
  <div class="plan">
    <div class="plan-main">
      <section class="card plan-summary" id="planSummary">${planSummaryInner(c)}</section>

      ${group({ ic:'income', tone:'income', title:'Expected income', total:['income', totals.income], body:`
        <div class="field">
          <label>Primary income this month (net salary)</label>
          ${moneyInput(m.income, 'updIncome(this.value)', { label: 'Primary income' })}
        </div>
        <div class="row-between" style="margin:4px 0 6px"><span class="field-label" style="margin:0">Anticipated additional income</span><span class="group-total" data-total="extra" style="font-size:13px;color:var(--muted)">${money(c.extra)}</span></div>
        ${itemRows(m.extraIncome,'extraIncome',false,false)}
        <button class="addrow" onclick="addItem('extraIncome')">${icon('plus')}Add extra income</button>` })}

      ${group({ ic:'coins', tone:'savings', title:'Accumulated savings', total:null,
        desc:`Money you've accumulated in previous months by spending less than you earn — <b style="color:var(--text)">${money(c.carryAvailable)}</b> available. You can use some of it as extra income this month; whatever you don't use keeps growing.`,
        body:`
        ${c.carryAvailable>0 ? `
        <div class="field" style="margin-bottom:8px">
          <label>Use this month as additional income</label>
          ${moneyInput(m.usedCarryover, 'updCarryover(this.value)', { label: 'Savings used as income', attrs: ` max="${c.carryAvailable}"` })}
        </div>
        <div class="pool-quick">
          <button class="btn ghost sm" onclick="useCarryover(0)">None</button>
          <button class="btn ghost sm" onclick="useCarryover(${Math.round(c.carryAvailable/2)})">Half</button>
          <button class="btn ghost sm" onclick="useCarryover(${Math.round(c.carryAvailable)})">All</button>
        </div>
        <div class="pool-note" id="usedNote">${usedNote(c)}</div>
        ` : `<div class="pool-note" style="margin-top:0">You don't have accumulated savings yet. Finish a month with a surplus and it will appear here.</div>`}
        <div class="pool-note" id="surplusNote">${surplusNote(c)}</div>` })}

      ${group({ ic:'receipt', tone:'needs', title:'Mandatory fixed bills', total:['bills', totals.bills],
        desc:'Rent, utilities, loans, insurance — essentials.', body:`
        ${itemRows(m.bills,'bills',false)}
        ${unmatchedRow('needs')}
        <button class="addrow" onclick="addItem('bills')">${icon('plus')}Add bill</button>` })}

      ${group({ ic:'repeat', tone:'wants', title:'Recurring expenses', total:['recurring', totals.recurring],
        desc:'Subscriptions, transport, food — mark whether each is essential or discretionary.', body:`
        ${itemRows(m.recurring,'recurring',true)}
        ${unmatchedRow('wants')}
        <button class="addrow" onclick="addItem('recurring')">${icon('plus')}Add recurring</button>` })}

      ${group({ ic:'tag', tone:'needs', title:'One-time expenses this month', total:['oneTime', totals.oneTime],
        desc:'One-off expenses expected for this month.', body:`
        ${itemRows(m.oneTime,'oneTime',true)}
        <button class="addrow" onclick="addItem('oneTime')">${icon('plus')}Add one-time</button>` })}

      ${group({ ic:'target', tone:'savings', title:'Savings to goals', total:['goals', totals.goals], body: goalRows })}

      ${group({ ic:'trending-up', tone:'invest', title:'Investing', total:['invest', totals.invest], body:`
        <div class="field" style="margin:0">
          <label>Amount to invest this month (fund, stocks, voluntary pension…)</label>
          ${moneyInput(m.invest, 'updInvest(this.value)', { label: 'Amount to invest' })}
        </div>` })}
    </div>

    <aside class="advisor">
      <section class="card">${advisorHtml(c)}</section>
      <div class="advisor-actions">
        <button class="btn ghost sm" onclick="copyMonth()">${icon('copy')}Copy previous month</button>
        <button class="btn ghost sm" onclick="clearMonth()">${icon('reset')}Clear month</button>
      </div>
    </aside>
  </div>`;
}

/* ---- Goals ---- */
function renderGoals(){
  const list = state.goals.length ? `<div class="goals-grid">${state.goals.map(goalCard).join('')}</div>`
    : `<div class="card empty">
        <div class="empty-ic">${icon('target')}</div>
        <h3>No savings goals yet</h3>
        <p>Create your first one to start building wealth — an emergency fund is a good place to begin.</p>
        <button class="btn" onclick="goalModal()">${icon('plus')}New goal</button>
      </div>`;
  views.innerHTML = `
    <div class="page-intro">
      <p>Define objectives (emergency fund, trip, year-end bonus savings…) and let the advisor suggest how much to contribute each month.</p>
      ${state.goals.length ? `<button class="btn" onclick="goalModal()">${icon('plus')}New goal</button>` : ''}
    </div>
    ${list}`;
}
function goalCard(g){
  const pct = g.target>0?Math.min(100,g.saved/g.target*100):0;
  const remain = Math.max(0,g.target-g.saved);
  const monthsLeft = g.monthly>0?Math.ceil(remain/g.monthly):null;
  const tint = tintOf(g);
  return `<section class="card goal-card">
    <div class="goal-top">
      <span class="gi lg tone-${tint}">${icon(goalIconName(g))}</span>
      <div class="goal-title">
        <div class="goal-name">${esc(g.name)}</div>
        <div class="goal-sub">${g.deadline?`${icon('calendar')}Target date: ${esc(g.deadline)}`:'No target date'}</div>
      </div>
      ${pill(`${pct>=100?icon('check'):''}${pct.toFixed(0)}%`, pct>=100?'good':'neutral')}
    </div>
    <div>
      <div class="goal-amounts"><b>${money(g.saved)}</b><span>saved of ${money(g.target)}</span></div>
      <div class="meter lg" style="margin-top:10px"><i class="tone-${tint}" style="width:${pct}%"></i></div>
    </div>
    <div class="goal-meta">
      ${g.monthly>0?`Suggested monthly contribution: <b>${money(g.monthly)}</b>${monthsLeft!==null?` · ~${monthsLeft} month${monthsLeft===1?'':'s'} left`:''}`:'No monthly contribution set'}
    </div>
    <div class="goal-actions">
      <button class="btn soft sm" onclick="addToGoal('${g.id}')">${icon('plus')}Log savings</button>
      <button class="btn ghost sm" onclick="goalModal('${g.id}')">${icon('pencil')}Edit</button>
      <button class="iconbtn sm danger" onclick="delGoal('${g.id}')" title="Delete goal" aria-label="Delete ${esc(g.name)}">${icon('trash')}</button>
    </div>
  </section>`;
}

/* ---- Annual Review ---- */
function renderAnnual(){
  const year = annualYear;
  const rows = [];
  const tot = {earned:0,needs:0,wants:0,savings:0,net:0,monthsPlanned:0,srSum:0,srCount:0};
  let bestNet=null, worstNet=null;
  const netSeries = [];

  for(let mo=1;mo<=12;mo++){
    const key = year+"-"+String(mo).padStart(2,'0');
    const exists = !!state.months[key];
    if(exists){
      const c = compute(key);
      const planned = c.earned>0 || c.planned>0 || c.used>0;
      rows.push({mo,key,exists:true,c,planned});
      if(c.income>0 || c.planned>0){
        tot.earned += c.earned; tot.needs += c.needs; tot.wants += c.wants;
        tot.savings += c.savings; tot.net += c.netToPool; tot.monthsPlanned++;
        if(c.income>0){ tot.srSum += c.pSavings; tot.srCount++; }
        if(bestNet===null || c.netToPool>bestNet.v) bestNet={mo,v:c.netToPool};
        if(worstNet===null || c.netToPool<worstNet.v) worstNet={mo,v:c.netToPool};
      }
      netSeries.push({mo,v:c.netToPool,active:true});
    } else {
      rows.push({mo,key,exists:false});
      netSeries.push({mo,v:0,active:false});
    }
  }

  // Net worth as of end of this year (pool closing of last planned month <= Dec of year)
  const chain = carryoverChain();
  let poolEndOfYear = 0;
  const yearKeys = Object.keys(chain).filter(k=>+k.slice(0,4)<=year).sort();
  if(yearKeys.length) poolEndOfYear = chain[yearKeys[yearKeys.length-1]].closing;
  const netWorthNow = (yearKeys.length?chain[Object.keys(chain).sort().pop()].closing:0) + goalsSavedTotal();
  const avgSR = tot.srCount? tot.srSum/tot.srCount : 0;

  const LABELS = ['Earned','Essentials','Discretionary','Saved / inv.','To net worth','Pool balance'];
  const cells = (vals) => vals.map((v,i)=>`<td data-label="${LABELS[i]}"${v.cls?` class="${v.cls}"`:''}>${v.t ?? v}</td>`).join('');

  const body = rows.map(r=>{
    if(!r.exists){
      return `<tr class="empty-row"><td>${MONTHS[r.mo-1]}</td>${cells(['—','—','—','—','—','—'])}</tr>`;
    }
    const c=r.c;
    return `<tr class="link" tabindex="0" onclick="gotoMonth('${r.key}')" onkeydown="if(event.key==='Enter')this.click()">
      <td>${MONTHS[r.mo-1]}</td>
      ${cells([money(c.earned), money(c.needs), money(c.wants), money(c.savings),
        { t: `${c.netToPool>=0?'+':''}${money(c.netToPool)}`, cls: c.netToPool>=0?'pos':'neg' }, money(c.closing)])}
    </tr>`;
  }).join('');

  const totalRow = `<tr class="total-row">
    <td>Year to date</td>
    ${cells([money(tot.earned), money(tot.needs), money(tot.wants), money(tot.savings),
      { t: `${tot.net>=0?'+':''}${money(tot.net)}`, cls: tot.net>=0?'pos':'neg' }, money(poolEndOfYear)])}
  </tr>`;

  const hasData = tot.monthsPlanned>0;

  views.innerHTML = `
    <div class="year-bar">
      <div class="yearnav">
        <button class="iconbtn" onclick="stepYear(-1)" title="Previous year" aria-label="Previous year">${icon('chevron-left')}</button>
        <b>${year}</b>
        <button class="iconbtn" onclick="stepYear(1)" title="Next year" aria-label="Next year">${icon('chevron-right')}</button>
      </div>
      <div class="year-count">${tot.monthsPlanned} of 12 months planned</div>
    </div>

    ${!hasData ? `<div class="card empty">
      <div class="empty-ic">${icon('chart')}</div>
      <h3>No months planned for ${year} yet</h3>
      <p>Plan a month and it will show up in this review.</p>
      <button class="btn" onclick="setView('plan')">${icon('budget')}Go to the budget</button>
    </div>` : `

    <div class="kpis" style="margin-top:0">
      ${tile({ ic:'income', tone:'income', label:'Total earned (YTD)', value: money(tot.earned), foot: `${tot.monthsPlanned} month${tot.monthsPlanned>1?'s':''} planned` })}
      ${tile({ ic:'piggy', tone:'savings', label:'Saved + invested', value: money(tot.savings), foot: 'into goals & investments' })}
      ${tile({ ic:'trending-up', tone:'invest', label:'Added to net worth', value: money(tot.net), foot: pill(tot.net>=0?'surplus kept':'net deficit', tot.net>=0?'good':'bad') })}
      ${tile({ ic:'percent', tone:'wants', label:'Avg. savings rate', value: avgSR.toFixed(0)+'%', foot: pill(avgSR>=state.settings.alloc.savings?'at/above target':'below target', avgSR>=state.settings.alloc.savings?'good':'warn') })}
    </div>

    <div class="dash-row r-8-4">
      <section class="card">
        <div class="card-head"><div><h3>Monthly contribution to net worth</h3>
          <div class="card-sub">Above the line, a month you finished with a surplus; below it, one where you spent more than you earned.</div></div></div>
        ${chartSlot('bars', { labels: MONTHS_ABBR, values: netSeries.map(s=>s.v), active: netSeries.map(s=>s.active), year }, {
          height: 220, label: `Monthly contribution to net worth in ${year}. The figures are in the table below.` })}
      </section>
      <section class="card">
        <div class="card-head"><div><h3>Net worth to date</h3><div class="card-sub">Accumulated savings + goal balances, across all months</div></div></div>
        <div class="nw-big">${money(netWorthNow)}</div>
        <div class="kv"><span>Savings pool, end of ${year}</span><b>${money(poolEndOfYear)}</b></div>
        <div class="kv"><span>Saved in goals</span><b>${money(goalsSavedTotal())}</b></div>
        <div class="kv"><span>Best month</span><b>${bestNet?MONTHS_ABBR[bestNet.mo-1]+' · '+money(bestNet.v):'—'}</b></div>
        <div class="kv"><span>Weakest month</span><b>${worstNet?MONTHS_ABBR[worstNet.mo-1]+' · '+money(worstNet.v):'—'}</b></div>
      </section>
    </div>

    <section class="card mt">
      <div class="card-head"><div><h3>Month by month</h3><div class="card-sub">Select a planned month to open its budget. "Earned" leaves out savings pulled from earlier months, so it reflects real income.</div></div></div>
      <div style="overflow-x:auto">
      <table class="ytbl">
        <thead><tr>
          <th>Month</th><th>Earned</th><th>Essentials</th><th>Discretionary</th><th>Saved / inv.</th><th>To net worth</th><th>Pool balance</th>
        </tr></thead>
        <tbody>${body}${totalRow}</tbody>
      </table>
      </div>
    </section>
    `}
  `;
  drawCharts(views);
}

/* ---- Settings ---- */
function renderSettings(){
  const a = state.settings.alloc;
  const sum = a.needs+a.wants+a.savings;
  const theme = getTheme();
  const opt = (k, ic, label) => `<button type="button" class="${theme===k?'on':''}" aria-pressed="${theme===k}" onclick="setTheme('${k}')">${icon(ic)}${label}</button>`;
  const saved = document.getElementById('lastSaved');
  views.innerHTML = `
  <div class="settings">
    <div class="stack">
      <section class="card">
        <div class="card-head"><div><h3>Appearance</h3><div class="card-sub">Light, dark, or whatever this device is set to</div></div></div>
        <div class="set-row">
          <div class="set-text"><b>Theme</b><span>Remembered on this device</span></div>
          <div class="seg" role="group" aria-label="Theme">${opt('system','monitor','Auto')}${opt('light','sun','Light')}${opt('dark','moon','Dark')}</div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h3>Allocation strategy</h3><div class="card-sub">Adjust the target percentages. The base model is 50/30/20: essentials, discretionary, savings.</div></div></div>
        ${allocSlider('needs','Essentials (needs)',a.needs)}
        ${allocSlider('wants','Discretionary (wants)',a.wants)}
        ${allocSlider('savings','Savings + investing',a.savings)}
        <div class="kv"><span>Total</span><b id="allocSum" style="color:${sum===100?'var(--pos)':'var(--warn)'}">${sum}%</b></div>
        <div id="allocHint" class="card-sub">${sum===100?'Balanced to 100%.':'The ideal total is 100%. Adjust so it adds up.'}</div>
        <div class="preset-row">
          <button class="btn ghost sm" onclick="setAlloc(50,30,20)">50 / 30 / 20</button>
          <button class="btn ghost sm" onclick="setAlloc(60,20,20)">60 / 20 / 20</button>
          <button class="btn ghost sm" onclick="setAlloc(50,20,30)">Aggressive saving</button>
        </div>
      </section>
    </div>
    <div class="stack">
      <section class="card">
        <div class="card-head"><div><h3>Data</h3><div class="card-sub">Saved to your account and synced to every device you sign in on. Export a backup whenever you like.</div></div></div>
        <div class="data-actions">
          <button class="btn ghost" onclick="exportData()">${icon('download')}Export backup (JSON)</button>
          <label class="btn ghost">${icon('upload')}Import backup<input type="file" accept="application/json" hidden onchange="importData(this)"></label>
          <button class="btn ghost danger" style="margin-right:0" onclick="resetAll()">${icon('trash')}Erase all data</button>
        </div>
        <div class="card-note">Principles applied: pay yourself first, percentage-based budgeting, emergency fund as the first goal, and living below your means.</div>
      </section>
      ${user.email ? `<section class="card only-phone">
        <div class="card-head"><div><h3>Account</h3><div class="card-sub">${esc(user.email)}</div></div></div>
        ${saved?.textContent ? `<div class="save-state" data-state="${esc(saved.dataset.state || 'saved')}" style="margin-bottom:14px">${esc(saved.textContent)}</div>` : ''}
        <button class="btn ghost block" onclick="doSignOut()">${icon('logout')}Sign out</button>
      </section>` : ''}
    </div>
  </div>`;
}
function allocSlider(k,label,val){
  const col = { needs:'var(--cat-needs)', wants:'var(--cat-wants)', savings:'var(--cat-savings)' }[k];
  return `<div class="slider">
    <div class="slider-top"><span><span class="swatch tone-${k}"></span>${label}</span><b id="allocval_${k}">${val}%</b></div>
    <input type="range" min="0" max="100" value="${val}" style="--fill:${col};--pct:${val}%" aria-label="${label}"
      oninput="this.style.setProperty('--pct',this.value+'%');liveAlloc('${k}',this.value)">
  </div>`;
}
export function liveAlloc(k,v){
  state.settings.alloc[k] = +v||0;
  save();
  const lab=document.getElementById('allocval_'+k); if(lab) lab.textContent=v+'%';
  const a=state.settings.alloc, sum=a.needs+a.wants+a.savings;
  const se=document.getElementById('allocSum');
  if(se){ se.textContent=sum+'%'; se.style.color = sum===100?'var(--pos)':'var(--warn)'; }
  const hint=document.getElementById('allocHint');
  if(hint) hint.textContent = sum===100?'Balanced to 100%.':'The ideal total is 100%. Adjust so it adds up.';
}

/* ---- Theme ---- */
const THEME_KEY = 'pfa.theme';
const THEME_BG = { light: '#f4f5f9', dark: '#0b0e14' };

export function getTheme(){
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

/**
 * The picked theme wins over the device's, both ways. Kept per device — a
 * phone in dark mode and a laptop in light are both reasonable at once.
 */
export function setTheme(mode){
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem(THEME_KEY, mode);
    else localStorage.removeItem(THEME_KEY);
  } catch { /* private window: it still applies for this visit */ }
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const own = (m.getAttribute('media') || '').includes('dark') ? THEME_BG.dark : THEME_BG.light;
    m.setAttribute('content', THEME_BG[mode] || own);
  });
  if (activeView === 'settings') render();
}

/* ---- The phone's "more" sheet: what does not fit in the tab bar ---- */
export function openMore(){
  const saved = document.getElementById('lastSaved');
  openModal(`
    <div class="more-head">
      <span class="avatar lg">${avatarInner()}</span>
      <div class="me-text">
        <span class="me-name">${esc(displayName() || 'Your finances')}</span>
        ${user.email ? `<span class="muted" style="font-size:13px">${esc(user.email)}</span>` : ''}
        ${saved?.textContent ? `<span class="save-state" data-state="${esc(saved.dataset.state || 'saved')}">${esc(saved.textContent)}</span>` : ''}
      </div>
    </div>
    <div class="more-list">
      <button type="button" onclick="closeModal();setView('goals')"><span class="gi tone-savings">${icon('target')}</span>Goals</button>
      <button type="button" onclick="closeModal();setView('annual')"><span class="gi tone-invest">${icon('chart')}</span>Year in review</button>
      <button type="button" onclick="closeModal();setView('settings')"><span class="gi tone-wants">${icon('settings')}</span>Settings</button>
    </div>
    ${user.email ? `<button class="btn ghost block" type="button" onclick="doSignOut()">${icon('logout')}Sign out</button>` : ''}
  `);
}

/* ---------------- Mutations ---------------- */
export function updIncome(v){ getMonth(currentMonth).income = +v||0; save(); softRefreshAdvisor(); }
export function updInvest(v){ getMonth(currentMonth).invest = +v||0; save(); softRefreshAdvisor(); }
export function updCarryover(v){
  const avail = compute(currentMonth).carryAvailable;
  getMonth(currentMonth).usedCarryover = Math.max(0, Math.min(+v||0, avail));
  save(); softRefreshAdvisor();
}
export function useCarryover(v){ getMonth(currentMonth).usedCarryover = Math.max(0,+v||0); save(); render(); }
export function updItem(kind,i,field,v){
  const arr = getMonth(currentMonth)[kind];
  if(arr[i]) {
    arr[i][field] = field==='amount'? (+v||0) : v;
    save();
    if(field==='amount') refreshLine(kind,i);
    softRefreshAdvisor();
  }
}
export function addItem(kind){
  const arr = getMonth(currentMonth)[kind];
  if(kind==='recurring'||kind==='oneTime') arr.push({id:uid(),name:'',amount:0,cat:'wants'});
  else arr.push({id:uid(),name:'',amount:0});
  save(); render();
}
export function delItem(kind,i){ getMonth(currentMonth)[kind].splice(i,1); save(); render(); }
export function updContribution(gid,v){ getMonth(currentMonth).contributions[gid] = +v||0; save(); softRefreshAdvisor(); }

/** A planned amount changed: its line's spent meter measures against it. */
function refreshLine(kind,i){
  const el = document.querySelector(`[data-line="${kind}:${i}"]`);
  if(!el || !el.classList.contains('has-spent')) return;
  const it = getMonth(currentMonth)[kind][i];
  const act = actualsFor(currentMonth, render);
  const planned = +it.amount||0;
  el.classList.remove('li-over','li-close');
  const oc = overClass(planned, act.byLine[it.id]||0).trim();
  if(oc) el.classList.add(oc);
  const cell = el.querySelector('.line-spent');
  if(cell) cell.outerHTML = spentCell(act, it.id, planned);
}

/* refresh the plan's figures without losing input focus */
function softRefreshAdvisor(){
  if(activeView!=='plan'){ render(); return; }
  const c = compute(currentMonth);
  const adv = document.querySelector('.advisor .card');
  if(adv) adv.innerHTML = advisorHtml(c);
  const sum = document.getElementById('planSummary');
  if(sum) sum.innerHTML = planSummaryInner(c);
  const sticky = document.getElementById('planSticky');
  if(sticky) sticky.innerHTML = planStickyInner(c);
  const un = document.getElementById('usedNote');
  if(un) un.innerHTML = usedNote(c);
  const sn = document.getElementById('surplusNote');
  if(sn) sn.innerHTML = surplusNote(c);
  const totals = groupTotals(getMonth(currentMonth), c);
  document.querySelectorAll('[data-total]').forEach((el) => { el.textContent = money(totals[el.dataset.total] ?? 0); });
}

export function copyMonth(){
  const prev = shiftMonth(currentMonth,-1);
  const p = state.months[prev];
  if(!p){ toast("No data for the previous month"); return; }
  const cur = getMonth(currentMonth);
  cur.income = p.income;
  cur.invest = p.invest;
  cur.extraIncome = p.extraIncome.map(x=>({...x,id:uid()}));
  cur.bills = p.bills.map(x=>({...x,id:uid()}));
  cur.recurring = p.recurring.map(x=>({...x,id:uid()}));
  cur.oneTime = []; // one-time items are not copied
  cur.contributions = {...p.contributions};
  cur.usedCarryover = 0;
  save(); render(); toast("Copied from "+monthLabel(prev));
}
export function clearMonth(){
  state.months[currentMonth] = blankMonth(); save(); render(); toast("Month reset");
}
export function gotoMonth(key){ currentMonth=key; setView('plan'); }
export function stepYear(d){ annualYear+=d; render(); }

/* Goals */
export function goalModal(id){
  const g = id? state.goals.find(x=>x.id===id) : {name:'',target:'',saved:0,monthly:'',deadline:''};
  openModal(`
    <h3>${id?'Edit goal':'New savings goal'}</h3>
    <p class="sheet-sub">${id ? 'Change the target, what is saved so far, or the monthly suggestion.' : 'What are you saving for? The advisor suggests how much to set aside each month.'}</p>
    <div class="field"><label for="g_name">Name</label><input class="inp" id="g_name" value="${esc(g.name)}" placeholder="e.g. Emergency fund"></div>
    <div class="tx-2col">
      <div class="field"><label for="g_target">Target amount</label><input class="inp" id="g_target" type="number" inputmode="numeric" value="${g.target||''}" placeholder="0"></div>
      <div class="field"><label for="g_saved">Already saved</label><input class="inp" id="g_saved" type="number" inputmode="numeric" value="${g.saved||''}" placeholder="0"></div>
    </div>
    <div class="tx-2col">
      <div class="field"><label for="g_monthly">Monthly contribution</label><input class="inp" id="g_monthly" type="number" inputmode="numeric" value="${g.monthly||''}" placeholder="Optional"></div>
      <div class="field"><label for="g_deadline">Target date</label><input class="inp" id="g_deadline" value="${esc(g.deadline||'')}" placeholder="e.g. Dec 2026"></div>
    </div>
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="saveGoal('${id||''}')">Save</button>
    </div>
  `);
}
export function saveGoal(id){
  const get = x=>document.getElementById(x).value;
  const name=get('g_name').trim();
  if(!name){ toast("Give the goal a name"); return; }
  const obj = {
    name, target:+get('g_target')||0, saved:+get('g_saved')||0,
    monthly:+get('g_monthly')||0, deadline:get('g_deadline').trim()
  };
  if(id){ Object.assign(state.goals.find(x=>x.id===id),obj); }
  else { state.goals.push({id:uid(),...obj}); }
  save(); closeModal(); render(); toast("Goal saved");
}
export function delGoal(id){
  if(!confirm("Delete this goal?")) return;
  state.goals = state.goals.filter(x=>x.id!==id);
  Object.values(state.months).forEach(m=>{ delete m.contributions[id]; });
  save(); render();
}
export function addToGoal(id){
  const g = state.goals.find(x=>x.id===id);
  openModal(`
    <h3>Log savings</h3>
    <p class="sheet-sub"><span class="gi tone-${tintOf(g)}" style="width:22px;height:22px;border-radius:7px">${icon(goalIconName(g), { size: 13 })}</span><span>${esc(g.name)} · ${money(g.saved)} of ${money(g.target)} so far</span></p>
    <div class="amount-field">
      <span class="amount-cur" style="display:grid;place-items:center;padding:0 12px;background:var(--surface)">₡</span>
      <input class="amount-inp" id="add_amt" type="number" inputmode="numeric" placeholder="0" aria-label="Amount to add">
    </div>
    <div class="actions">
      <span></span>
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="confirmAddGoal('${id}')">Add</button>
    </div>`);
}
export function confirmAddGoal(id){
  const amt = +document.getElementById('add_amt').value||0;
  const g = state.goals.find(x=>x.id===id);
  g.saved = Math.max(0, g.saved + amt);
  save(); closeModal(); render(); toast("Savings logged");
}

/* Settings */
export function updAlloc(k,v){ state.settings.alloc[k] = +v||0; save(); }
export function setAlloc(n,w,s){ state.settings.alloc={needs:n,wants:w,savings:s}; save(); render(); toast(`Strategy ${n}/${w}/${s}`); }

export function exportData(){
  const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`finance-backup-${monthKey()}.json`; a.click();
}
export function importData(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ try{ const s=JSON.parse(r.result); if(s.months){ setState(s); if(!state.settings) state.settings={alloc:{...DEFAULT_ALLOC}}; save(); render(); toast("Data imported"); } }catch(e){ toast("Invalid file"); } };
  r.readAsText(f);
}
export function resetAll(){
  if(!confirm("This will erase ALL your data. Continue?")) return;
  setState({ months:{}, goals:[], settings:{ alloc:{...DEFAULT_ALLOC}, name:"" } });
  render(); toast("Data erased");
}

/* Sheets + toast */
export function openModal(html){
  const box = document.getElementById('modalBox');
  box.innerHTML = `<button class="iconbtn sm plain sheet-close" type="button" onclick="closeModal()" aria-label="Close">${icon('x')}</button>${html}`;
  box.scrollTop = 0;
  document.getElementById('modalBg').classList.add('show');
  document.body.classList.add('sheet-open');
}
export function closeModal(){
  document.getElementById('modalBg').classList.remove('show');
  document.body.classList.remove('sheet-open');
}
document.getElementById('modalBg').addEventListener('click',e=>{ if(e.target.id==='modalBg') closeModal(); });
let toastT;
export function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2400); }

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* currentMonth and annualYear are module-local; the header controls reach them
   through these rather than writing an imported binding. */
export function setCurrentMonth(key){ currentMonth = key; render(); }
export function shiftCurrentMonth(delta){ currentMonth = shiftMonth(currentMonth, delta); render(); }
export function getCurrentMonth(){ return currentMonth; }
