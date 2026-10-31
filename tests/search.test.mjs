// The finder's search (public/search.js).
//   - on tests/sample_library.json, a made-up library in the export's format (always)
//   - on the real library.json, if one is next to the repo's README (it is never
//     committed; build_library.py makes it). Those tests are skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildIndex, search, terms, codeQuery, queryFromReading, docLink, levelRank } from '../public/search.js';

const sample = JSON.parse(readFileSync(new URL('./sample_library.json', import.meta.url), 'utf8'));
const index = buildIndex(sample.documents);
const top = (ix, q, opts = {}, n = 5) => search(ix, q, { limit: n, ...opts }).map((r) => r.doc.code);
const topTitles = (ix, q, n = 5) => search(ix, q, { limit: n }).map((r) => r.doc.title.toLowerCase());

test('word families fold together', () => {
  assert.deepEqual(terms('Dividing'), terms('division'));
  assert.deepEqual(terms('quotients'), terms('divide'));
  assert.deepEqual(terms('Multiplying Decimals'), ['multiply', 'decimal']);
  assert.deepEqual(terms('50% of numbers'), ['50', 'percent', 'number']);
  assert.deepEqual(terms('how to find the slope'), ['slope']);
});

test('codes go straight to the document', () => {
  assert.equal(codeQuery('pk 186'), 'PK-0186');
  assert.equal(codeQuery('fo23'), 'FO-0023');
  assert.equal(codeQuery('WCH 7 1'), 'WCH-007-001');
  assert.equal(codeQuery('PK-3145-TP'), 'PK-3145-TP');
  assert.equal(codeQuery('adding fractions'), null);
  assert.deepEqual(top(index, 'pk 186', {}, 1), ['PK-0186-00']);
  assert.deepEqual(new Set(top(index, 'pk 186')), new Set(['PK-0186-00', 'PK-0186-TP']), 'the Test Prep version comes along');
  assert.deepEqual(top(index, 'fo23'), ['FO-0023-00']);
  const book = top(index, 'WOB 7', {}, 50);
  assert.deepEqual(book, ['WOB-007-000', 'WCH-007-001', 'WCH-007-002', 'WCH-007-003'], 'the whole book, then its chapters');
  assert.deepEqual(top(index, 'WCH 7 1'), ['WCH-007-001'], 'one chapter stays one chapter');
});

test('plain-word searches find the obvious documents first', () => {
  const cases = {
    'adding fractions with unlike denominators': 'adding fractions with unlike denominators',
    'slope of a line': 'slope of a line',
    'percent of change': 'percent of change',
    'pythagorean theorem': 'the pythagorean theorem',
    'mean median mode': 'mean, median, and mode',
    'counting coins': 'counting coins',
    'telling time to the hour': 'telling time to the hour',
  };
  for (const [q, expect] of Object.entries(cases)) {
    assert.equal(topTitles(index, q, 1)[0], expect, q);
  }
  assert.ok(topTitles(index, 'long division', 2).every((t) => t.startsWith('long division')));
});

test('documents matching every word beat those matching some', () => {
  const r = search(index, 'multiplying decimals', { limit: 3 });
  assert.equal(r[0].doc.code, 'PK-1200-00');
  assert.deepEqual(new Set(r[0].matched), new Set(['multiply', 'decimal']));
  const precise = search(index, 'adding fractions with unlike denominators', { limit: 500 });
  const broad = search(index, 'fractions', { limit: 500 });
  assert.ok(precise.length < broad.length / 2, `a precise search stays short (${precise.length} of ${broad.length})`);
});

test('filters narrow without changing the order', () => {
  const all = search(index, 'fractions', { limit: 100 });
  const onlyFo = search(index, 'fractions', { types: ['FO'], limit: 100 });
  assert.ok(onlyFo.length > 0 && onlyFo.every((r) => r.doc.type === 'FO'));
  assert.deepEqual(onlyFo.map((r) => r.doc.code), all.filter((r) => r.doc.type === 'FO').map((r) => r.doc.code));
  const l4 = search(index, 'fractions', { level: 'Level 4', limit: 100 });
  assert.ok(l4.length > 0 && l4.every((r) => r.doc.level === 'Level 4'));
  const money = search(index, '', { tag: 'Money', limit: 100 });
  assert.deepEqual(money.map((r) => r.doc.code), ['FO-0040-00', 'PK-0410-00', 'PK-0411-00'], 'filters alone list in code order');
});

