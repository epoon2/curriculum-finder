/*
  Checks the Cloudflare Access sign-in on a request, so the server routes (the
  library, the PDFs and the image reader, which spends money on every call) only
  answer staff Access has let in.

  Access puts a signed token in the Cf-Access-Jwt-Assertion header of every request it
  allows. Anyone can type that header by hand, so having it proves nothing; this
  checks the token's signature against the team's public keys, that it was issued
  for this application, and that it has not expired. If Access were ever switched
  off by mistake, the page would still load but every route would refuse to answer.

  Settings (Settings -> Variables and Secrets, as plain text):
    ACCESS_TEAM_DOMAIN  the team domain, like yourteam.cloudflareaccess.com
                        (Zero Trust -> Settings -> Team name and domain)
    ACCESS_AUD          the application's Application Audience (AUD) Tag, shown on
                        the finder's application in Zero Trust -> Access -> Applications
*/

const KEY_TTL_MS = 60 * 60 * 1000;   // Cloudflare rotates the keys every few weeks
const LEEWAY_S = 60;                 // small clock differences between Cloudflare machines
let cached = { team: '', at: 0, keys: [] };

export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function teamUrl(domain) {
  const host = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return '';
  return 'https://' + host.toLowerCase();
}

function base64urlBytes(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const base64urlJson = (part) => JSON.parse(new TextDecoder().decode(base64urlBytes(part)));

async function teamKeys(team, fetchImpl, fresh) {
  const now = Date.now();
  if (!fresh && cached.team === team && now - cached.at < KEY_TTL_MS && cached.keys.length) return cached.keys;
  const unreachable = new AccessError(503, 'The sign-in keys could not be fetched. Try again in a minute.');
  let body;
  try {
    const res = await fetchImpl(team + '/cdn-cgi/access/certs', { headers: { accept: 'application/json' } });
    if (!res.ok) throw unreachable;
    body = await res.json();
  } catch { throw unreachable; }
  const keys = (body.keys || []).filter((k) => k && k.kty === 'RSA' && k.kid);
  cached = { team, at: now, keys };
  return keys;
}

/** Throws AccessError unless the request carries a valid Access token for this app. Returns its claims. */
export async function checkAccess(request, env, fetchImpl = (...args) => fetch(...args)) {
  const team = teamUrl(env.ACCESS_TEAM_DOMAIN);
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) {
    throw new AccessError(503, 'The sign-in check is not set up yet (ACCESS_TEAM_DOMAIN and ACCESS_AUD).');
  }
  const token = request.headers.get('cf-access-jwt-assertion') || '';
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError(401, 'Sign in through the finder first.');

  let header, claims;
  try { header = base64urlJson(parts[0]); claims = base64urlJson(parts[1]); } catch {
    throw new AccessError(401, 'Sign in through the finder first.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new AccessError(401, 'Sign in through the finder first.');

  let jwk = (await teamKeys(team, fetchImpl, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await teamKeys(team, fetchImpl, true)).find((k) => k.kid === header.kid);  // keys rotated
  if (!jwk) throw new AccessError(401, 'Your sign-in is out of date. Reload the page.');

  let good = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64urlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch { good = false; }
  if (!good) throw new AccessError(401, 'Sign in through the finder first.');

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new AccessError(401, 'That sign-in is for a different site.');
  if (claims.iss !== team) throw new AccessError(401, 'That sign-in is for a different site.');
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) {
    throw new AccessError(401, 'Your sign-in has expired. Reload the page.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) {
    throw new AccessError(401, 'Sign in through the finder first.');
  }
  return claims;
}

/** For tests: forget the cached keys. */
export function forgetKeys() { cached = { team: '', at: 0, keys: [] }; }
