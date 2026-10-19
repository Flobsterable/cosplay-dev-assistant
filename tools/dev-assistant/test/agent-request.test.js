import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { normalizeRequest, prepareRequest, writeOutputs, recoveryMarker, resolvePublisher, updateRecovery, createGitHubApi } = require('../../../.github/scripts/agent-request.cjs');

const repository = 'Flobsterable/cosplay-2';
const base = 'a'.repeat(40), head = 'b'.repeat(40), current = 'c'.repeat(40);
const payload = () => ({ repository, base, head, branch: 'develop', pr: 12 });
const review = (overrides = {}) => ({ state: 'open', draft: false, number: 12,
  head: { sha: head, repo: { full_name: repository } }, base: { sha: base, ref: 'develop', repo: { full_name: repository } }, ...overrides });
const event = (action = 'agent-review', value = payload()) => ({ action, client_payload: value });
const runUrl = 'https://github.com/Flobsterable/cosplay-dev-assistant/actions/runs/123';
const request = () => ({ kind: 'docs-sync', ...payload(), pr: '' });

test('dispatch and manual requests accept exact allowlisted repository and strict metadata', () => {
  assert.deepEqual(normalizeRequest('repository_dispatch', event()), { kind: 'review', ...payload(), pr: '12' });
  assert.equal(normalizeRequest('workflow_dispatch', { inputs: { type: 'docs-sync', ...payload(), pr: '' } }).kind, 'docs-sync');
  assert.equal(normalizeRequest('repository_dispatch', event('agent-review', { ...payload(), repository: 'Other/project' }),
    { allowedProjects: `${repository},Other/project` }).repository, 'Other/project');
});

test('forged repository, SHA, action, branch and PR fail before any API access', async () => {
  const invalid = [
    event('agent-review', { ...payload(), repository: 'Flobsterable/cosplay-2-evil' }),
    event('agent-review', { ...payload(), repository: '../cosplay-2' }),
    event('agent-review', { ...payload(), repository: repository.toLowerCase() }),
    event('agent-review', { ...payload(), head: 'HEAD' }),
    event('agent-review', { ...payload(), base: 'A'.repeat(40) }),
    event('agent-review', { ...payload(), branch: 'develop\nforged=true' }),
    event('agent-docs-sync', { ...payload(), branch: 'feature/x' }),
    event('agent-review', { ...payload(), pr: '1;echo' }),
    event('agent-review', { ...payload(), pr: 0 }),
    event('agent-review', { ...payload(), pr: Number.MAX_SAFE_INTEGER + 1 }),
    event('other-action'), event('agent-review', null)
  ];
  for (const value of invalid) {
    let calls = 0;
    await assert.rejects(prepareRequest({ eventName: 'repository_dispatch', event: value,
      api: async () => { calls++; return review(); } }));
    assert.equal(calls, 0);
  }
});

test('review checks same-repo PR, exact base branch and current open non-draft SHAs', async () => {
  const valid = await prepareRequest({ eventName: 'repository_dispatch', event: event(), api: async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, `/repos/${repository}/pulls/12`); return review();
  } });
  assert.equal(valid.checkout, head);
  assert.equal(valid.skip, 'false');
  for (const metadata of [review({ head: { sha: head, repo: { full_name: 'attacker/fork' } } }),
    review({ base: { sha: base, ref: 'main', repo: { full_name: repository } } })]) {
    await assert.rejects(prepareRequest({ eventName: 'repository_dispatch', event: event(), api: async () => metadata }));
  }
  for (const metadata of [review({ state: 'closed' }), review({ draft: true }),
    review({ head: { sha: current, repo: { full_name: repository } } }),
    review({ base: { sha: current, ref: 'develop', repo: { full_name: repository } } })]) {
    assert.equal((await prepareRequest({ eventName: 'repository_dispatch', event: event(), api: async () => metadata })).skip, 'true');
  }
});

test('docs keep historical range while checkout follows current allowed branch', async () => {
  const prepared = await prepareRequest({ eventName: 'repository_dispatch', event: event('agent-docs-sync'),
    api: async (method, path) => { assert.equal(method, 'GET'); assert.equal(path, `/repos/${repository}/branches/develop`); return { commit: { sha: current } }; } });
  assert.equal(prepared.head, head);
  assert.equal(prepared.base, base);
  assert.equal(prepared.checkout, current);
  assert.equal(prepared.skip, 'false');
  await assert.rejects(prepareRequest({ eventName: 'repository_dispatch', event: event('agent-docs-sync'), api: async () => ({ commit: { sha: 'HEAD' } }) }));
});

