// GET /api/library (lib/library.js) with a stand-in Access team and a stand-in R2 bucket.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serveLibrary, wantedTag, LIBRARY_KEY } from '../lib/library.js';
import { servePdf } from '../lib/pdf.js';
import { forgetKeys } from '../lib/access.js';
import { makeAccess, ACCESS_ENV } from './access_helper.mjs';

const access = await makeAccess();
const fetchImpl = access.fetchWith(async () => { throw new Error('only the certs address should be fetched'); });
const LIBRARY = JSON.stringify({ source: 'sample', documents: [{ code: 'PK-0001-00', title: 'Sample' }] });
const ETAG = 'abc123';

// The parts of an R2 binding the route uses: get, with an etag condition.
function bucket(objects = { [LIBRARY_KEY]: LIBRARY }) {
  const asked = [];
  return {
    asked,
    async get(key, options) {
      asked.push([key, options]);
      if (!(key in objects)) return null;
      const meta = { key, size: objects[key].length, etag: ETAG, httpEtag: `"${ETAG}"` };
      if (options && options.onlyIf && options.onlyIf.etagDoesNotMatch === ETAG) return meta;   // no body
      return { ...meta, body: new Blob([objects[key]]).stream() };
    },
  };
}
const url = 'https://finder.example/api/library';
const signedIn = async (headers = {}) => new Request(url, { headers: { 'cf-access-jwt-assertion': await access.sign(), ...headers } });

beforeEach(() => forgetKeys());

test('signed-in staff get the library, with an etag', async () => {
  const env = { ...ACCESS_ENV, CURRICULUM: bucket() };
  const res = await serveLibrary(await signedIn(), env, fetchImpl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.equal(res.headers.get('etag'), `"${ETAG}"`);
  assert.deepEqual(await res.json(), JSON.parse(LIBRARY));
  assert.deepEqual(env.CURRICULUM.asked, [[LIBRARY_KEY, undefined]]);
});

test('an unchanged library answers 304 with no body', async () => {
  const env = { ...ACCESS_ENV, CURRICULUM: bucket() };
  const res = await serveLibrary(await signedIn({ 'if-none-match': `"${ETAG}"` }), env, fetchImpl);
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
  assert.deepEqual(env.CURRICULUM.asked[0][1], { onlyIf: { etagDoesNotMatch: ETAG } });
  const changed = await serveLibrary(await signedIn({ 'if-none-match': '"older"' }), env, fetchImpl);
  assert.equal(changed.status, 200);
  assert.equal(wantedTag('W/"x1", "x2"'), 'x1');
  assert.equal(wantedTag('*'), '');
});

test('without a valid sign-in nothing is read from the bucket', async () => {
  const env = { ...ACCESS_ENV, CURRICULUM: bucket() };
  for (const r of [new Request(url), new Request(url, { headers: { 'cf-access-jwt-assertion': 'typed.in.header' } })]) {
    const res = await serveLibrary(r, env, fetchImpl);
    assert.equal(res.status, 401);
    assert.ok((await res.json()).error);
  }
  const notSetUp = await serveLibrary(await signedIn(), { CURRICULUM: env.CURRICULUM }, fetchImpl);
  assert.equal(notSetUp.status, 503, 'no Access settings: refused, not open');
  assert.deepEqual(env.CURRICULUM.asked, []);
});

test('not connected, or not uploaded yet, says so', async () => {
  const unbound = await serveLibrary(await signedIn(), { ...ACCESS_ENV }, fetchImpl);
  assert.equal(unbound.status, 503);
  assert.match((await unbound.json()).error, /CURRICULUM/);
  const empty = await serveLibrary(await signedIn(), { ...ACCESS_ENV, CURRICULUM: bucket({}) }, fetchImpl);
  assert.equal(empty.status, 404);
  assert.match((await empty.json()).error, /not been uploaded/);
  const post = await serveLibrary(new Request(url, { method: 'POST' }), { ...ACCESS_ENV, CURRICULUM: bucket() }, fetchImpl);
  assert.equal(post.status, 405);
});

test('the PDF route cannot be used to reach the library', async () => {
  const env = { ...ACCESS_ENV, CURRICULUM: bucket() };
  for (const name of ['library.json', 'library', '..%2Flibrary.json']) {
    const res = await servePdf(await signedIn(), env, name, fetchImpl);
    assert.equal(res.status, 400, name);
  }
  assert.deepEqual(env.CURRICULUM.asked, []);
});
