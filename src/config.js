import path from 'node:path';

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: num('PORT', 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-this-secret-before-production',
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || './data/orbita.sqlite'),
  stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceBase: process.env.STRIPE_PRICE_BASE || '',
  stripePriceExtra: process.env.STRIPE_PRICE_EXTRA_CHILD || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
  openaiInputEurPerMTok: num('OPENAI_INPUT_EUR_PER_MTOK', 0.30),
  openaiOutputEurPerMTok: num('OPENAI_OUTPUT_EUR_PER_MTOK', 1.50),
  aiCapRatio: Math.min(0.20, Math.max(0.01, num('AI_HARD_CAP_RATIO', 0.12))),
  variableCapRatio: Math.min(0.30, Math.max(0.05, num('VARIABLE_HARD_CAP_RATIO', 0.18))),
  conservativeNetRatio: Math.min(0.90, Math.max(0.50, num('CONSERVATIVE_NET_RATIO', 0.72))),
  aiAbsoluteCapCents: Math.max(50, num('AI_ABSOLUTE_HARD_CAP_CENTS', 600)),
  variableAbsoluteCapCents: Math.max(100, num('VARIABLE_ABSOLUTE_HARD_CAP_CENTS', 1000))
};

export const PRICE_BASE_CENTS = 1990;
export const PRICE_EXTRA_CHILD_CENTS = 590;
export function grossPriceForChildren(children) {
  return PRICE_BASE_CENTS + Math.max(0, Number(children || 0) - 3) * PRICE_EXTRA_CHILD_CENTS;
}
