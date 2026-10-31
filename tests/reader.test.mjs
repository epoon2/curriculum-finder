// The image reader (lib/reader.js), with Anthropic's API and Workers AI replaced by fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImage, parseReading, replyText, DEFAULT_MODEL, WORKERS_AI_MODEL, MAX_BASE64, TOPICS } from '../lib/reader.js';
import { makeAccess, ACCESS_ENV } from './access_helper.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const ENV = { ANTHROPIC_API_KEY: 'test-key-not-real', ...ACCESS_ENV };
const access = await makeAccess();
const TOKEN = await access.sign();

function request(body, { access = true, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (access) headers['cf-access-jwt-assertion'] = access === true ? TOKEN : access;
  return new Request('https://finder.example/api/read-image', {
    method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

function fakeAnthropic(replyText, { status = 200, error } = {}) {
  const calls = [];
  const fetchImpl = access.fetchWith(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: error || 'nope' } }), { status });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: replyText }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetchImpl };
}

const GOOD = JSON.stringify({
  readable: true, summary: 'Adding two fractions with different denominators.',
  topics: ['Fractions', 'Not A Real Topic'], skills: ['adding fractions with unlike denominators'],
  keywords: ['denominator', 'common denominator'],
});

test('a readable image comes back as a reading, and the key and image go to Anthropic', async () => {
  const fake = fakeAnthropic('Here you go:\n' + GOOD);
  const res = await readImage(request({ mediaType: 'image/png', data: PNG }), ENV, fake.fetchImpl);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.model, DEFAULT_MODEL);
  assert.deepEqual(out.reading.topics, ['Fractions'], 'topics outside the library list are dropped');
  assert.equal(out.reading.skills[0], 'adding fractions with unlike denominators');
  const call = fake.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'test-key-not-real');
  const [image, prompt] = call.body.messages[0].content;
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
  for (const t of TOPICS) assert.ok(prompt.text.includes(t));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('MODEL picks another model', async () => {
  const fake = fakeAnthropic(GOOD);
  const res = await readImage(request({ mediaType: 'image/jpeg', data: PNG }), { ...ENV, MODEL: 'claude-sonnet-5-5' }, fake.fetchImpl);
  assert.equal((await res.json()).model, 'claude-sonnet-5-5');
  assert.equal(fake.calls[0].body.model, 'claude-sonnet-5-5');
});

test('refused before calling Anthropic: no Access sign-in, a typed-in header, no key, wrong method, bad uploads', async () => {
  const fake = fakeAnthropic(GOOD);
  const cases = [
    [request({ mediaType: 'image/png', data: PNG }, { access: false }), ENV, 401],
    [request({ mediaType: 'image/png', data: PNG }, { access: 'header.payload.signature' }), ENV, 401],
    [request({ mediaType: 'image/png', data: PNG }), { ANTHROPIC_API_KEY: 'test-key-not-real' }, 503],
    [request({ mediaType: 'image/png', data: PNG }), ACCESS_ENV, 503],
    [request({ mediaType: 'image/png', data: PNG }), { ...ACCESS_ENV, AI: {} }, 503],
    [request(null, { method: 'GET' }), ENV, 405],
    [request('not json'), ENV, 400],
    [request({ mediaType: 'application/pdf', data: PNG }), ENV, 400],
    [request({ mediaType: 'image/png', data: '' }), ENV, 400],
    [request({ mediaType: 'image/png', data: 'not base64 at all!' }), ENV, 400],
    [request({ mediaType: 'image/png', data: 'A'.repeat(MAX_BASE64 + 4) }), ENV, 413],
  ];
  for (const [req, env, status] of cases) {
    const res = await readImage(req, env, fake.fetchImpl);
    assert.equal(res.status, status);
    assert.ok((await res.json()).error);
  }
  assert.equal(fake.calls.length, 0);
});

test('Anthropic errors and odd replies become a clear message, never the image', async () => {
  let res = await readImage(request({ mediaType: 'image/png', data: PNG }), ENV,
    fakeAnthropic('', { status: 401, error: 'invalid x-api-key' }).fetchImpl);
  assert.equal(res.status, 502);
  const msg = (await res.json()).error;
  assert.match(msg, /401/);
  assert.ok(!msg.includes(PNG));
  res = await readImage(request({ mediaType: 'image/png', data: PNG }), ENV, fakeAnthropic('I cannot help with that').fetchImpl);
  assert.equal(res.status, 502);
  res = await readImage(request({ mediaType: 'image/png', data: PNG }), ENV,
    access.fetchWith(async () => { throw new TypeError('network'); }));
  assert.equal(res.status, 502);
});

