// GET /api/text: the PDFs' text from the private bucket, for searching inside them (see lib/library.js).
import { serveText } from '../../lib/library.js';

export function onRequest({ request, env }) {
  return serveText(request, env);
}
