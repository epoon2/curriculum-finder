// A stand-in Cloudflare Access for tests: a real RSA key pair, signed tokens, and a
// fetch that serves the public key at the team's certs address.
export const TEAM = 'https://finder-test.cloudflareaccess.com';
export const AUD = 'test-audience-tag-0123456789abcdef';
export const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: 'finder-test.cloudflareaccess.com', ACCESS_AUD: AUD };

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

export async function makeAccess(kid = 'test-key-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  let certFetches = 0;
  async function sign(claims = {}, { headerKid = kid, key = pair.privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: headerKid, typ: 'JWT' }));
    const body = b64url(JSON.stringify({ aud: [AUD], iss: TEAM, email: 'staff@example.com',
      iat: now, nbf: now, exp: now + 3600, ...claims }));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + b64url(new Uint8Array(sig));
  }
  // Answers the certs address; anything else goes to `other` (the fake Anthropic API).
  const fetchWith = (other) => async (url, init) => {
    if (String(url) === TEAM + '/cdn-cgi/access/certs') {
      certFetches++;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return other(url, init);
  };
  return { sign, fetchWith, jwk, certFetches: () => certFetches, privateKey: pair.privateKey };
}
