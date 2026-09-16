import { db, cycleKey, pricingForHousehold } from './db.js';
import { config } from './config.js';
import { id, now, round2 } from './utils.js';

export function householdBudget(householdId){
  const h=db.prepare('SELECT * FROM households WHERE id=?').get(householdId);
  if(!h) throw Object.assign(new Error('Foyer introuvable'),{status:404});
  const pricing=pricingForHousehold(householdId);
  const base = h.net_collected_cents > 0 ? Math.min(h.net_collected_cents, pricing.grossCents) : 0;
  const key=cycleKey();
  const spend=db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN category='ai' THEN MAX(estimated_cents,actual_cents) ELSE 0 END),0) ai,
    COALESCE(SUM(MAX(estimated_cents,actual_cents)),0) total
    FROM cost_ledger WHERE household_id=? AND cycle_key=?`).get(householdId,key);
  const aiCap=Math.min(base*config.aiCapRatio,config.aiAbsoluteCapCents), totalCap=Math.min(base*config.variableCapRatio,config.variableAbsoluteCapCents);
  const aiUsed=Number(spend.ai||0), totalUsed=Number(spend.total||0);
  const ratio=aiCap?aiUsed/aiCap:1;
  const tier=ratio>=1?'blocked':ratio>=0.9?'red':ratio>=0.7?'amber':'green';
  return {
    cycle:key, children:pricing.children, grossCents:pricing.grossCents, budgetBaseCents:base,
    aiCapCents:round2(aiCap), variableCapCents:round2(totalCap), aiUsedCents:round2(aiUsed), variableUsedCents:round2(totalUsed),
    aiRemainingCents:round2(Math.max(0,aiCap-aiUsed)), variableRemainingCents:round2(Math.max(0,totalCap-totalUsed)), tier,
    minimumVariableContributionRatio: round2(1-config.variableCapRatio),
    absoluteAiCapCents: config.aiAbsoluteCapCents, absoluteVariableCapCents: config.variableAbsoluteCapCents
  };
}

export function authorizeCost(householdId,{category='ai',provider='openai',operation='generation',estimatedCents=0,metadata={}}){
  db.exec('BEGIN IMMEDIATE');
  try {
    const b=householdBudget(householdId);
    if(estimatedCents>b.aiRemainingCents && category==='ai') { db.exec('ROLLBACK'); return {allowed:false,reason:'ai_cap',budget:b}; }
    if(estimatedCents>b.variableRemainingCents) { db.exec('ROLLBACK'); return {allowed:false,reason:'variable_cap',budget:b}; }
    const ledgerId=id('cost');
    db.prepare('INSERT INTO cost_ledger(id,household_id,category,provider,operation,estimated_cents,actual_cents,cycle_key,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(ledgerId,householdId,category,provider,operation,estimatedCents,0,b.cycle,JSON.stringify({...metadata,status:'reserved'}),now());
    db.exec('COMMIT');
    return {allowed:true,ledgerId,budget:b};
  } catch(e){ try{db.exec('ROLLBACK')}catch{} throw e; }
}
export function finalizeCost(ledgerId,actualCents,metadata={}){
  const row=db.prepare('SELECT * FROM cost_ledger WHERE id=?').get(ledgerId); if(!row) return;
  const old=JSON.parse(row.metadata_json||'{}');
  db.prepare('UPDATE cost_ledger SET actual_cents=?, metadata_json=? WHERE id=?').run(Math.max(0,actualCents),JSON.stringify({...old,...metadata,status:'final'}),ledgerId);
}
export function cancelReservation(ledgerId,reason='cancelled'){
  const row=db.prepare('SELECT * FROM cost_ledger WHERE id=?').get(ledgerId); if(!row) return;
  const old=JSON.parse(row.metadata_json||'{}');
  db.prepare('UPDATE cost_ledger SET estimated_cents=0, actual_cents=0, metadata_json=? WHERE id=?').run(JSON.stringify({...old,status:'cancelled',reason}),ledgerId);
}
