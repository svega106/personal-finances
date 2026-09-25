/**
 * The charge that exposed this: BAC Spotify, 21:29 on 24 September in Costa
 * Rica, which Postgres hands back as 2026-09-25T03:29Z. It must show under
 * the 24th, the edit sheet must say the 24th, and saving it unchanged must
 * leave it exactly where it was.
 */
import { chromium } from 'playwright';
const SPOTIFY = {
  id:'t9', extId:'bac:9654:157481:r1', kind:'expense',
  postedAt:'2026-09-25T03:29:00+00:00',           // 21:29 CR on the 24th
  merchant:'SPOTIFY', merchantRaw:'SPOTIFY', amount:5900, currency:'CRC',
  amountCrc:5900, accountId:'c1', cat:'wants', scope:'personal',
  status:'settled', reviewed:true, source:'email',
};
const SEED = {
  months:{'2026-09':{income:1850000,extraIncome:[],bills:[],recurring:[],oneTime:[],contributions:{},invest:0,usedCarryover:0}},
  goals:[], settings:{alloc:{needs:50,wants:30,savings:20},name:'Sebas'},
  accounts:[{id:'c1',label:'BAC AMEX Colones',type:'card',currency:'CRC',scope:'personal',issuer:'bac',last4:'9654'}],
  transactions:[SPOTIFY,
    {id:'t8',extId:'bac:9654:1:r0',kind:'expense',postedAt:'2026-09-24T18:00:00+00:00',
     merchant:'Cafe',merchantRaw:'CAFE',amount:2500,currency:'CRC',amountCrc:2500,
     accountId:'c1',cat:'wants',scope:'personal',status:'settled',reviewed:true,source:'email'}],
};
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport:{width:1440,height:900} });
const errs=[]; const saved=[];
p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.exposeFunction('__saved',(t)=>saved.push(JSON.parse(t)));
await p.addInitScript((seed)=>{
  const c=v=>JSON.parse(JSON.stringify(v)); const store=c(seed);
  window.__REPO__={
    loadAll:async()=>({months:c(store.months),goals:[],settings:c(store.settings)}),
    saveBudget:async()=>{},deleteBudget:async()=>{},saveGoals:async()=>{},saveSettings:async()=>{},
    listAccounts:async()=>c(store.accounts),listRules:async()=>[],listFxRates:async()=>[],saveFxRate:async()=>{},
    listTransactions:async({from,to})=>c(store.transactions).filter(t=>new Date(t.postedAt)>=new Date(from)&&new Date(t.postedAt)<new Date(to)),
    listWorkCharges:async()=>[],
    upsertTransaction:async(t)=>{ window.__saved(JSON.stringify(t));
      const i=store.transactions.findIndex(x=>x.id===t.id); if(i>=0)store.transactions[i]={...t}; return c(t); },
    deleteTransaction:async()=>{},countTransactions:async()=>0,
    listAccountBalances:async()=>[],listSnapshots:async()=>[],saveSnapshot:async()=>{},
    deleteSnapshot:async()=>{},upsertAccount:async(a)=>a,archiveAccount:async()=>{},
  };
  const F=new Date('2026-09-24T22:00:00-06:00').getTime(),R=Date;
  Date=class extends R{constructor(...a){return a.length?new R(...a):new R(F);}static now(){return F;}};
  Date.prototype=R.prototype;
}, SEED);
await p.goto('http://localhost:4173/',{waitUntil:'networkidle'});
await p.waitForFunction(()=>typeof window.setView==='function',null,{timeout:15000});
await p.evaluate(()=>window.setView('transactions'));
await p.waitForFunction(()=>document.querySelector('.tx-row'),null,{timeout:8000});

const out = {};
out['grouped under the 24th'] = await p.evaluate(()=>{
  const heads=[...document.querySelectorAll('.tx-day, .tx-day-head, h4, .day-head')].map(e=>e.textContent.trim());
  return document.body.textContent;
}).then(t=>/Thu, Sep 24/.test(t) && !/Fri, Sep 25/.test(t));
out['time shown as 9:29 PM'] = await p.evaluate(()=>/09:29\s*PM/.test(document.body.textContent));

await p.evaluate(()=>{
  const r=[...document.querySelectorAll('.tx-row')].find(x=>x.textContent.includes('SPOTIFY')); r.click();
});
await p.waitForSelector('#tx_date',{timeout:5000});
const shown = await p.evaluate(()=>document.getElementById('tx_date').value);
out['edit sheet shows 2026-09-24'] = shown === '2026-09-24';
out['  (it showed)'] = shown;

await p.click('#tx_save');
await p.waitForFunction(()=>!document.getElementById('modalBg').classList.contains('show'),null,{timeout:8000});
out['saving unchanged keeps the day'] = saved.length===1 &&
  new Date(saved[0].postedAt).toLocaleDateString('en-CA',{timeZone:'America/Costa_Rica'})==='2026-09-24';
out['  (saved as)'] = saved[0]?.postedAt;
out['an untouched date keeps the real time'] = saved[0]?.postedAt === '2026-09-25T03:29:00+00:00';

// And changing the date on purpose still works.
await p.evaluate(()=>{
  const r=[...document.querySelectorAll('.tx-row')].find(x=>x.textContent.includes('SPOTIFY')); r.click();
});
await p.waitForSelector('#tx_date',{timeout:5000});
await p.fill('#tx_date','2026-09-22');
await p.click('#tx_save');
await p.waitForFunction(()=>!document.getElementById('modalBg').classList.contains('show'),null,{timeout:8000});
out['a deliberate date change is obeyed'] =
  new Date(saved[1]?.postedAt).toLocaleDateString('en-CA',{timeZone:'America/Costa_Rica'})==='2026-09-22';
out['still under the 24th after saving'] =
  await p.evaluate(()=>/Thu, Sep 24/.test(document.body.textContent) && !/Fri, Sep 25/.test(document.body.textContent));
out['pageErrors'] = errs.length?errs:'none';
console.log(JSON.stringify(out,null,1));
await b.close();
