/*
  POST /api/read-image. The work is in lib/reader.js (kept outside functions/ so
  only this file becomes a route, and so tests can call it directly).
*/
import { readImage } from '../../lib/reader.js';

export function onRequest({ request, env }) {
  return readImage(request, env);
}
