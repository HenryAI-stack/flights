// Eigenständiger Cloudflare Worker – Alternative zur Pages Function.
// Deploy: wrangler deploy worker.js --name skysearch-api --compatibility-date 2024-09-01
//         wrangler secret put SERPAPI_KEY --name skysearch-api
// Danach die Worker-URL in den Einstellungen der App als Proxy-URL eintragen.
import { handleRequest } from './lib/flights-core.js';

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
