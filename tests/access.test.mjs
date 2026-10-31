// The Access token check (lib/access.js) with a stand-in Access team.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess, teamUrl, forgetKeys } from '../lib/access.js';
import { makeAccess, ACCESS_ENV, AUD } from './access_helper.mjs';

const access = await makeAccess();
const other = await makeAccess('test-key-1');      // same key id, different key: a forged signature
const noApi = async () => { throw new Error('only the certs address should be fetched'); };
const req = (token) => new Request('https://finder.example/api/read-image',
  { method: 'POST', headers: token == null ? {} : { 'cf-access-jwt-assertion': token } });

beforeEach(() => forgetKeys());

test('a token Access signed for this app passes and gives the email', async () => {
  const claims = await checkAccess(req(await access.sign()), ACCESS_ENV, access.fetchWith(noApi));
  assert.equal(claims.email, 'staff@example.com');
  await checkAccess(req(await access.sign()), ACCESS_ENV, access.fetchWith(noApi));
  assert.equal(access.certFetches(), 1, 'the keys are fetched once and reused');
});

test('refused: no token, a typed-in header, a forged signature, wrong app, wrong team, expired, not yet valid', async () => {
  const f = access.fetchWith(noApi);
  const bad = [
    [null, 401], ['stand-in', 401], ['a.b.c', 401],
    [await other.sign(), 401],
    [await access.sign({ aud: ['some-other-app'] }), 401],
    [await access.sign({ iss: 'https://someone-else.cloudflareaccess.com' }), 401],
    [await access.sign({ exp: Math.floor(Date.now() / 1000) - 600 }), 401],
    [await access.sign({ nbf: Math.floor(Date.now() / 1000) + 600 }), 401],
    [await access.sign({}, { headerKid: 'unknown-key' }), 401],
  ];
  for (const [token, status] of bad) {
    await assert.rejects(checkAccess(req(token), ACCESS_ENV, f), (err) => err.status === status, String(token).slice(0, 30));
  }
});

test('not set up, or the keys cannot be fetched: 503, not a pass', async () => {
  const token = await access.sign();
  await assert.rejects(checkAccess(req(token), {}, access.fetchWith(noApi)), (e) => e.status === 503);
  await assert.rejects(checkAccess(req(token), { ...ACCESS_ENV, ACCESS_AUD: '' }, access.fetchWith(noApi)), (e) => e.status === 503);
  await assert.rejects(checkAccess(req(token), ACCESS_ENV, async () => { throw new TypeError('network'); }), (e) => e.status === 503);
  await assert.rejects(checkAccess(req(token), ACCESS_ENV, async () => new Response('', { status: 500 })), (e) => e.status === 503);
});

test('the team domain can be typed with or without https://', () => {
  assert.equal(teamUrl('finder-test.cloudflareaccess.com'), 'https://finder-test.cloudflareaccess.com');
  assert.equal(teamUrl('https://Finder-Test.cloudflareaccess.com/'), 'https://finder-test.cloudflareaccess.com');
  assert.equal(teamUrl('not a domain'), '');
  assert.equal(AUD.length > 10, true);
});
