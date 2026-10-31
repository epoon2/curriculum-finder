/*
  GET /api/pdf/<code>: one curriculum PDF, from the private R2 bucket bound as CURRICULUM.

  - Only for staff: the Cloudflare Access sign-in is checked here too (lib/access.js),
    so a PDF is never served even if Access were switched off by mistake or a hostname
    were left out of it. The bucket itself has no public address.
  - Only real document codes (like PK-NF01-00 or FO-0090-TP) are looked up, at
    pdf/<code>.pdf, where tools/upload_curriculum.py put them. Nothing else in the
    bucket (like library.json) can be reached this way.
  - Byte ranges are answered, so a viewer can show page 1 before the rest arrives.
*/
import { checkAccess, AccessError } from './access.js';

export const CODE = /^[A-Z]{2,3}-[A-Z0-9]{3,4}-[A-Z0-9]{2,3}$/;
export const pdfKey = (code) => `pdf/${code}.pdf`;

// A short plain page for anything that is not the PDF (it opens in a new tab).
function page(status, text) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curriculum Finder</title><body style="font:16px system-ui,sans-serif;margin:2rem;max-width:36rem;line-height:1.5"><p>${text}</p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** "bytes=0-1023" / "bytes=1024-" / "bytes=-500" as an R2 range, or null for the whole file. */
export function readRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  return m[2] === '' ? { offset } : (Number(m[2]) >= offset ? { offset, length: Number(m[2]) - offset + 1 } : null);
}

/*
  GET /api/pdfs: the codes that have a PDF in the bucket, so the page shows "Open PDF"
  only on those cards. Listing costs an R2 operation per 1,000 files, so the list is
  kept for 10 minutes; a new upload shows up within that time.
*/
const LIST_TTL_MS = 10 * 60 * 1000;
let listed = { at: 0, codes: null };
export function forgetPdfCodes() { listed = { at: 0, codes: null }; }

const json = (status, body, cache = 'no-store') => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff' } });

export async function servePdfCodes(request, env, fetchImpl, now = Date.now()) {
  if (request.method !== 'GET') return json(405, { error: 'Only GET.' });
  try {
    await checkAccess(request, env, fetchImpl);
  } catch (err) {
    if (err instanceof AccessError) return json(err.status, { error: err.status === 503 ? 'The finder is not set up yet.' : err.message });
    throw err;
  }
  if (!env.CURRICULUM) return json(200, { connected: false, codes: [] });
  if (!listed.codes || now - listed.at > LIST_TTL_MS) {
    const codes = [];
    let cursor;
    do {
      const page = await env.CURRICULUM.list({ prefix: 'pdf/', limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects || []) {
        const m = /^pdf\/(.+)\.pdf$/.exec(object.key);
        if (m && CODE.test(m[1])) codes.push(m[1]);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    listed = { at: now, codes: codes.sort() };
  }
  return json(200, { connected: true, codes: listed.codes }, 'private, max-age=300');
}

export async function servePdf(request, env, code, fetchImpl) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return page(405, 'Only GET.');
  try {
    await checkAccess(request, env, fetchImpl);
  } catch (err) {
    if (err instanceof AccessError) return page(err.status, err.status === 503 ? 'The finder is not set up yet.' : err.message);
    throw err;
  }
  code = String(code || '').toUpperCase();
  if (!CODE.test(code)) return page(400, 'That is not a document code.');
  if (!env.CURRICULUM) return page(503, 'The PDFs are not connected yet (no CURRICULUM binding on the Pages project).');

  const range = request.method === 'GET' ? readRange(request.headers.get('range')) : null;
  const object = request.method === 'HEAD' ? await env.CURRICULUM.head(pdfKey(code))
    : await env.CURRICULUM.get(pdfKey(code), range ? { range } : undefined);
  if (!object) return page(404, `The PDF for ${code} has not been uploaded yet.`);

  const headers = new Headers({
    'content-type': 'application/pdf',
    'content-disposition': `inline; filename="${code}.pdf"`,
    'cache-control': 'private, max-age=3600',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  const size = object.size;
  if (request.method === 'HEAD') {
    headers.set('content-length', String(size));
    return new Response(null, { status: 200, headers });
  }
  if (range && object.range) {
    const start = object.range.suffix !== undefined ? Math.max(0, size - object.range.suffix) : object.range.offset;
    const length = object.range.suffix !== undefined ? size - start
      : (object.range.length !== undefined ? object.range.length : size - start);
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(object.body, { status: 200, headers });
}
