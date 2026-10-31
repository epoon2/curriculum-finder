/*
  The finder's search: plain words (or what the image reader saw) in, the best
  matching curriculum documents out. Runs in the browser over library.json;
  nothing is sent anywhere. Shared with tests/search.test.mjs.

  Each document is scored on its title, critical skills, keywords and tags
  (BM25 per field, weighted), then by how many of the searched words it covers,
  so a page about exactly "adding fractions" beats one that merely mentions
  fractions many times. Word families are folded together ("dividing",
  "division", "quotient" all count as divide) so staff don't need the library's
  exact wording.
*/

const FIELDS = { title: 3, skills: 2, keywords: 2, tags: 2.5, file: 1 };
const K1 = 1.2, B = 0.6;

const STOP = new Set(('a an the of and or to in on for with by from is are be how what which ' +
  'do does using use into than that this these those their its it as at about up out ' +
  'find solve solving problem problems practice worksheet student students example examples').split(' '));

// Word families: each spelling on the left becomes the stem on the right.
const FAMILIES = {
  multiply: 'multiplication multiplying multiplied multiplies multiple times product products',
  divide: 'division dividing divided divides quotient quotients divisor dividend',
  add: 'addition adding added adds sum sums plus',
  subtract: 'subtraction subtracting subtracted minus difference differences',
  fraction: 'fractions fractional numerator denominator denominators numerators',
  decimal: 'decimals',
  percent: 'percents percentage percentages %',
  ratio: 'ratios rate rates',
  proportion: 'proportions proportional',
  exponent: 'exponents power powers exponential',
  root: 'roots radical radicals sqrt',
  equation: 'equations',
  inequality: 'inequalities',
  graph: 'graphs graphing graphed plot plotting coordinate coordinates',
  angle: 'angles',
  triangle: 'triangles',
  circle: 'circles circumference',
  probability: 'probabilities chance likely likelihood',
  mean: 'average averages',
  integer: 'integers negative negatives',
  round: 'rounding rounded',
  estimate: 'estimation estimating estimated',
  money: 'coins coin dollars dollar cents cent',
  clock: 'clocks',
  measure: 'measurement measurements measuring',
  area: 'areas',
  volume: 'volumes',
  perimeter: 'perimeters',
  polynomial: 'polynomials',
  factor: 'factors factoring factored factorization',
  function: 'functions',
  slope: 'slopes',
  pattern: 'patterns sequence sequences',
  word: 'story',
};
const FAMILY = new Map();
for (const [stem, words] of Object.entries(FAMILIES)) {
  FAMILY.set(stem, stem);
  for (const w of words.split(' ')) FAMILY.set(w, stem);
}

function stem(word) {
  if (FAMILY.has(word)) return FAMILY.get(word);
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (FAMILY.has(w)) return FAMILY.get(w);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return FAMILY.get(w) || w;
}

