/**
 * Charts, drawn at the size they are shown.
 *
 * A view is a template string that does not know how wide it will be, so a
 * chart is left as an empty container holding a key to its data, and drawn
 * here once it is in the page — at its real width, so its text stays the
 * size it was set in instead of scaling with the drawing.
 *
 * Every chart has a hover readout, and the same readout on keyboard focus.
 * None is the only way to read a value: the figures are also in the card
 * around the chart, or in the list or table beside it.
 */
import { money } from './state.js';
import { crDayLabel } from './cr-date.js';

const specs = new Map();
let seq = 0;

/** Called at the start of every render: the old containers are gone. */
export function resetCharts() { specs.clear(); }

/** A placeholder for a chart, to be drawn by `drawCharts` once it is in the page. */
export function chartSlot(kind, data, { height = 200, label = '' } = {}) {
  seq += 1;
  const id = `chart${seq}`;
  specs.set(id, { kind, data, height });
  return `<div class="chart" data-cid="${id}" style="height:${height}px" tabindex="0" role="img" aria-label="${label.replace(/"/g, '&quot;')}"></div>`;
}

export function drawCharts(root = document) {
  root.querySelectorAll('.chart[data-cid]').forEach((el) => {
    const spec = specs.get(el.dataset.cid);
    if (!spec || !el.isConnected) return;
    if (spec.kind === 'pace') drawPace(el, spec);
    else if (spec.kind === 'bars') drawBars(el, spec);
  });
  root.querySelectorAll('.donut:not([data-wired])').forEach(wireDonut);
}

if (typeof window !== 'undefined') {
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => drawCharts(document), 150);
  });
}

/* ----------------------------------------------------------------- scale */

