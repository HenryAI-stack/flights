// Eigenständiger Cloudflare Worker – Alternative zur Pages Function.
// Wird von .github/workflows/deploy.yml deployt (Konfiguration: wrangler.toml);
// die Worker-URL landet dabei automatisch in der Seite auf GitHub Pages.
import { handleRequest } from './lib/flights-core.js';
import { dispatchDeploy } from './lib/dispatch.js';

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  // Cron-Trigger (wrangler.toml): stößt täglich den Deploy an, der die Deals aktualisiert.
  scheduled: (event, env, ctx) => ctx.waitUntil(dispatchDeploy(env)),
};
