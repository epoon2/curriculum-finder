/*
  The Curriculum Finder page: loads the library from /api/library (private, staff
  sign-in only), searches it as you type, and turns an uploaded image into a search
  through /api/read-image. Everything is
  built with textContent, never innerHTML, so nothing in the library or the
  reader's reply can run as code here.
*/
import { buildIndex, search, terms, queryFromReading, docLink } from './search.js';

const PAGE = 25;
const MAX_EDGE = 2000;           // images are shrunk to this long edge before upload
const TYPE_LABELS = {
  'PK': 'PK', 'FO': 'FO', 'GF': 'GF', 'WOB - Chapters': 'WOB chapters', 'WOB - Complete': 'Whole WOBs',
};
const EXAMPLES = ['adding fractions with unlike denominators', 'long division', 'slope of a line',
  'percent of change', 'telling time', 'counting coins', 'PK-0186'];

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const state = { index: null, results: [], shown: 0, boostTags: [], imageUrl: '', pdfs: new Set(),
  platform: 'the curriculum system', docUrl: '' };

async function loadLibrary() {
  const res = await fetch('api/library', { credentials: 'same-origin' });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  if (!res.ok || !isJson) {
    const said = isJson ? (await res.json().catch(() => ({}))).error : '';
    throw new Error(said || 'The library could not be loaded. Reload the page (your sign-in may have expired).');
  }
  const lib = await res.json();
  state.index = buildIndex(lib.documents);
  // The center's own names travel in the (private) library, not in this code.
  if (typeof lib.platform === 'string' && lib.platform.trim()) state.platform = lib.platform.trim();
  if (typeof lib.docUrl === 'string') state.docUrl = lib.docUrl;
  if (typeof lib.center === 'string' && lib.center.trim()) $('center').textContent = lib.center.trim() + ' · ';
  const when = /(\d+_\d+_\d{4})/.exec(lib.source || '');
  $('libinfo').textContent = `${lib.documents.length.toLocaleString()} documents` +
    (when ? `, exported from ${state.platform} on ${when[1].replace(/_/g, '/')}` : '');
  setUpFilters();
}

// The codes with a PDF in the finder's private storage. If that isn't set up, or the list
// can't be fetched, the cards simply have no "Open PDF" link.
async function loadPdfCodes() {
  try {
    const res = await fetch('api/pdfs', { credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
    const { codes } = await res.json();
    state.pdfs = new Set(Array.isArray(codes) ? codes : []);
  } catch { return; }
  if (!state.pdfs.size || !state.results.length) return;
  const had = state.shown;              // redraw the cards already showing, now with the links
  state.shown = 0;
  do render(); while (state.shown < had && state.shown < state.results.length);
}

function setUpFilters() {
  const boxes = $('typeBoxes');
  const order = Object.keys(TYPE_LABELS);
  const types = [...state.index.types].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  for (const t of types) {
    const id = 'type-' + t.replace(/\W+/g, '-');
    boxes.append(el('label', { for: id, class: 'check' },
      el('input', { type: 'checkbox', id, value: t, onchange: run }), TYPE_LABELS[t] || t));
  }
  for (const t of state.index.tags) $('tag').append(el('option', { value: t }, t));
  for (const l of state.index.levels) $('level').append(el('option', { value: l }, l));
  $('tag').addEventListener('change', run);
  $('level').addEventListener('change', run);
  for (const ex of EXAMPLES) {
    $('examples').append(el('button', { type: 'button', class: 'chip', onclick: () => { $('q').value = ex; run(); } }, ex));
  }
}

function filters() {
  return {
    types: [...document.querySelectorAll('#typeBoxes input:checked')].map((i) => i.value),
    tag: $('tag').value,
    level: $('level').value,
  };
}

function run() {
  if (!state.index) return;
  const q = $('q').value.trim();
  const f = filters();
  const active = q || f.types.length || f.tag || f.level;
  $('welcome').hidden = Boolean(active || state.boostTags.length);
  if (!active && !state.boostTags.length) {
    state.results = [];
    render();
    $('status').textContent = '';
    return;
  }
  state.results = search(state.index, q, { ...f, boostTags: state.boostTags, limit: 500 });
  state.shown = 0;
  render();
  const n = state.results.length;
  $('status').textContent = n ? `${n === 500 ? '500+' : n} match${n === 1 ? '' : 'es'}` +
    (q ? '' : ' (no words: filters only, in code order)') :
    'No matches. Try fewer or simpler words, or clear the filters.';
}

function render() {
  const list = $('results');
  if (state.shown === 0) list.replaceChildren();
  const next = state.results.slice(state.shown, state.shown + PAGE);
  const matched = (r) => new Set(r.matched);
  for (const r of next) list.append(card(r.doc, matched(r)));
  state.shown += next.length;
  $('more').hidden = state.shown >= state.results.length;
}

// Title or skills text with the searched words marked.
function marked(text, matched) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(\s+)/)) {
    const hit = part.trim() && terms(part).some((t) => matched.has(t));
    frag.append(hit ? el('mark', {}, part) : part);
  }
  return frag;
}

