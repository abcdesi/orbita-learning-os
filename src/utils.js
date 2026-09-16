import crypto from 'node:crypto';
import { config } from './config.js';

export const now = () => new Date().toISOString();
export const id = (prefix='id') => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

export function json(res, status, data, headers={}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
export function text(res, status, body, contentType='text/plain; charset=utf-8', headers={}) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
export async function readBody(req, limit=1_000_000) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size += chunk.length; if (size>limit) throw Object.assign(new Error('Payload too large'), {status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('JSON invalide'), {status:400}); }
}
export function normalizeEmail(email='') { return String(email).trim().toLowerCase(); }
export function safeString(v, max=500) { return String(v ?? '').trim().slice(0,max); }

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored='') {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const a = Buffer.from(hex, 'hex');
  const b = crypto.scryptSync(password, salt, 64);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

function b64url(v) { return Buffer.from(v).toString('base64url'); }
export function signSession(payload) {
  const data = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifySession(token='') {
  const [data,sig] = token.split('.'); if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  const a=Buffer.from(sig), b=Buffer.from(expected); if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try { const p=JSON.parse(Buffer.from(data,'base64url').toString('utf8')); if (p.exp && Date.now()>p.exp) return null; return p; } catch { return null; }
}
export function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(Boolean).map(v=>{const i=v.indexOf('='); return [decodeURIComponent(v.slice(0,i)), decodeURIComponent(v.slice(i+1))];}));
}
export function sessionCookie(token, clear=false) {
  const maxAge = clear ? 0 : 60*60*24*30;
  return `orbita_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.nodeEnv==='production'?'; Secure':''}`;
}
export function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
export function round2(n){ return Math.round(n*100)/100; }