test('workflow outputs include normalized fields and cannot inject extra output lines', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-request-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'outputs');
  await writeOutputs({ ...request(), checkout: current, skip: 'false', publisher: 'pat-owner' }, output);
  const saved = await readFile(output, 'utf8');
  assert.equal(saved, `kind=docs-sync\nrepository=${repository}\nbase=${base}\nhead=${head}\nbranch=develop\npr=\ncheckout=${current}\nskip=false\npublisher=pat-owner\n`);
  await assert.rejects(writeOutputs({ ...request(), checkout: `${head}\nskip=false` }, output));
  assert.equal(await readFile(output, 'utf8'), saved);
});

test('publisher identity uses authenticated PAT owner and rejects missing or malformed logins', async () => {
  assert.equal(await resolvePublisher(async (method, path) => { assert.equal(method, 'GET'); assert.equal(path, '/user'); return { login: 'Flobsterable' }; }), 'Flobsterable');
  for (const login of ['', 'github-actions[bot]', 'owner\noutput=forged', undefined]) {
    await assert.rejects(resolvePublisher(async () => ({ login })));
  }
});

test('failure recovery creates metadata-only issue with exact branch/head marker', async () => {
  const calls = [];
  const tracked = await updateRecovery({ request: request(), result: 'failure', runUrl,
    api: async (method, path, body) => { calls.push({ method, path, body }); return method === 'GET' ? [] : { number: 34 }; } });
  assert.deepEqual(tracked, { action: 'created', number: 34 });
  const posted = calls.find(call => call.method === 'POST');
  assert.equal(posted.path, `/repos/${repository}/issues`);
  assert.ok(posted.body.body.includes(recoveryMarker(request())));
  assert.ok(posted.body.body.includes(`${base}..${head}`));
  assert.ok(posted.body.body.includes(runUrl));
  assert.ok(!posted.body.body.includes('apiKey'));
});

test('recovery updates PAT-authored tracker and closes only an exact marker after actual success', async () => {
  const issue = { number: 34, state: 'open', user: { login: 'human-pat-owner' }, body: recoveryMarker(request()) };
  for (const result of ['failure', 'cancelled', 'success']) {
    const calls = [];
    const updated = await updateRecovery({ request: request(), result, runUrl,
      api: async (method, path, body) => { calls.push({ method, path, body }); return method === 'GET' ? [issue] : {}; } });
    assert.equal(updated.action, result === 'success' ? 'closed' : 'updated');
    const patch = calls.find(call => call.method === 'PATCH');
    assert.equal(patch.path, `/repos/${repository}/issues/34`);
    assert.equal(patch.body.state, result === 'success' ? 'closed' : 'open');
  }
  let requests = 0;
  assert.deepEqual(await updateRecovery({ request: request(), result: 'skipped', runUrl, api: async () => { requests++; } }), { action: 'none' });
  assert.equal(requests, 0);
  assert.deepEqual(await updateRecovery({ request: request(), result: 'success', runUrl,
    api: async () => [{ ...issue, body: recoveryMarker({ ...request(), head: current }) }] }), { action: 'none' });
});

test('status validation rejects malformed metadata and ignores PRs impersonating issue marker', async () => {
  let calls = 0;
  await assert.rejects(updateRecovery({ request: { ...request(), repository: 'attacker/project' }, result: 'failure', runUrl,
    api: async () => { calls++; } }));
  assert.equal(calls, 0);
  await assert.rejects(updateRecovery({ request: request(), result: 'failure', runUrl: 'https://example.com/not-a-run', api: async () => { calls++; } }));
  assert.equal(calls, 0);
  const methods = [];
  await updateRecovery({ request: request(), result: 'failure', runUrl,
    api: async method => { methods.push(method); return method === 'GET' ? [{ number: 8, body: recoveryMarker(request()), pull_request: {} }] : { number: 9 }; } });
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('successful central replay closes legacy app recovery debt without creating a duplicate', async () => {
  const calls = [];
  const recovered = await updateRecovery({ request: request(), result: 'success', runUrl,
    api: async (method, path, body) => { calls.push({ method, path, body }); return method === 'GET'
      ? [{ number: 16, state: 'open', user: { login: 'github-actions[bot]' }, body: `Old recovery issue\n<!-- docs-sync-recovery:develop:${head} -->\n` }] : {}; } });
  assert.deepEqual(recovered, { action: 'closed', number: 16 });
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(calls.at(-1).body.state, 'closed');
  assert.ok(calls.every(call => call.method !== 'POST'));
});

test('GitHub API wrapper sends only project credential and redacts error response bodies', async () => {
  const api = createGitHubApi('secret-project-token', { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(init.headers.Authorization, 'Bearer secret-project-token');
    return new Response('secret-project-token private information', { status: 403 });
  } });
  await assert.rejects(api('GET', '/user'), error => /HTTP 403/.test(error.message) && !error.message.includes('secret-project-token'));
  assert.throws(() => createGitHubApi(''));
});
