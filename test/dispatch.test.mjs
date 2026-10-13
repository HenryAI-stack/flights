import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDeploy } from '../lib/dispatch.js';
import worker from '../worker.js';

test('dispatchDeploy startet den Workflow per workflow_dispatch', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  const r = await dispatchDeploy({ GH_DISPATCH_TOKEN: 'tok', GH_REPO: 'o/r', GH_WORKFLOW: 'deploy.yml' }, fetch);
  assert.deepEqual(r, { ok: true, status: 204 });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/workflows/deploy.yml/dispatches');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
});

test('dispatchDeploy ohne Token tut nichts', async () => {
  let called = false;
  const r = await dispatchDeploy({}, async () => { called = true; });
  assert.equal(r.skipped, true);
  assert.equal(called, false);
});

test('dispatchDeploy meldet Fehler von GitHub', async () => {
  const r = await dispatchDeploy({ GH_DISPATCH_TOKEN: 'x' }, async () => new Response('Bad credentials', { status: 401 }));
  assert.deepEqual(r, { ok: false, status: 401 });
});

test('Worker hat einen scheduled-Handler', async () => {
  const waited = [];
  worker.scheduled({}, {}, { waitUntil: p => waited.push(p) });
  assert.equal(waited.length, 1);
  assert.equal((await waited[0]).skipped, true);
});
