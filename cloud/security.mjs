const encoder = new TextEncoder();
export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
export async function readJson(request, maxBytes = 49152) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required');
  if (Number(request.headers.get('content-length') || 0) > maxBytes) throw new HttpError(413, 'payload_too_large');
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new HttpError(413, 'payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
}
const hex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) || [], x => parseInt(x, 16));
async function hmacKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function sign(value, secret) { return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value))); }
async function verify(value, signature, secret) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), unhex(signature), encoder.encode(value));
}
export function requireSameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'origin_rejected');
}
export async function installationId(request) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) throw new HttpError(401, 'installation_token_required');
  return sha256(token);
}
export function requireAdminConfigured(env) {
  if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length < 32) throw new HttpError(503, 'admin_not_configured');
}
export async function checkAdmin(request, env) {
  requireAdminConfigured(env);
  const cookie = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('styk_admin='))?.slice(11) || '';
  const [expiry, nonce, signature] = cookie.split('.');
  if (!expiry || !/^[a-f0-9]{32}$/.test(nonce || '') || !Number.isSafeInteger(Number(expiry)) || Number(expiry) < Date.now() || Number(expiry) > Date.now() + 8 * 3600000 + 60000 || !await verify(`${expiry}.${nonce}`, signature || '', env.ADMIN_TOKEN)) throw new HttpError(401, 'authentication_required');
}
export async function adminLogin(request, env) {
  requireSameOrigin(request); requireAdminConfigured(env);
  const body = await readJson(request, 1024);
  if (typeof body.token !== 'string' || body.token.length > 512) throw new HttpError(401, 'invalid_credentials');
  // HMAC verification keeps secret comparison inside Web Crypto.
  const challenge = 'stykanimate-admin-login-v1';
  if (!await verify(challenge, await sign(challenge, body.token), env.ADMIN_TOKEN)) throw new HttpError(401, 'invalid_credentials');
  const payload = `${Date.now() + 8 * 3600000}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  return json({ authenticated: true }, 200, { 'Set-Cookie': cookieHeader(request, `${payload}.${await sign(payload, env.ADMIN_TOKEN)}`, 28800) });
}
export function cookieHeader(request, value, maxAge = 0) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `styk_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export async function throttle(request, env, actor = null, admin = false) {
  const limiter = admin ? env.ADMIN_LIMITER : env.EDGE_LIMITER;
  if (limiter) {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const key = await sign(`${new Date().toISOString().slice(0, 10)}:${ip}`, env.RATE_LIMIT_SALT || env.ADMIN_TOKEN || 'unconfigured-local-only');
    if (!(await limiter.limit({ key })).success) throw new HttpError(429, 'rate_limited');
  }
  if (actor && env.INGEST_LIMITER && !(await env.INGEST_LIMITER.limit({ key: actor })).success) throw new HttpError(429, 'rate_limited');
}
export function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, headers });
}
