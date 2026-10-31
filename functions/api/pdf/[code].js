/*
  GET /api/pdf/<code>. The work is in lib/pdf.js (kept outside functions/ so only
  this file becomes a route, and so tests can call it directly).
*/
import { servePdf } from '../../../lib/pdf.js';

export function onRequest({ request, env, params }) {
  return servePdf(request, env, params.code);
}
