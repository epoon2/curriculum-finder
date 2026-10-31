/*
  The page in a real browser, against a stand-in of the Cloudflare site:
    node tests/browser.mjs
  Serves public/ with the headers from public/_headers, answers /api/read-image with
  the real reader and a fake Anthropic reply, and /api/library, /api/pdfs and
  /api/pdf/<code> from a stand-in bucket holding the made-up tests/sample_library.json
  and one PDF. Acts as Cloudflare Access by adding
  its signed header (tests/access_helper.mjs). Needs Playwright (preinstalled in the Claude sandbox).
*/
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readImage } from '../lib/reader.js';
import { servePdf, servePdfCodes, pdfKey } from '../lib/pdf.js';
import { serveLibrary, LIBRARY_KEY } from '../lib/library.js';
import { makeAccess, ACCESS_ENV } from './access_helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const { chromium } = createRequire(import.meta.url)('playwright');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function headersFor(path) {
  const out = {};
  let current = null;
  for (const line of readFileSync(join(PUBLIC, '_headers'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { current = line.trim(); continue; }
    const pattern = current === '/*' ? /.*/ : new RegExp('^' + current.replace(/\*/g, '.*') + '$');
    if (pattern.test(path)) { const i = line.indexOf(':'); out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  return out;
}

// The stand-in reader answers these in turn, one per picture.
const READINGS = [
  { readable: true, summary: 'Adding two fractions with different denominators.',
    topics: ['Fractions'], skills: ['adding fractions with unlike denominators'], keywords: ['denominator'] },
  { readable: true, summary: 'Finding the slope of a line from two points.',
    topics: ['Graphing'], skills: ['slope of a line'], keywords: ['slope'] },
].map((r) => JSON.stringify(r));
let readerCalls = 0;
const access = await makeAccess();

// A bucket with the sample library and one PDF in it, PK-0186-00.
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 stand-in');
const LIBRARY_BYTES = readFileSync(join(ROOT, 'tests', 'sample_library.json'));
const SAMPLE = JSON.parse(LIBRARY_BYTES);
const pdfBucket = {
  async list() { return { objects: [{ key: pdfKey('PK-0186-00') }], truncated: false }; },
  async head(key) { return key === pdfKey('PK-0186-00') ? { size: PDF_BYTES.length } : null; },
  async get(key) {
    if (key === LIBRARY_KEY) return { size: LIBRARY_BYTES.length, httpEtag: '"v1"', body: new Blob([LIBRARY_BYTES]).stream() };
    return key === pdfKey('PK-0186-00') ? { size: PDF_BYTES.length, body: new Blob([PDF_BYTES]).stream() } : null;
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/library' || url.pathname === '/api/pdfs' || url.pathname.startsWith('/api/pdf/')) {
    const request = new Request(url, { method: req.method, headers: { ...req.headers, 'cf-access-jwt-assertion': await access.sign() } });
    const env = { ...ACCESS_ENV, CURRICULUM: pdfBucket };
    const certsOnly = access.fetchWith(async () => { throw new Error('no other fetches'); });
    const answer = url.pathname === '/api/library' ? await serveLibrary(request, env, certsOnly)
      : url.pathname === '/api/pdfs' ? await servePdfCodes(request, env, certsOnly)
      : await servePdf(request, env, decodeURIComponent(url.pathname.slice('/api/pdf/'.length)), certsOnly);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
    return;
  }
  if (url.pathname === '/api/read-image') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: { ...req.headers, 'cf-access-jwt-assertion': await access.sign() },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const answer = await readImage(request, { ANTHROPIC_API_KEY: 'stand-in', ...ACCESS_ENV }, access.fetchWith(async (u, init) => {
      readerCalls++;
      const body = JSON.parse(init.body);
      if (!body.messages[0].content[0].source.data) throw new Error('no image');
      const text = READINGS[(readerCalls - 1) % READINGS.length];
      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
    }));
    res.writeHead(answer.status, { ...headersFor(url.pathname), 'content-type': answer.headers.get('content-type') });
    res.end(Buffer.from(await answer.arrayBuffer()));
    return;
  }
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || path.endsWith('_headers')) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { ...headersFor(path), 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
await page.goto(base + '/');
await page.waitForFunction(() => /documents/.test(document.getElementById('libinfo').textContent), null, { timeout: 8000 })
  .catch(async () => { console.log('status:', await page.textContent('#status'), 'problems:', JSON.stringify(problems)); process.exit(1); });
const header = await page.textContent('.sub');
check('library loads, with the center and system names from it',
  header === `${SAMPLE.center} · ${SAMPLE.documents.length} documents, exported from ${SAMPLE.platform} on 01/15/2026`, header);
const direct = (await fetch(base + '/library.json')).status;
check('the library is not a public file', direct === 404, String(direct));
check('examples shown before searching', await page.isVisible('#welcome'));

await page.fill('#q', 'adding fractions with unlike denominators');
await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
const first = await page.textContent('#results li:first-child h3');
check('typing searches', /Unlike Denominators/i.test(first), first);
check('searched words are marked', (await page.$$('#results li:first-child mark')).length >= 2);
const narrow = (await page.$$('#results li')).length;
check('a precise search stays short', narrow > 0 && narrow <= 25 && !(await page.isVisible('#more')), `${narrow} results`);

await page.fill('#q', 'fractions');
await page.waitForTimeout(250);
check('25 shown, more available', (await page.$$('#results li')).length === 25 && await page.isVisible('#more'),
  await page.textContent('#status'));
await page.click('#more');
check('Show more adds 25', (await page.$$('#results li')).length === 50);

await page.check('#typeBoxes input[value="FO"]');
await page.waitForTimeout(100);
const types = await page.$$eval('#results .meta', (els) => els.map((e) => e.textContent.split(' · ')[0]));
check('type filter', types.length > 0 && types.every((t) => t === 'FO'), `${types.length} FO results`);
await page.click('#clearFilters');

await page.fill('#q', 'pk 186');
await page.waitForTimeout(250);
check('code search', (await page.textContent('#results li:first-child .code')) === 'PK-0186-00');
check('cards name the curriculum system from the library',
  (await page.textContent('#results li:first-child .actions')).includes(`Look up PK-0186-00 in ${SAMPLE.platform}`));
const pdfLinks = await page.$$eval('#results a', (as) => as.filter((a) => a.textContent === 'Open PDF').map((a) => a.getAttribute('href')));
check('"Open PDF" only on the card whose PDF is uploaded', JSON.stringify(pdfLinks) === JSON.stringify(['/api/pdf/PK-0186-00']), JSON.stringify(pdfLinks));
const served = await page.evaluate(async () => { const r = await fetch('/api/pdf/PK-0186-00'); return [r.status, r.headers.get('content-type'), (await r.text()).slice(0, 5)]; });
check('the link serves the PDF', JSON.stringify(served) === JSON.stringify([200, 'application/pdf', '%PDF-']), JSON.stringify(served));

// Image search: small PNGs through the file picker, a paste, and several at once.
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAIklEQVR4nGP4P0CAYdTiUYtHLR61eNTiUYtHLR61eORYDAAP7lcogpD+ZgAAAABJRU5ErkJggg==';
const png = Buffer.from(PNG64, 'base64');
const readingDone = async (n) => {
  try {
    await page.waitForFunction((count) => {
      const cards = document.querySelectorAll('#readings .shot');
      return cards.length === count && ![...cards].some((c) => c.textContent.includes('Reading…'));
    }, n, { timeout: 15000 });
    await page.waitForTimeout(150);
  } catch {
    console.log('status:', await page.textContent('#status'), 'problems:', JSON.stringify(problems));
    throw new Error('image search did not finish');
  }
};
const query = () => page.inputValue('#q');

await page.setInputFiles('#img', { name: 'notes.png', mimeType: 'image/png', buffer: png });
await readingDone(1);
check('a picture is read and summarized', /different denominators/.test(await page.textContent('#readings .shot-text')));
check('its reading becomes the search', (await query()).startsWith('adding fractions with unlike denominators'));
await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
check('image search finds fraction pages', /Fraction/i.test(await page.textContent('#results li:first-child h3')));
check('the reader was called once', readerCalls === 1);

await page.evaluate((b64) => {      // Ctrl+V with a picture on the clipboard
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, PNG64);
await readingDone(2);
check('a pasted picture is added and searches for itself', (await query()) === 'slope of a line, slope', await query());
check('"Search all together" appears with two pictures', await page.isVisible('#searchAll'));
await page.click('#searchAll');
const together = await query();
check('all together searches both', together.includes('adding fractions') && together.includes('slope of a line'), together);
check('both pictures are highlighted', (await page.$$('#readings .shot.active')).length === 2);
await page.click('#readings .shot:first-child .shot-text');
check('clicking a picture searches just that one', (await query()).startsWith('adding fractions') && !(await query()).includes('slope'));
check('...and only it is highlighted', (await page.$$('#readings .shot.active')).length === 1);
await page.click('#readings .shot:nth-child(2) .shot-remove');
check('a picture can be removed', (await page.$$('#readings .shot')).length === 1 && await page.isHidden('#searchAll'));

await page.setInputFiles('#img', [{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
await readingDone(3);
check('several chosen at once are all read', readerCalls === 4, String(readerCalls));
check('several added together search all together', await page.getAttribute('#searchAll', 'aria-pressed') === 'true');
await page.screenshot({ path: process.env.SHOT || '/tmp/finder.png', fullPage: false });
await page.click('#clearImage');
check('clearing the pictures hides them', await page.isHidden('#reading'));

const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return 'reached'; } catch { return 'blocked'; } });
check('the page cannot reach other sites', blocked === 'blocked');
check('no page errors', problems.filter((p) => !/example\.com|Content Security Policy/.test(p)).length === 0, JSON.stringify(problems.slice(0, 3)));

// Phone width.
await page.setViewportSize({ width: 390, height: 800 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no sideways scrolling at phone width', !overflow);

await browser.close();
server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
