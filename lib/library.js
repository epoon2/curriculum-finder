/*
  GET /api/library: the curriculum library (library.json) from the private R2 bucket
  bound as CURRICULUM. GET /api/text: the PDFs' text (text.json.gz, gzipped JSON
  {"documents": {code: [page texts]}}), which the page unzips itself to search inside
  the PDFs. It is optional: before it is uploaded the route answers 404 and the page
  searches the library only.

  The library is licensed curriculum metadata (titles, skills, keywords), so it is
  not part of the site's public files or the repo. It lives in the bucket next to
  the PDFs (tools/upload_curriculum.py puts it there) and is served only after the
  Cloudflare Access sign-in is checked here (lib/access.js).

  The browser keeps a copy of each and asks again on each visit with If-None-Match;
  an unchanged file answers 304 with no body.
*/
import { checkAccess, AccessError } from './access.js';

export const LIBRARY_KEY = 'library.json';
export const TEXT_KEY = 'text.json.gz';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

/** The etag value inside an If-None-Match header ("abc", W/"abc"), or ''. */
export function wantedTag(header) {
  const first = String(header || '').split(',')[0].trim().replace(/^W\//, '');
  return /^"[^"]+"$/.test(first) ? first.slice(1, -1) : '';
}

export function serveLibrary(request, env, fetchImpl) {
  return serveFile(request, env, fetchImpl, LIBRARY_KEY, 'application/json; charset=utf-8',
    'The library has not been uploaded yet.');
}

export function serveText(request, env, fetchImpl) {
  return serveFile(request, env, fetchImpl, TEXT_KEY, 'application/gzip',
    'The PDF text has not been uploaded yet.');
}

async function serveFile(request, env, fetchImpl, key, type, notThere) {
  if (request.method !== 'GET') return json(405, { error: 'Only GET.' });
  try {
    await checkAccess(request, env, fetchImpl);
  } catch (err) {
    if (err instanceof AccessError) return json(err.status, { error: err.status === 503 ? 'The finder is not set up yet.' : err.message });
    throw err;
  }
  if (!env.CURRICULUM) return json(503, { error: 'The library is not connected yet (no CURRICULUM binding on the Pages project).' });

  const tag = wantedTag(request.headers.get('if-none-match'));
  const object = await env.CURRICULUM.get(key, tag ? { onlyIf: { etagDoesNotMatch: tag } } : undefined);
  if (!object) return json(404, { error: notThere });

  const headers = new Headers({
    'content-type': type,
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  // When the etag matched, R2 returns the object's details without a body.
  if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
  return new Response(object.body, { status: 200, headers });
}
