import { config } from './config.js';
import { authorizeCost, finalizeCost, cancelReservation, householdBudget } from './finance.js';
import { safeString, round2 } from './utils.js';

function estimateTokens(text){ return Math.max(1,Math.ceil(String(text).length/3.6)); }
function tokenCostCents(inputTokens,outputTokens){
  const euros=(inputTokens/1_000_000)*config.openaiInputEurPerMTok + (outputTokens/1_000_000)*config.openaiOutputEurPerMTok;
  return euros*100;
}
function extractText(r){
  if(typeof r.output_text==='string') return r.output_text;
  for(const item of r.output||[]) for(const c of item.content||[]) if(c.type==='output_text' && c.text) return c.text;
  return '';
}
function fallback({kind,topic,ageBand}){
  const t=safeString(topic,120)||'ce sujet';
  if(kind==='culture') return `Relie d’abord ${t} à un repère que tu connais déjà. Cherche ensuite une idée essentielle, explique-la avec tes mots, puis essaie de la retrouver demain sans regarder.`;
  if(kind==='method') return `Pour ${t}, commence par vérifier les prérequis. Travaille une petite unité, ferme le support et récupère l’idée de mémoire. Corrige immédiatement, puis reviens dessus plus tard avec un intervalle plus long.`;
  return `Objectif : ${t}. 1) Dis ce que tu sais déjà. 2) Travaille une seule étape. 3) Explique-la sans regarder. 4) Vérifie. 5) Reviens sur les erreurs plutôt que de tout recommencer. Adaptation prévue pour ${ageBand||'ton âge'}.`;
}

export async function generateEducationalText({householdId,kind='method',topic,ageBand='9-12',context=''}){
  const budget=householdBudget(householdId);
  if(!config.openaiKey || budget.tier==='blocked') return {text:fallback({kind,topic,ageBand}),source:'structured-fallback',budget};
  const maxOutput = budget.tier==='red'?180:budget.tier==='amber'?260:420;
  const input=`Type: ${safeString(kind,30)}\nSujet: ${safeString(topic,240)}\nÂge: ${safeString(ageBand,20)}\nContexte pédagogique: ${safeString(context,1200)}`;
  const estimated=tokenCostCents(estimateTokens(input)+220,maxOutput);
  const auth=authorizeCost(householdId,{estimatedCents:Math.max(0.01,estimated),operation:`ai:${kind}`,metadata:{model:config.openaiModel,tier:budget.tier}});
  if(!auth.allowed) return {text:fallback({kind,topic,ageBand}),source:'budget-fallback',budget:auth.budget};
  try {
    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',headers:{'authorization':`Bearer ${config.openaiKey}`,'content-type':'application/json'},
      body:JSON.stringify({
        model:config.openaiModel, store:false, max_output_tokens:maxOutput,
        instructions:`Tu es le moteur pédagogique ORBITA. Réponds en français, de façon concise, exacte et adaptée à l'âge. Tu aides à apprendre, pas à faire les devoirs à la place de l'enfant. Structure toujours: objectif observable, prérequis, meilleure méthode, action courte, preuve de maîtrise. N'invente pas de diagnostic médical ou de talent naturel. Si une adaptation d'accessibilité est utile, formule-la fonctionnellement.`,
        input, safety_identifier:`hh_${householdId.slice(-12)}`
      })
    });
    if(!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data=await response.json();
    const inputTokens=Number(data.usage?.input_tokens||estimateTokens(input));
    const outputTokens=Number(data.usage?.output_tokens||estimateTokens(extractText(data)));
    const actual=Math.max(0.001,tokenCostCents(inputTokens,outputTokens));
    finalizeCost(auth.ledgerId,actual,{inputTokens,outputTokens,responseId:data.id});
    return {text:extractText(data)||fallback({kind,topic,ageBand}),source:'openai',model:data.model||config.openaiModel,costCents:round2(actual),budget:householdBudget(householdId)};
  } catch(e){
    cancelReservation(auth.ledgerId,String(e.message).slice(0,120));
    return {text:fallback({kind,topic,ageBand}),source:'error-fallback',error:e.message,budget:householdBudget(householdId)};
  }
}