/** Text -> search terms: lower case, %, word families, no filler words. */
export function terms(text) {
  const out = [];
  const words = String(text || '').toLowerCase().replace(/%/g, ' percent ')
    .replace(/[’']s\b/g, '').split(/[^a-z0-9]+/);
  for (const raw of words) {
    if (!raw || STOP.has(raw)) continue;
    const t = stem(raw);
    if (t && !STOP.has(t)) out.push(t);
  }
  return out;
}

const CODE = /^\s*(pk|fo|gf|wch|wob)[\s-]*([a-z0-9]{1,4})(?:[\s-]+([a-z0-9]{1,3}))?(?:[\s-]+([a-z0-9]{1,3}))?\s*$/i;

/** "pk 186", "PK-0186-TP", "fo23" -> a code prefix to look up, else null. */
export function codeQuery(text) {
  const m = CODE.exec(String(text || ''));
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  let num = m[2].toUpperCase();
  if (/^\d+$/.test(num) && (prefix === 'PK' || prefix === 'FO')) num = num.padStart(4, '0');
  if (/^\d+$/.test(num) && (prefix === 'WCH' || prefix === 'WOB')) num = num.padStart(3, '0');
  let part = m[3];
  if (part && /^\d+$/.test(part) && (prefix === 'WCH' || prefix === 'WOB')) part = part.padStart(3, '0');
  return [prefix, num, part, m[4]].filter(Boolean).join('-').toUpperCase();
}

/** Precompute per-field term counts and the library's word statistics. */
export function buildIndex(documents) {
  const docs = documents.map((d) => {
    const fields = {
      title: terms(d.title),
      skills: terms(d.skills),
      keywords: terms((d.keywords || []).join(' ')),
      tags: terms((d.tags || []).join(' ')),
      file: terms(String(d.file || '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
    };
    const counts = {};
    for (const [name, list] of Object.entries(fields)) {
      const c = new Map();
      for (const t of list) c.set(t, (c.get(t) || 0) + 1);
      counts[name] = { c, len: list.length };
    }
    return { doc: d, counts };
  });
  const avg = {};
  for (const name of Object.keys(FIELDS)) {
    avg[name] = docs.reduce((s, x) => s + x.counts[name].len, 0) / Math.max(1, docs.length) || 1;
  }
  const df = new Map();
  for (const x of docs) {
    const seen = new Set();
    for (const name of Object.keys(FIELDS)) for (const t of x.counts[name].c.keys()) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const types = [...new Set(documents.map((d) => d.type))].sort();
  const tags = [...new Set(documents.flatMap((d) => d.tags || []))].sort();
  const levels = [...new Set(documents.map((d) => d.level).filter(Boolean))]
    .sort((a, b) => levelRank(a) - levelRank(b));
  return { docs, avg, df, n: docs.length, types, tags, levels };
}

export function levelRank(level) {
  const m = /level\s*(\d+)/i.exec(level || '');
  return m ? Number(m[1]) : (String(level || '').trim() ? -1 : 99);   // named levels come before Level 0
}

function idf(index, t) {
  const n = index.df.get(t) || 0;
  return Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
}

/**
 * Search. `query` is plain words or a code. `options`:
 *   types:  only these document types (empty = all)
 *   tag:    only documents with this tag
 *   level:  only this level
 *   boostTags: tags that earn a bonus without filtering (from the image reader)
 *   limit:  how many results (default 30)
 *   minRelative: drop results scoring under this share of the best one (default 0.2)
 * Returns [{ doc, score, matched: [terms found] }], best first.
 */
export function search(index, query, options = {}) {
  const { types = [], tag = '', level = '', boostTags = [], limit = 30, minRelative = 0.2 } = options;
  const keep = (d) => (!types.length || types.includes(d.type)) &&
    (!tag || (d.tags || []).includes(tag)) && (!level || d.level === level);

  const code = codeQuery(query);
  if (code) {
    // "WOB 7" also brings that book's chapters (WCH-007-...), after the whole book.
    const chapters = /^WOB-\d{3}$/.test(code) ? code.replace(/^WOB/, 'WCH') + '-' : null;
    const hits = index.docs.filter((x) => keep(x.doc) && (x.doc.code.toUpperCase().startsWith(code) ||
        (chapters && x.doc.code.toUpperCase().startsWith(chapters))))
      .map((x) => ({ doc: x.doc, score: x.doc.code.toUpperCase().startsWith(code) ? 100 : 99, matched: [] }))
      .sort((a, b) => b.score - a.score);
    if (hits.length) return hits.slice(0, limit);
  }

  const wanted = [...new Set(terms(query))];
  const boost = new Set(boostTags.map((t) => t.toLowerCase()));
  if (!wanted.length) {
    // No words: everything that passes the filters, in code order (or boosted tags first).
    return index.docs.filter((x) => keep(x.doc))
      .map((x) => ({ doc: x.doc, score: (x.doc.tags || []).some((t) => boost.has(t.toLowerCase())) ? 1 : 0, matched: [] }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const results = [];
  for (const x of index.docs) {
    if (!keep(x.doc)) continue;
    let score = 0;
    const matched = [];
    for (const t of wanted) {
      let termScore = 0;
      for (const [name, weight] of Object.entries(FIELDS)) {
        const f = x.counts[name];
        const tf = f.c.get(t);
        if (!tf) continue;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * f.len / index.avg[name]));
        termScore += weight * norm;
      }
      if (termScore) {
        score += termScore * idf(index, t);
        matched.push(t);
      }
    }
    if (!score) continue;
    // Cover more of what was asked: a page matching every word beats one matching a few,
    // and a title that says what was asked beats one that only mentions it in keywords.
    score *= Math.pow(matched.length / wanted.length, 1.5);
    const inTitle = wanted.filter((t) => x.counts.title.c.has(t)).length / wanted.length;
    score *= 1 + 0.5 * inTitle;
    if (inTitle === 1) {
      // Every word is in the title: the fewer other words the title has, the closer the match.
      const extra = [...x.counts.title.c.keys()].filter((t) => !wanted.includes(t)).length;
      score *= 1 + 0.5 / (1 + extra);
    }
    if ((x.doc.tags || []).some((t) => boost.has(t.toLowerCase()))) score *= 1.25;
    results.push({ doc: x.doc, score, matched });
  }
  results.sort((a, b) => b.score - a.score || a.doc.code.localeCompare(b.doc.code));
  // Drop the long tail that only shares a common word with the search.
  const floor = results.length ? results[0].score * minRelative : 0;
  return results.filter((r) => r.score >= floor).slice(0, limit);
}

/** The query to run for what the image reader saw in one image or several (repeats dropped). */
export function queryFromReadings(readings) {
  const seen = new Set(), parts = [];
  for (const r of readings) {
    for (const part of [...(r.skills || []), ...(r.keywords || [])]) {
      const key = String(part).toLowerCase();
      if (!seen.has(key)) { seen.add(key); parts.push(part); }
    }
  }
  return parts.join(', ');
}
export const queryFromReading = (reading) => queryFromReadings([reading]);

/**
 * Where a document opens in the curriculum system: the library's docUrl pattern
 * (https only) with {id} replaced by the document's id, or '' without one.
 */
export function docLink(doc, pattern = '') {
  if (!/^https:\/\/[^\s"'<>]+$/.test(pattern || '') || !pattern.includes('{id}') || doc.id == null) return '';
  return pattern.replace('{id}', encodeURIComponent(String(doc.id)));
}
