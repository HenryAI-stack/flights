// Cloudflare Pages Function: POST /api/flights
// Logik in lib/flights-core.js, damit sie auch als eigener Worker (worker.js) läuft.
import { handleRequest } from '../../lib/flights-core.js';

export const onRequest = context => handleRequest(context.request, context.env, context);
