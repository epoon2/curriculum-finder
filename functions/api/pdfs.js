// GET /api/pdfs: which document codes have a PDF in the private bucket (see lib/pdf.js).
import { servePdfCodes } from '../../lib/pdf.js';

export function onRequest({ request, env }) {
  return servePdfCodes(request, env);
}
