// Startet den Deploy-Workflow auf GitHub (workflow_dispatch). Wird vom Cron-Trigger
// des Workers aufgerufen, weil GitHubs eigener Zeitplan oft Stunden zu spät oder gar
// nicht startet. Benötigt das Worker-Secret GH_DISPATCH_TOKEN (Fine-grained Token,
// nur dieses Repo, „Actions: Read and write“).
export async function dispatchDeploy(env, fetchImpl = fetch) {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.log('GH_DISPATCH_TOKEN fehlt – Deploy wird nicht angestoßen.');
    return { ok: false, skipped: true };
  }
  const repo = env.GH_REPO || 'HenryAI-stack/flights';
  const workflow = env.GH_WORKFLOW || 'deploy.yml';
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'skysearch-api',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main' }),
  });
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    console.error(`Deploy anstoßen fehlgeschlagen: HTTP ${res.status} ${text.slice(0, 300)}`);
    return { ok: false, status: res.status };
  }
  console.log(`Deploy-Workflow ${workflow} in ${repo} gestartet.`);
  return { ok: true, status: res.status };
}
