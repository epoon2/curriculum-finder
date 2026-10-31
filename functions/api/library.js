// GET /api/library: the curriculum library from the private bucket (see lib/library.js).
import { serveLibrary } from '../../lib/library.js';

export function onRequest({ request, env }) {
  return serveLibrary(request, env);
}