function card(doc, matched) {
  const link = docLink(doc, state.docUrl);
  const testPrep = /-TP$/.test(doc.code);
  const meta = [TYPE_LABELS[doc.type] || doc.type, doc.level, doc.pages ? `${doc.pages} page${doc.pages === 1 ? '' : 's'}` : '',
    testPrep ? 'Test Prep version' : ''].filter(Boolean).join(' · ');
  const copy = el('button', { type: 'button', class: 'link', title: 'Copy the code' }, 'Copy code');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(doc.code); copy.textContent = 'Copied'; }
    catch { copy.textContent = doc.code; }
    setTimeout(() => { copy.textContent = 'Copy code'; }, 1500);
  });
  return el('li', { class: 'card' },
    el('div', { class: 'head' },
      el('span', { class: 'code' }, doc.code),
      el('h3', {}, marked(doc.title, matched))),
    el('p', { class: 'meta' }, meta),
    doc.skills ? el('p', { class: 'skills' }, marked(doc.skills, matched)) : null,
    (doc.tags || []).length ? el('p', { class: 'tags' }, ...doc.tags.map((t) => el('span', { class: 'tag' }, t))) : null,
    el('p', { class: 'actions' },
      // The PDF from the finder's private storage (/api/pdf/<code>, staff sign-in only).
      state.pdfs.has(doc.code)
        ? el('a', { href: '/api/pdf/' + encodeURIComponent(doc.code), target: '_blank', rel: 'noopener' }, 'Open PDF') : null,
      link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, `Open in ${state.platform}`)
        : el('span', { class: 'muted' }, `Look up ${doc.code} in ${state.platform}`),
      copy));
}

/* --- image search --------------------------------------------------------------- */

async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';              // transparent PNGs read better on white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });
  return { blob, data: String(dataUrl).split(',')[1] };
}

async function searchByImage(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) {
    $('status').textContent = 'That is not an image.';
    return;
  }
  $('status').textContent = 'Reading the image…';
  $('imgLabel').classList.add('busy');
  try {
    const { blob, data } = await shrink(file);
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = URL.createObjectURL(blob);
    $('thumb').src = state.imageUrl;
    const res = await fetch('api/read-image', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/jpeg', data }),
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error('Your sign-in may have expired. Reload the page and try again.');
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error || 'The image could not be read.');
    showReading(reply.reading);
  } catch (err) {
    $('status').textContent = err.message || 'The image could not be read.';
  } finally {
    $('imgLabel').classList.remove('busy');
    $('img').value = '';
  }
}

function showReading(reading) {
  $('reading').hidden = false;
  const chips = $('readingChips');
  chips.replaceChildren();
  if (!reading.readable) {
    $('readingText').textContent = 'No math found in that image. Try a clearer or closer photo.';
    state.boostTags = [];
    return;
  }
  $('readingText').textContent = reading.summary || 'Read the image.';
  state.boostTags = reading.topics || [];
  for (const t of reading.topics || []) chips.append(el('span', { class: 'chip tag' }, t));
  for (const s of reading.skills || []) {
    chips.append(el('button', { type: 'button', class: 'chip', title: 'Search just this skill',
      onclick: () => { $('q').value = s; run(); } }, s));
  }
  $('q').value = queryFromReading(reading);
  run();
}

function clearImage() {
  $('reading').hidden = true;
  state.boostTags = [];
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = '';
  run();
}

/* --- wiring ------------------------------------------------------------------- */

let timer = 0;
function wire() {
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  $('more').addEventListener('click', render);
  $('clearFilters').addEventListener('click', () => {
    for (const box of document.querySelectorAll('#typeBoxes input')) box.checked = false;
    $('tag').value = ''; $('level').value = '';
    run();
  });
  $('clearImage').addEventListener('click', clearImage);
  $('img').addEventListener('change', (e) => searchByImage(e.target.files[0]));
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); searchByImage(file); }
  });
  const main = $('main');
  main.addEventListener('dragover', (e) => { e.preventDefault(); main.classList.add('dropping'); });
  main.addEventListener('dragleave', () => main.classList.remove('dropping'));
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    main.classList.remove('dropping');
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) searchByImage(file);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus(); }
  });
}

wire();
loadPdfCodes();
loadLibrary().then(() => { $('q').focus(); run(); }).catch((err) => {
  $('libinfo').textContent = 'library not loaded';
  $('status').textContent = err.message;
});