test('topics from the image reader lift matching documents', () => {
  const score = (list) => Object.fromEntries(list.map((r) => [r.doc.code, r.score]));
  const plain = score(search(index, 'area', { limit: 50 }));
  const boosted = score(search(index, 'area', { boostTags: ['Geometry'], limit: 50 }));
  assert.ok(boosted['PK-2300-00'] > plain['PK-2300-00'] && boosted['PK-2301-00'] > plain['PK-2301-00'], 'Geometry pages gain');
  assert.equal(boosted['PK-2302-00'], plain['PK-2302-00'], 'the Computation page does not');
  assert.equal(queryFromReading({ skills: ['adding fractions'], keywords: ['denominator'] }), 'adding fractions, denominator');
});

test('nothing matches nonsense, and an empty search returns nothing without filters', () => {
  assert.deepEqual(search(index, 'zzqxv', {}), []);
  assert.deepEqual(top(index, '', { types: ['GF'] }, 10), ['GF-B001-00', 'GF-B002-00']);
});

test('levels sort in order, named levels first', () => {
  assert.deepEqual(index.levels.slice(0, 3), ['Foundations', 'Level 1', 'Level 2']);
  assert.ok(levelRank('Level 10') > levelRank('Level 9'));
  assert.ok(levelRank('Foundations') < levelRank('Level 0'));
});

test('document links need an https pattern with {id}', () => {
  const doc = sample.documents[0];
  assert.equal(docLink(doc), '');
  assert.equal(docLink(doc, 'https://lms.example/doc/{id}'), `https://lms.example/doc/${doc.id}`);
  assert.equal(docLink(doc, 'http://lms.example/doc/{id}'), '', 'not plain http');
  assert.equal(docLink(doc, 'javascript:alert({id})'), '');
  assert.equal(docLink(doc, 'https://lms.example/doc/'), '', 'no {id}');
});

test('every document is searchable by its own title', () => {
  for (const d of sample.documents) {
    const codes = search(index, d.title, { limit: 25 }).map((r) => r.doc.code);
    assert.ok(codes.includes(d.code), d.title);
  }
});

// --- the real library, when it's here ------------------------------------------------
const REAL = new URL('../library.json', import.meta.url);
const real = existsSync(REAL) ? JSON.parse(readFileSync(REAL, 'utf8')) : null;
const realIndex = real && buildIndex(real.documents);
const skip = real ? false : 'no library.json next to the README (it is never committed)';

test('real library: codes and word searches', { skip }, () => {
  assert.deepEqual(top(realIndex, 'pk 186'), ['PK-0186-00']);
  const family = top(realIndex, 'PK-3145', {}, 10);
  assert.ok(family.includes('PK-3145-00') && family.includes('PK-3145-TP') && family.every((c) => c.startsWith('PK-3145-')));
  const book = top(realIndex, 'WOB 7', {}, 50);
  assert.equal(book[0], 'WOB-007-000');
  assert.ok(book.length > 1 && book.slice(1).every((c) => c.startsWith('WCH-007-')));
  for (const [q, expect] of Object.entries({ 'adding fractions with unlike denominators': 'unlike denominators',
    'slope of a line': 'slope of a line', 'percent of change': 'percent of change',
    'pythagorean theorem': 'pythagorean theorem', 'mean median mode': 'mean, median, and mode', 'counting coins': 'coin' })) {
    assert.ok(topTitles(realIndex, q, 1)[0].includes(expect), `${q} -> ${topTitles(realIndex, q, 1)[0]}`);
  }
  assert.ok(topTitles(realIndex, 'long division', 3).every((t) => t.includes('division')));
});

test('real library: filters, levels, and every title finds its document', { skip }, () => {
  const all = search(realIndex, 'fractions', { limit: 50 });
  const onlyFo = search(realIndex, 'fractions', { types: ['FO'], limit: 50 });
  assert.deepEqual(onlyFo.map((r) => r.doc.code).slice(0, 5), all.filter((r) => r.doc.type === 'FO').map((r) => r.doc.code).slice(0, 5));
  assert.equal(levelRank(realIndex.levels[0]), -1, 'the named level comes first');
  assert.equal(realIndex.levels[1], 'Level 0');
  let misses = 0;
  for (const d of real.documents) {
    if (!terms(d.title).length) continue;
    if (!search(realIndex, d.title, { limit: 25 }).some((r) => r.doc.code === d.code)) misses++;
  }
  assert.ok(misses / real.documents.length < 0.02, `${misses} titles did not find their own document`);
});