/** A round step that puts three to five gridlines across `span`. */
function niceStep(span, target = 4) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** Axis labels are short: ₡1.5M, ₡500k. The exact figure is in the readout. */
export function compact(v) {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}₡${+(a / 1e6).toFixed(a % 1e6 ? 1 : 0)}M`;
  if (a >= 1e3) return `${sign}₡${Math.round(a / 1e3)}k`;
  return `${sign}₡${Math.round(a)}`;
}

const f1 = (n) => n.toFixed(1);

/* ------------------------------------------------------------ tooltips */

/**
 * Fills the readout with plain text nodes. Labels here are ours, but a
 * readout is exactly where a merchant or account name could one day end up.
 */
function fillTip(tip, head, rows) {
  tip.replaceChildren();
  const h = document.createElement('div');
  h.className = 'tip-head';
  h.textContent = head;
  tip.append(h);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const key = document.createElement('span');
    key.className = `tip-key${r.dashed ? ' dashed' : ''}`;
    if (r.color) key.style.borderTopColor = r.color;
    const b = document.createElement('b');
    b.textContent = r.value;
    const label = document.createElement('span');
    label.textContent = r.label;
    if (r.key !== false) row.append(key);
    row.append(b, label);
    tip.append(row);
  }
}

/** Keeps the readout inside the chart, above the point it describes. */
function placeTip(el, tip, x, y) {
  tip.classList.add('show');
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(x - w / 2, 0), el.clientWidth - w);
  const top = Math.max(y - h - 12, -8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/* ------------------------------------------------------------ pace line */

/**
 * Spending so far this month, against an even pace to the plan.
 *
 * The pace line is dashed because it is a target, not data. The actual line
 * starts at zero on the first and steps up day by day; it stops at today.
 */
function drawPace(el, { data: d, height: H }) {
  const W = Math.max(260, el.clientWidth);
  const pad = { l: 50, r: 16, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const last = d.cum.length ? d.cum[d.cum.length - 1] : 0;
  const max = Math.max(d.planned, last, 1);
  const step = niceStep(max);
  const top = Math.ceil((max * 1.04) / step) * step;
  const X = (day) => pad.l + (day / d.days) * iw;
  const Y = (v) => pad.t + ih - (v / top) * ih;
  const paceAt = (day) => (d.planned * day) / d.days;

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  for (let v = 0; v <= top + step / 2; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    s += `<line class="${v === 0 ? 'base' : 'gl'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    s += `<text class="ax" x="${pad.l - 10}" y="${y + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  const ticks = [1, 8, 15, 22];
  if (d.days - 22 >= 4) ticks.push(d.days);
  for (const day of ticks) {
    s += `<text class="ax" x="${f1(X(day))}" y="${H - 7}" text-anchor="middle">${day}</text>`;
  }
  if (d.planned > 0) {
    s += `<line class="pace" x1="${f1(X(0))}" y1="${f1(Y(0))}" x2="${f1(X(d.days))}" y2="${f1(Y(d.planned))}"/>`;
  }
  if (d.cum.length) {
    const pts = [[X(0), Y(0)], ...d.cum.map((v, i) => [X(i + 1), Y(v)])];
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f1(x)},${f1(y)}`).join('');
    const [lx, ly] = pts[pts.length - 1];
    s += `<path class="area" d="${line}L${f1(lx)},${f1(Y(0))}L${f1(X(0))},${f1(Y(0))}Z"/>`;
    s += `<path class="actual" d="${line}"/>`;
    s += `<circle class="dot" cx="${f1(lx)}" cy="${f1(ly)}" r="4.5"/>`;
  }
  s += `<line class="xhair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
  s += '<circle class="dot hov" r="4.5" visibility="hidden"/>';
  s += '</svg><div class="tip"></div>';
  el.innerHTML = s;

  const svg = el.querySelector('svg');
  const xhair = svg.querySelector('.xhair');
  const hov = svg.querySelector('.hov');
  const tip = el.querySelector('.tip');

  const show = (day) => {
    const x = X(day);
    xhair.setAttribute('x1', f1(x));
    xhair.setAttribute('x2', f1(x));
    xhair.setAttribute('visibility', 'visible');
    const rows = [];
    const spent = day <= d.cum.length ? d.cum[day - 1] : null;
    if (spent != null) {
      hov.setAttribute('cx', f1(x));
      hov.setAttribute('cy', f1(Y(spent)));
      hov.setAttribute('visibility', 'visible');
      rows.push({ value: money(spent), label: 'spent by then' });
    } else {
      hov.setAttribute('visibility', 'hidden');
    }
    if (d.planned > 0) rows.push({ value: money(paceAt(day)), label: 'even pace', dashed: true });
    const key = `${d.month}-${String(day).padStart(2, '0')}`;
    fillTip(tip, crDayLabel(key), rows);
    placeTip(el, tip, x, Y(Math.max(spent ?? 0, d.planned > 0 ? paceAt(day) : 0)));
    el.dataset.day = String(day);
  };
  const hide = () => {
    xhair.setAttribute('visibility', 'hidden');
    hov.setAttribute('visibility', 'hidden');
    tip.classList.remove('show');
  };
  const dayAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const day = Math.round(((clientX - r.left - pad.l) / iw) * d.days);
    return Math.min(d.days, Math.max(1, day));
  };

  svg.addEventListener('pointermove', (e) => show(dayAt(e.clientX)));
  svg.addEventListener('pointerdown', (e) => show(dayAt(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  el.onfocus = () => show(d.cum.length || 1);
  el.onblur = hide;
  el.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = Number(el.dataset.day) || d.cum.length || 1;
    show(Math.min(d.days, Math.max(1, now + (e.key === 'ArrowRight' ? 1 : -1))));
  };
}

/* ----------------------------------------------------------- month bars */

/** A column with a rounded data end and a square foot on the baseline. */
function column(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, h, w / 2);
  if (y1 <= y0) {
    return `M${f1(x)},${f1(y0)}V${f1(y1 + r)}Q${f1(x)},${f1(y1)} ${f1(x + r)},${f1(y1)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y1)} ${f1(x + w)},${f1(y1 + r)}V${f1(y0)}Z`;
  }
  return `M${f1(x)},${f1(y0)}V${f1(y1 - r)}Q${f1(x)},${f1(y1)} ${f1(x + r)},${f1(y1)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y1)} ${f1(x + w)},${f1(y1 - r)}V${f1(y0)}Z`;
}

/**
 * What each month added to (or took from) net worth. Above the line is a
 * surplus, below it a deficit, so the sign reads from position before colour.
 */
