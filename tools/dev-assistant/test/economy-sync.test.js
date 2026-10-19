import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncDocs } from '../src/sync-docs.js';
import { documentBatches } from '../src/economy-sync.js';
import { connectProject } from '../src/mcp-client.js';

const exec = promisify(execFile);
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
async function fixture(t, extraSources = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'economy-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'));
  const originals = { 'README.md': '# App\n\n' + 'Application guide.\n'.repeat(260) };
  for (let i = 0; i < 14; i++) originals[`docs/guide-${String(i).padStart(2, '0')}.md`] = `# Guide ${i}\n\n` + 'Existing documentation.\n'.repeat(200);
  for (const [path, content] of Object.entries(originals)) await writeFile(resolve(root, path), content);
  await writeFile(resolve(root, 'Client.kt'), 'class Client\n');
  if (extraSources) for (let i = 0; i < 20; i++) await writeFile(resolve(root, 'Proof' + i + '.kt'), 'class Proof' + i + ' { val explanation = \"independent contract\" }\n');
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Economy Test');
  await git('add', '.'); await git('commit', '-m', 'initial'); const base = await git('rev-parse', 'HEAD');
  await writeFile(resolve(root, 'Client.kt'), 'class Client(val city: String)\n');
  await git('add', '.'); await git('commit', '-m', 'city');
  const mcp = await connectProject(root); t.after(() => mcp.close());
  return { root, originals, mcp, base, git, config: { projectRoot: root, apiKey: 'fake', model: 'fake', baseUrl: 'https://example.invalid' } };
}
function model(tally, rejectPath = null) {
  return async (_url, init) => {
    const body = JSON.parse(init.body), system = body.messages[0].content, input = JSON.parse(body.messages[1].content);
    tally.calls++; tally.characters += JSON.stringify(body.messages).length;
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(system)) return response({ action: 'done' });
    if (system.startsWith('Ты change_agent')) return new Response(JSON.stringify({ choices: [{ message: { content: 'Client.city added.' } }] }));
    if (/^Ты docs_writer|^Ты docs_sync_agent/.test(system)) {
      for (const path of Object.keys(input.documents)) tally.written.add(path);
      return response({ summary: 'Document city', updates: Object.entries(input.documents).map(([path, content]) => ({ path,
        edits: [{ old: content.split('\n')[0], new: content.split('\n')[0] + '\nClient.city stores the selected city.' }] })) });
    }
    assert.match(system, /^Ты docs_checker|^Ты docs_verifier/);
    const paths = Object.keys(input.documents || input.originals);
    for (const path of paths) tally.checked.add(path);
    const issues = paths.includes(rejectPath) ? [{ path: rejectPath, reason: 'City claim has not been confirmed.' }] : [];
    return response({ approved: !issues.length, reviewedPaths: paths, issues });
  };
}
const tally = () => ({ calls: 0, characters: 0, written: new Set(), checked: new Set() });

test('document packing assigns every file once without rejecting oversized documents', () => {
  const docs = { a: 'a'.repeat(50000), b: 'b'.repeat(400), c: 'c'.repeat(900) };
  const batches = documentBatches(docs);
  assert.equal(batches.length, 2);
  assert.deepEqual(Object.assign({}, ...batches), docs);
});

test('15 real Markdown files use much fewer model calls and input than the old agent loop', async t => {
  const { config, root, originals, mcp, base } = await fixture(t);
  const old = tally(), current = tally();
  const legacy = await syncDocs({ ...config, executionMode: 'thorough', maxCalls: 200, maxInputCharacters: 100000000 }, mcp, base, { fetchImpl: model(old) });
  const result = await syncDocs(config, mcp, base, { apply: true, fetchImpl: model(current) });
  assert.equal(result.updates.length, 15); assert.equal(legacy.updates.length, 15);
  assert.deepEqual(current.written, new Set(Object.keys(originals)));
  assert.deepEqual(current.checked, current.written);
  assert.ok(current.calls <= 8, `economy calls=${current.calls}`);
  assert.ok(current.calls < old.calls * 0.35, `${current.calls} vs ${old.calls}`);
  assert.ok(current.characters < old.characters * 0.5, `${current.characters} vs ${old.characters}`);
  assert.equal(result.usage.apiCalls, current.calls);
  for (const path of Object.keys(originals)) assert.match(await readFile(resolve(root, path), 'utf8'), /Client.city stores/);
  t.diagnostic(JSON.stringify({ oldCalls: old.calls, economyCalls: current.calls, oldInputCharacters: old.characters, economyInputCharacters: current.characters }));
});

test('a rejected last documentation batch never writes earlier approved files', async t => {
  const { config, root, originals, mcp, base } = await fixture(t);
  const current = tally();
  await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: model(current, 'docs/guide-13.md') }), /Проверяющий отклонил/);
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
  assert.ok(current.calls <= 10);
});

test('HTTP 402 stops the economical docs pipeline after one request', async t => {
  const { config, root, originals, mcp, base } = await fixture(t);
  let calls = 0;
  await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async () => { calls++; return new Response('billing', { status: 402 }); } }), error => error.status === 402 && error.usage.apiCalls === 1);
  assert.equal(calls, 1);
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('an identical docs rerun restores signed successful responses without API calls', async t => {
  const { config, root, mcp, base } = await fixture(t);
  const cached = { ...config, cacheDir: resolve(root, '.response-cache') }, calls = tally();
  const first = await syncDocs(cached, mcp, base, { fetchImpl: model(calls) });
  const second = await syncDocs(cached, mcp, base, { fetchImpl: () => { throw new Error('must use exact response cache'); } });
  assert.deepEqual(second.updates, first.updates);
  assert.equal(second.usage.apiCalls, 0);
  assert.equal(second.usage.cacheHits, first.usage.apiCalls);
});

test('an explicit missing-source request reads the indexed file locally before writing', async t => {
  const { config, mcp, base } = await fixture(t, true);
  const current = tally(); let requested = false;
  const simulate = model(current);
  const result = await syncDocs(config, mcp, base, { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
    if (!requested && body.messages[0].content.startsWith('Ты docs_writer')) {
      requested = true;
      return response({ readPaths: [input.sourceCatalog.find(s => !input.sources.some(source => source.path === s.path)).path], reason: 'Compare previous contract.' });
    }
    return simulate(url, init);
  } });
  assert.ok(requested); assert.equal(result.verification.reviewedPaths.length, 15);
});

test('plan-only reads real files and reports all batches without model calls or a key', async t => {
  const { config, originals, mcp, base } = await fixture(t);
  const result = await syncDocs({ ...config, apiKey: '' }, mcp, base, { planOnly: true, fetchImpl: () => { throw new Error('no API calls allowed'); } });
  assert.equal(result.usage.apiCalls, 0);
  assert.deepEqual(result.plan.batches.flat(), Object.keys(originals));
  assert.equal(result.plan.expectedCalls, result.plan.batches.length * 2);
  assert.equal(result.updates.length, 0);
});