test('replies are cut to the fields and sizes asked for', () => {
  const r = parseReading(JSON.stringify({
    readable: false, summary: 'x'.repeat(1000), topics: ['Geometry', 5, 'Geometry'],
    skills: ['a', 'b', 'c', 'd', 'e'], keywords: Array(20).fill('k'), extra: '<script>',
  }));
  assert.equal(r.readable, false);
  assert.equal(r.summary.length, 300);
  assert.equal(r.skills.length, 4);
  assert.equal(r.keywords.length, 10);
  assert.ok(!('extra' in r));
  assert.equal(parseReading('no json here'), null);
});

// --- Workers AI -----------------------------------------------------------------------
function fakeAi(answer) {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); return typeof answer === 'function' ? answer() : answer; } };
}
const noFetch = access.fetchWith(async () => { throw new Error('Workers AI needs no fetch'); });

test('with only the AI binding, Gemma 4 on Workers AI reads the image', async () => {
  const AI = fakeAi({ choices: [{ message: { role: 'assistant', content: GOOD } }] });
  const res = await readImage(request({ mediaType: 'image/png', data: PNG }), { ...ACCESS_ENV, AI }, noFetch);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.model, WORKERS_AI_MODEL);
  assert.deepEqual(out.reading.topics, ['Fractions']);
  const { model, input } = AI.calls[0];
  assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
  const [prompt, image] = input.messages[0].content;
  assert.equal(prompt.type, 'text');
  assert.ok(prompt.text.includes('Reply with JSON only'));
  assert.deepEqual(image, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } });
  assert.deepEqual(input.response_format, { type: 'json_object' });
  assert.deepEqual(input.chat_template_kwargs, { enable_thinking: false }, 'no reasoning tokens');
  assert.ok(input.max_completion_tokens <= 500);
});

test('AI_MODEL picks another Workers AI model; a Claude key, when set, is used instead', async () => {
  const AI = fakeAi({ response: GOOD });
  let res = await readImage(request({ mediaType: 'image/jpeg', data: PNG }), { ...ACCESS_ENV, AI, AI_MODEL: '@cf/other/vision' }, noFetch);
  assert.equal((await res.json()).model, '@cf/other/vision');
  const fake = fakeAnthropic(GOOD);
  res = await readImage(request({ mediaType: 'image/jpeg', data: PNG }), { ...ENV, AI }, fake.fetchImpl);
  assert.equal((await res.json()).model, DEFAULT_MODEL);
  assert.equal(fake.calls.length, 1);
  assert.equal(AI.calls.length, 1, 'Workers AI not called when the key is there');
});

test('Workers AI errors: a used-up allowance says so; others are short and never echo the image', async () => {
  const used = fakeAi(() => { throw new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons'); });
  let res = await readImage(request({ mediaType: 'image/png', data: PNG }), { ...ACCESS_ENV, AI: used }, noFetch);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /used up/);
  const broken = fakeAi(() => { throw new Error('bad input ' + 'Q'.repeat(500)); });
  res = await readImage(request({ mediaType: 'image/png', data: PNG }), { ...ACCESS_ENV, AI: broken }, noFetch);
  assert.equal(res.status, 502);
  const msg = (await res.json()).error;
  assert.ok(msg.length < 260 && !msg.includes('Q'.repeat(80)));
  res = await readImage(request({ mediaType: 'image/png', data: PNG }), { ...ACCESS_ENV, AI: fakeAi({ choices: [] }) }, noFetch);
  assert.equal(res.status, 502);
});

test('Workers AI answers come in a few shapes', () => {
  assert.equal(replyText({ choices: [{ message: { content: 'a' } }] }), 'a');
  assert.equal(replyText({ response: 'b' }), 'b');
  assert.equal(replyText({ response: { readable: true } }), '{"readable":true}');
  assert.equal(replyText('c'), 'c');
  assert.equal(replyText(null), '');
});
