/**
 * Scoring rules, kept apart from the views.
 *
 * app.js reaches for `document` as it loads, so anything that lives there
 * cannot be imported by a test. These are pure functions over a computed
 * month, and are worth pinning down.
 */

/**
 * Financial health score 0-100.
 *
 * `spent` is real spending so far, when there is any. It is folded in only
 * through `max(planned, spent)`: part-way through a month you have always
 * spent less than you planned, so scoring on actuals alone would hand out a
 * 100 on the 3rd and take it away by the 30th. Reality can therefore make
 * this score worse than the plan suggested, never better — which is the only
 * direction that carries information.
 */
export function healthScore(c, spent=0){
  if(c.income<=0) return {score:0, label:"No data", cls:"warn"};
  let s = 0;
  const sr = c.pSavings;
  s += Math.min(40, sr/20*40);
  const committed = Math.max(c.planned, spent);
  const remaining = c.income - committed;
  if(remaining>=0) s += 35;
  else s += Math.max(0, 35 + (remaining/c.income)*100);
  if(c.pNeeds<=50) s+=25;
  else if(c.pNeeds<=65) s += 25 - (c.pNeeds-50)/15*25;
  else s += 0;
  s = Math.max(0,Math.min(100,Math.round(s)));
  let label,cls;
  if(s>=80){label="Excellent";cls="good";}
  else if(s>=60){label="Healthy";cls="good";}
  else if(s>=40){label="Needs work";cls="warn";}
  else {label="At risk";cls="bad";}
  return {score:s,label,cls};
}