function drawBars(el, { data: d, height: H }) {
  const W = Math.max(260, el.clientWidth);
  const pad = { l: 50, r: 8, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const vals = d.values.map((v, i) => (d.active[i] ? v : 0));
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const step = niceStep(Math.max(hi - lo, 1));
  const top = Math.max(step, Math.ceil(hi / step) * step);
  const bottom = Math.floor(lo / step) * step;
  const Y = (v) => pad.t + ((top - v) / (top - bottom)) * ih;

  const n = vals.length;
  const band = iw / n;
  const bw = Math.min(24, band * 0.58);
  const short = W < 460;

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  for (let v = bottom; v <= top + step / 2; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    s += `<line class="${v === 0 ? 'base' : 'gl'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    s += `<text class="ax" x="${pad.l - 10}" y="${y + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  const y0 = Y(0);
  vals.forEach((v, i) => {
    const x = pad.l + band * i + (band - bw) / 2;
    if (!d.active[i]) {
      s += `<rect class="bar bar-empty" data-i="${i}" x="${f1(x)}" y="${f1(y0 - 2)}" width="${f1(bw)}" height="3" rx="1.5"/>`;
    } else {
      const cls = v >= 0 ? 'bar-pos' : 'bar-neg';
      const y1 = v === 0 ? y0 - 1 : Y(v);
      s += `<path class="bar ${cls}" data-i="${i}" d="${column(x, bw, y0, y1)}"/>`;
    }
    const label = short ? d.labels[i][0] : d.labels[i];
    s += `<text class="ax" x="${f1(pad.l + band * i + band / 2)}" y="${H - 7}" text-anchor="middle">${label}</text>`;
    s += `<rect class="bar-hit" data-i="${i}" x="${f1(pad.l + band * i)}" y="${pad.t}" width="${f1(band)}" height="${ih}"/>`;
  });
  s += '</svg><div class="tip"></div>';
  el.innerHTML = s;

  const svg = el.querySelector('svg');
  const tip = el.querySelector('.tip');
  const bars = [...svg.querySelectorAll('.bar')];

  const show = (i) => {
    bars.forEach((b) => b.classList.toggle('dim', Number(b.dataset.i) !== i));
    const v = vals[i];
    const rows = d.active[i]
      ? [{ value: `${v >= 0 ? '+' : ''}${money(v)}`, label: v >= 0 ? 'added to net worth' : 'taken from net worth',
          color: v >= 0 ? 'var(--pos-mark)' : 'var(--neg-mark)' }]
      : [{ value: 'No plan', label: '', key: false }];
    fillTip(tip, `${d.labels[i]} ${d.year}`, rows);
    placeTip(el, tip, pad.l + band * i + band / 2, Math.min(Y(Math.max(v, 0)), y0));
    el.dataset.i = String(i);
  };
  const hide = () => {
    bars.forEach((b) => b.classList.remove('dim'));
    tip.classList.remove('show');
  };

  svg.querySelectorAll('.bar-hit').forEach((h) => {
    const i = Number(h.dataset.i);
    h.addEventListener('pointerenter', () => show(i));
    h.addEventListener('pointerdown', () => show(i));
  });
  svg.addEventListener('pointerleave', hide);
  el.onfocus = () => show(Number(el.dataset.i) || 0);
  el.onblur = hide;
  el.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = Number(el.dataset.i) || 0;
    show(Math.min(n - 1, Math.max(0, now + (e.key === 'ArrowRight' ? 1 : -1))));
  };
}

/* ----------------------------------------------------------------- donut */

/**
 * A part-to-whole ring, for a handful of categories at a glance. The legend
 * beside it carries every value; hovering a segment shows it in the middle.
 */
export function donut(segs, { value, label, size = 156, stroke = 18 } = {}) {
  const shown = segs.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const r = (size - stroke) / 2;
  const c = size / 2;
  const C = 2 * Math.PI * r;
  const gap = shown.length > 1 ? 2 : 0;
  let offset = 0;
  const arcs = shown.map((s) => {
    const len = (s.value / total) * C;
    const dash = Math.max(0.5, len - gap);
    const pct = Math.round((s.value / total) * 100);
    const arc = `<circle class="seg-arc tone-${s.tone}" cx="${c}" cy="${c}" r="${f1(r)}" fill="none" stroke-width="${stroke}" stroke-dasharray="${f1(dash)} ${f1(C - dash)}" stroke-dashoffset="${f1(-offset)}" data-label="${s.label}" data-value="${money(s.value)}" data-pct="${pct}%"/>`;
    offset += len;
    return arc;
  }).join('');
  const track = shown.length ? '' : `<circle cx="${c}" cy="${c}" r="${f1(r)}" fill="none" stroke="var(--surface-3)" stroke-width="${stroke}"/>`;
  return `
  <div class="donut" data-value="${value}" data-label="${label}">
    <svg width="100%" height="100%" viewBox="0 0 ${size} ${size}" aria-hidden="true">${track}${arcs}</svg>
    <div class="donut-center"><b>${value}</b><span>${label}</span></div>
  </div>`;
}

function wireDonut(el) {
  el.dataset.wired = '1';
  const b = el.querySelector('.donut-center b');
  const span = el.querySelector('.donut-center span');
  const reset = () => {
    el.classList.remove('hovering');
    el.querySelectorAll('.seg-arc').forEach((a) => a.classList.remove('hot'));
    b.textContent = el.dataset.value;
    span.textContent = el.dataset.label;
  };
  el.querySelectorAll('.seg-arc').forEach((arc) => {
    const on = () => {
      el.classList.add('hovering');
      el.querySelectorAll('.seg-arc').forEach((a) => a.classList.toggle('hot', a === arc));
      b.textContent = arc.dataset.value;
      span.textContent = `${arc.dataset.label} · ${arc.dataset.pct}`;
    };
    arc.addEventListener('pointerenter', on);
    arc.addEventListener('pointerdown', on);
    arc.addEventListener('pointerleave', reset);
  });
}
