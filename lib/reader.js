/*
  The image reader behind POST /api/read-image (functions/api/read-image.js): what math is in this image?

  The page sends { mediaType, data } (a base64 JPEG/PNG/WebP/GIF the browser has
  already shrunk). This forwards it to Anthropic's Messages API with the key kept
  here as the ANTHROPIC_API_KEY secret, and returns
    { reading: { readable, summary, topics[], skills[], keywords[] }, model }
  which the page turns into a library search. Nothing is stored: not the image,
  not the reading.

  Cloudflare Access sits in front of the whole site, so only staff on the allowed
  list reach this; checking Access's signed token (lib/access.js) is a second lock,
  so the API key cannot be spent if Access is ever switched off. Settings:
    ANTHROPIC_API_KEY  required (Settings -> Variables and Secrets, as a secret)
    ACCESS_TEAM_DOMAIN and ACCESS_AUD  required, see lib/access.js
    MODEL              optional, default claude-haiku-5-5 (claude-sonnet-5-5 reads
                       messy handwriting better at about 20x the price)
*/

import { checkAccess } from './access.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const MAX_BASE64 = 7 * 1024 * 1024; // the API takes 10 MB; the page sends far less
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The library's topic tags, so the reader names topics the search knows.
export const TOPICS = ['Algebra', 'Computation', 'Counting', 'Data Analysis', 'Decimals', 'Equations',
  'Estimation', 'Expressions', 'Fractions', 'Functions', 'Geometry', 'Graphing', 'Integers',
  'Measurement', 'Money', 'Number Theory', 'Numerical Fluency (A/S)', 'Numerical Fluency (M/D)',
  'Patterns', 'Percents', 'Place Value', 'Probability', 'Problem Solving', 'Proportions', 'Ratios',
  'Statistics', 'Test Prep', 'Time', 'Trigonometry'];

export const PROMPT = `An instructor at a math learning center uploaded this image (student notes, an example problem, or text) to find practice worksheets on the same math.

Reply with JSON only, no other text:
{"readable": true or false (false if there is no math to read),
 "summary": "one plain sentence saying what math this is",
 "topics": [up to 3 from this list, spelled exactly: ${TOPICS.join(', ')}],
 "skills": [up to 4 short skill phrases a worksheet title would use, e.g. "adding fractions with unlike denominators"],
 "keywords": [up to 10 single search words, e.g. "numerator", "slope"]}

Name the underlying skill, not the specific numbers. Never include a person's name.`;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** The model's reply text -> a clean reading (only the fields and sizes we asked for). */
export function parseReading(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const list = (v, n) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, n);
  return {
    readable: raw.readable !== false,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : '',
    topics: list(raw.topics, 3).filter((t) => TOPICS.includes(t)),
    skills: list(raw.skills, 4),
    keywords: list(raw.keywords, 10),
  };
}

export async function readImage(request, env, fetchImpl = (...args) => fetch(...args)) {
  if (request.method !== 'POST') return json(405, { error: 'Send the image with POST.' });
  try { await checkAccess(request, env, fetchImpl); } catch (err) {
    return json(err.status || 401, { error: err.status ? err.message : 'Sign in through the finder first.' });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json(503, { error: 'The image reader is not set up yet (no ANTHROPIC_API_KEY).' });
  }
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'That upload was not readable.' }); }
  const mediaType = body && body.mediaType, data = body && body.data;
  if (!TYPES.includes(mediaType)) return json(400, { error: 'Use a JPEG, PNG, WebP or GIF image.' });
  if (typeof data !== 'string' || !data.length) return json(400, { error: 'The image was empty.' });
  if (data.length > MAX_BASE64) return json(413, { error: 'That image is too large.' });
  if (!BASE64.test(data)) return json(400, { error: 'That upload was not an image.' });

  const model = env.MODEL || DEFAULT_MODEL;
  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch {
    return json(502, { error: 'The image reader could not be reached. Try again.' });
  }
  if (!res.ok) {
    // Pass on Anthropic's own message (it never contains the image), not the whole reply.
    let message = '';
    try { message = ((await res.json()).error || {}).message || ''; } catch { /* not JSON */ }
    return json(502, { error: `The image reader refused it (${res.status})${message ? ': ' + message.slice(0, 200) : ''}.` });
  }
  let reply;
  try { reply = await res.json(); } catch { return json(502, { error: 'The image reader answered strangely. Try again.' }); }
  const text = (reply.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const reading = parseReading(text);
  if (!reading) return json(502, { error: 'The image reader answered strangely. Try again.' });
  return json(200, { reading, model });
}
