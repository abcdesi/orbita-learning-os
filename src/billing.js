import crypto from 'node:crypto';
import { config, PRICE_BASE_CENTS, PRICE_EXTRA_CHILD_CENTS } from './config.js';
import { db, childrenCount } from './db.js';

async function stripe(path,{method='GET',params}={}){
  if(!config.stripeSecret) throw Object.assign(new Error('Stripe non configuré'),{status:503});
  const headers={authorization:`Bearer ${config.stripeSecret}`}; let body;
  if(params){ const form=new URLSearchParams(); for(const [k,v] of Object.entries(params)) if(v!==undefined && v!==null) form.append(k,String(v)); body=form; headers['content-type']='application/x-www-form-urlencoded'; }
  const r=await fetch(`https://api.stripe.com${path}`,{method,headers,body}); const data=await r.json();
  if(!r.ok) throw Object.assign(new Error(data.error?.message||`Stripe ${r.status}`),{status:502});
  return data;
}

export async function createCheckout({household,user}){
  if(!config.stripeSecret || !config.stripePriceBase) return {configured:false};
  const n=childrenCount(household.id), extra=Math.max(0,n-3);
  const p={mode:'subscription',success_url:`${config.appUrl}/?billing=success`,cancel_url:`${config.appUrl}/?billing=cancelled`,customer_email:user.email,'automatic_tax[enabled]':'true','line_items[0][price]':config.stripePriceBase,'line_items[0][quantity]':1,'metadata[household_id]':household.id,'subscription_data[metadata][household_id]':household.id};
  if(extra>0){ if(!config.stripePriceExtra) throw Object.assign(new Error('STRIPE_PRICE_EXTRA_CHILD manquant'),{status:503}); p['line_items[1][price]']=config.stripePriceExtra; p['line_items[1][quantity]']=extra; }
  const s=await stripe('/v1/checkout/sessions',{method:'POST',params:p}); return {configured:true,url:s.url,id:s.id};
}

export function verifyStripeWebhook(raw,signature){
  if(!config.stripeWebhookSecret) throw new Error('Webhook secret absent');
  const parts=Object.fromEntries(String(signature||'').split(',').map(x=>x.split('=')));
  const t=parts.t, v1=parts.v1; if(!t||!v1) throw new Error('Signature Stripe invalide');
  if(Math.abs(Date.now()/1000-Number(t))>300) throw new Error('Signature Stripe expirée');
  const expected=crypto.createHmac('sha256',config.stripeWebhookSecret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  const a=Buffer.from(v1,'hex'),b=Buffer.from(expected,'hex'); if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Signature Stripe invalide');
  return JSON.parse(raw.toString('utf8'));
}

export function processStripeEvent(event){
  const o=event.data?.object||{};
  if(event.type==='checkout.session.completed'){
    const hid=o.metadata?.household_id; if(hid) db.prepare(`UPDATE households SET plan_status='active',stripe_customer_id=?,stripe_subscription_id=? WHERE id=?`).run(o.customer||null,o.subscription||null,hid);
  }
  if(event.type==='customer.subscription.deleted') db.prepare(`UPDATE households SET plan_status='cancelled' WHERE stripe_subscription_id=?`).run(o.id);
  if(event.type==='customer.subscription.updated') db.prepare(`UPDATE households SET plan_status=? WHERE stripe_subscription_id=?`).run(['active','trialing'].includes(o.status)?'active':o.status,o.id);
  if(event.type==='invoice.paid'){
    const amount=Number(o.amount_paid||0); const conservative=Math.floor(amount*config.conservativeNetRatio);
    if(o.customer) db.prepare(`UPDATE households SET plan_status='active',net_collected_cents=?,billing_cycle_start=? WHERE stripe_customer_id=?`).run(conservative,new Date().toISOString(),o.customer);
  }
}

export async function syncChildQuantity(household){
  if(!config.stripeSecret || !household.stripe_subscription_id || !config.stripePriceExtra) return {configured:false};
  const sub=await stripe(`/v1/subscriptions/${household.stripe_subscription_id}`); const items=sub.items?.data||[];
  const extraQty=Math.max(0,childrenCount(household.id)-3); const extra=items.find(i=>i.price?.id===config.stripePriceExtra);
  const p={proration_behavior:'create_prorations'};
  if(extra){ p['items[0][id]']=extra.id; if(extraQty===0) p['items[0][deleted]']='true'; else p['items[0][quantity]']=extraQty; }
  else if(extraQty>0){ p['items[0][price]']=config.stripePriceExtra; p['items[0][quantity]']=extraQty; }
  else return {configured:true,changed:false};
  await stripe(`/v1/subscriptions/${household.stripe_subscription_id}`,{method:'POST',params:p}); return {configured:true,changed:true,extraQty};
}

export const catalogPricing={baseCents:PRICE_BASE_CENTS,baseChildren:3,extraChildCents:PRICE_EXTRA_CHILD_CENTS};
