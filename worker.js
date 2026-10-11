// Eigenständiger Cloudflare Worker – Alternative zur Pages Function.
// Wird von .github/workflows/deploy.yml deployt (Konfiguration: wrangler.toml);
// die Worker-URL landet dabei automatisch in der Seite auf GitHub Pages.
import { handleRequest } from './lib/flights-core.js';

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
