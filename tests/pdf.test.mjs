// GET /api/pdf/<code> (lib/pdf.js) with a stand-in Access team and a stand-in R2 bucket.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { servePdf, servePdfCodes, forgetPdfCodes, readRange, pdfKey } from '../lib/pdf.js';
import { forgetKeys } from '../lib/access.js';
import { makeAccess, ACCESS_ENV } from './access_helper.mjs';

const access = await makeAccess();
const noApi = async () => { throw new Error('only the certs address should be fetched'); };
const fetchImpl = access.fetchWith(noApi);
const PDF = new TextEncoder().encode('%PDF-1.7 ' + 'x'.repeat(991));   // 1000 bytes

// The parts of an R2 binding the routes use: get (with a range), head and list.
function bucket(objects) {
  const asked = [];
  const found = (key) => objects[key];
  const info = (key, bytes) => ({ key, size: bytes.length, httpEtag: '"etag-' + key + '"' });
  return {
    asked,
    async head(key) { asked.push(['head', key]); return found(key) ? info(key, found(key)) : null; },
    async get(key, options) {
      asked.push(['get', key, options && options.range]);
      const bytes = found(key); if (!bytes) return null;
      const r = options && options.range;
      let part = bytes;
      if (r) part = r.suffix !== undefined ? bytes.slice(bytes.length - r.suffix)
        : bytes.slice(r.offset, r.length !== undefined ? r.offset + r.length : undefined);
      return { ...info(key, bytes), range: r, body: new Blob([part]).stream() };
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      asked.push(['list', prefix, cursor]);
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((k) => info(k, objects[k])), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
  };
}
const env = (objects = { [pdfKey('PK-NF01-00')]: PDF }) => ({ ...ACCESS_ENV, CURRICULUM: bucket(objects) });
const req = async (code, { token = true, headers = {}, method = 'GET' } = {}) =>
  new Request(`https://finder.example/api/pdf/${code}`, { method,
    headers: { ...(token ? { 'cf-access-jwt-assertion': await access.sign() } : {}), ...headers } });

beforeEach(() => { forgetKeys(); forgetPdfCodes(); });

test('a signed-in staff member gets the PDF, shown in the browser', async () => {
  const e = env();
  const res = await servePdf(await req('PK-NF01-00'), e, 'pk-nf01-00', fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'inline; filename="PK-NF01-00.pdf"');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
  assert.equal(res.headers.get('content-length'), '1000');
  assert.equal((await res.arrayBuffer()).byteLength, 1000);
  assert.deepEqual(e.CURRICULUM.asked, [['get', 'pdf/PK-NF01-00.pdf', undefined]], 'the code is upper-cased into its key');
});

test('without a valid Access sign-in nothing is read from the bucket', async () => {
  const e = env();
  for (const r of [await req('PK-NF01-00', { token: false }),
    new Request('https://finder.example/api/pdf/PK-NF01-00', { headers: { 'cf-access-jwt-assertion': 'typed.in.header' } })]) {
    const res = await servePdf(r, e, 'PK-NF01-00', fetchImpl);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  const notSetUp = await servePdf(await req('PK-NF01-00'), { CURRICULUM: e.CURRICULUM }, 'PK-NF01-00', fetchImpl);
  assert.equal(notSetUp.status, 503, 'no Access settings: refused, not open');
  assert.deepEqual(e.CURRICULUM.asked, []);
});

test('only document codes are looked up: no paths, no listing', async () => {
  const e = env();
  for (const bad of ['../secret', 'pdf/PK-NF01-00.pdf', 'PK-NF01-00.pdf', '', 'PKNF0100', 'PK-NF01-00/x']) {
    const res = await servePdf(await req('x'), e, bad, fetchImpl);
    assert.equal(res.status, 400, bad);
  }
  assert.deepEqual(e.CURRICULUM.asked, []);
});

test('a code with no PDF uploaded says so; no bucket connected says so', async () => {
  const missing = await servePdf(await req('PK-0000-11'), env(), 'PK-0000-11', fetchImpl);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /PK-0000-11 has not been uploaded yet/);
  const unbound = await servePdf(await req('PK-0000-11'), { ...ACCESS_ENV }, 'PK-0000-11', fetchImpl);
  assert.equal(unbound.status, 503);
  assert.match(await unbound.text(), /CURRICULUM/);
});

test('byte ranges, so a viewer can start before the whole file arrives', async () => {
  assert.deepEqual(readRange('bytes=0-99'), { offset: 0, length: 100 });
  assert.deepEqual(readRange('bytes=900-'), { offset: 900 });
  assert.deepEqual(readRange('bytes=-100'), { suffix: 100 });
  assert.equal(readRange('bytes=5-1'), null);
  assert.equal(readRange('items=0-1'), null);
  const first = await servePdf(await req('PK-NF01-00', { headers: { range: 'bytes=0-99' } }), env(), 'PK-NF01-00', fetchImpl);
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 0-99/1000');
  assert.equal((await first.arrayBuffer()).byteLength, 100);
  const tail = await servePdf(await req('PK-NF01-00', { headers: { range: 'bytes=-10' } }), env(), 'PK-NF01-00', fetchImpl);
  assert.deepEqual([tail.status, tail.headers.get('content-range')], [206, 'bytes 990-999/1000']);
  const rest = await servePdf(await req('PK-NF01-00', { headers: { range: 'bytes=900-' } }), env(), 'PK-NF01-00', fetchImpl);
  assert.deepEqual([rest.status, rest.headers.get('content-range'), rest.headers.get('content-length')], [206, 'bytes 900-999/1000', '100']);
  const head = await servePdf(await req('PK-NF01-00', { method: 'HEAD' }), env(), 'PK-NF01-00', fetchImpl);
  assert.deepEqual([head.status, head.headers.get('content-length'), head.headers.get('accept-ranges')], [200, '1000', 'bytes']);
});

test('/api/pdfs lists the uploaded codes (all pages of them), only for signed-in staff', async () => {
  const objects = {};
  for (let i = 0; i < 1188; i++) objects[pdfKey(`PK-${String(i).padStart(4, '0')}-00`)] = PDF;
  objects['pdf/notes.pdf'] = PDF; objects['other/PK-0001-00.pdf'] = PDF;
  const e = { ...ACCESS_ENV, CURRICULUM: bucket(objects) };
  const url = 'https://finder.example/api/pdfs';
  const signedIn = async () => new Request(url, { headers: { 'cf-access-jwt-assertion': await access.sign() } });

  const denied = await servePdfCodes(new Request(url), e, fetchImpl);
  assert.equal(denied.status, 401);
  assert.deepEqual(e.CURRICULUM.asked, [], 'nothing is listed before the sign-in check');

  const res = await servePdfCodes(await signedIn(), e, fetchImpl, 1000);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
  const { connected, codes } = await res.json();
  assert.equal(connected, true);
  assert.equal(codes.length, 1188, 'both pages of the listing, and only pdf/<code>.pdf keys');
  assert.equal(codes[0], 'PK-0000-00');
  assert.equal(e.CURRICULUM.asked.length, 2);

  await servePdfCodes(await signedIn(), e, fetchImpl, 1000 + 9 * 60 * 1000);
  assert.equal(e.CURRICULUM.asked.length, 2, 'kept for 10 minutes');
  await servePdfCodes(await signedIn(), e, fetchImpl, 1000 + 11 * 60 * 1000);
  assert.equal(e.CURRICULUM.asked.length, 4, 'listed again after that');

  const unbound = await servePdfCodes(await signedIn(), { ...ACCESS_ENV }, fetchImpl);
  assert.deepEqual(await unbound.json(), { connected: false, codes: [] });
});
