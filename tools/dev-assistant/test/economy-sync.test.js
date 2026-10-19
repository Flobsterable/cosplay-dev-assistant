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
async function fixture(t, extraSources = false, documentPaths = null) {
  const root = await mkdtemp(resolve(tmpdir(), 'economy-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'));
  const originals = {};
  if (documentPaths) {
    for (const [i, path] of documentPaths.entries()) originals[path] = `# Guide ${i}\n\n` + 'Existing documentation.\n'.repeat(i < 7 ? 120 : 300);
  } else {
    originals['README.md'] = '# App\n\n' + 'Application guide.\n'.repeat(260);
    for (let i = 0; i < 14; i++) originals[`docs/guide-${String(i).padStart(2, '0')}.md`] = `# Guide ${i}\n\n` + 'Existing documentation.\n'.repeat(200);
  }
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

const actualPaths = ['README.md', 'docs/README.md', 'docs/ai-review.md', 'docs/architecture.md', 'docs/data-model.md',
  'docs/dev-assistant.md', 'docs/development.md', 'docs/feature-flows.md', 'docs/features.md', 'docs/screens.md'];

test('known future-batch proposals are deferred locally with no paid repair and every document is checked', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  const current = tally(), events = [], futureReceived = new Set();
  const simulate = model(current);
  let writerCalls = 0, requests = 0;
  const result = await syncDocs(config, mcp, base, { apply: true, onEvent: event => events.push(event), fetchImpl: async (url, init) => {
    requests++;
    const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
    if (body.messages[0].content.startsWith('Ты docs_writer')) {
      writerCalls++;
      assert.deepEqual(input.allowedPaths, Object.keys(input.documents));
      assert.match(body.messages[0].content, /documentCatalog — справочник/);
      if (writerCalls === 1) {
        assert.deepEqual(input.allowedPaths, actualPaths.slice(0, 7));
        return response({ summary: 'Document city in relevant guides', updates: ['README.md', 'docs/features.md', 'docs/screens.md', 'docs/feature-flows.md'].map(path => ({ path,
          edits: [{ old: originals[path].split('\n')[0], new: originals[path].split('\n')[0] + '\nClient.city stores the selected city.' }] })) });
      }
      for (const update of input.deferredSuggestions || []) {
        assert.ok(input.allowedPaths.includes(update.path));
        futureReceived.add(update.path);
      }
    }
    return simulate(url, init);
  } });
  assert.equal(requests, result.plan.expectedCalls);
  assert.equal(result.usage.apiCalls, requests);
  assert.deepEqual(futureReceived, new Set(['docs/features.md', 'docs/screens.md', 'docs/feature-flows.md']));
  assert.deepEqual(current.checked, new Set(actualPaths));
  assert.equal(result.verification.reviewedPaths.length, actualPaths.length);
  assert.equal(events.filter(event => event.status === 'deferred').length, 3);
  assert.equal(result.updates.length, 4);
  for (const path of ['docs/features.md', 'docs/screens.md', 'docs/feature-flows.md']) assert.match(await readFile(resolve(root, path), 'utf8'), /Client.city stores/);
  assert.equal(await readFile(resolve(root, 'docs/architecture.md'), 'utf8'), originals['docs/architecture.md']);
});

test('unknown or traversal paths and malformed current edits are rejected before any document write', async t => {
  const { config, root, originals, mcp, base } = await fixture(t);
  for (const update of [
    { path: '../../README.md', edits: [] },
    { path: 'docs/nonexistent.md', edits: [] },
    { path: 'README.md', edits: [{ old: 'no such original fragment', new: 'new claim' }] }
  ]) {
    let requests = 0;
    await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async () => {
      requests++;
      return response({ summary: 'invalid', updates: [update] });
    } }));
    assert.equal(requests, 1);
  }
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('deferred proposals still obey the shared budget and do not bypass checker approval', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  let requests = 0;
  await assert.rejects(syncDocs({ ...config, maxCalls: 1 }, mcp, base, { apply: true, fetchImpl: async () => {
    requests++;
    return response({ summary: 'future suggestion', updates: [{ path: 'docs/features.md', edits: [{ old: '# Guide 8', new: '# Guide 8\nClient.city stores the city.' }] }] });
  } }), error => error.code === 'LLM_BUDGET_EXCEEDED' && error.usage.apiCalls === 1);
  assert.equal(requests, 1);
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('late proposals for already reviewed documents stop before saving earlier approved updates', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  let writers = 0;
  const simulate = model(tally());
  await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.messages[0].content.startsWith('Ты docs_writer') && ++writers === 2) return response({ summary: 'late proposal', updates: [
      { path: 'README.md', edits: [{ old: '# Guide 0', new: '# Guide 0\nLate change.' }] }
    ] });
    return simulate(url, init);
  } }), /уже проверенной порции/);
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('partial checker verdict retains two reviewed docs and checks only the other five without rerunning writer', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  let writerCalls = 0, checkerCalls = 0, requests = 0;
  const reviewed = ['README.md', 'docs/architecture.md'];
  const simulate = model(tally());
  const result = await syncDocs(config, mcp, base, { apply: true, fetchImpl: async (url, init) => {
    requests++;
    const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
    // No target may be written while any required checker call is pending.
    for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
    if (body.messages[0].content.startsWith('Ты docs_writer')) {
      writerCalls++;
      if (writerCalls === 1) return response({ summary: 'Describe city', updates: reviewed.map(path => ({ path,
        edits: [{ old: originals[path].split('\n')[0], new: originals[path].split('\n')[0] + '\nClient.city stores the selected city.' }] })) });
    } else {
      checkerCalls++;
      assert.deepEqual(input.requiredPaths, Object.keys(input.documents));
      assert.match(body.messages[0].content, /а не только изменённые updates/);
      assert.match(body.messages[0].content, /по его назначению/);
      if (checkerCalls === 1) return response({ approved: true, reviewedPaths: reviewed, issues: [] });
      if (checkerCalls === 2) {
        assert.deepEqual(input.requiredPaths, actualPaths.slice(0, 7).filter(path => !reviewed.includes(path)));
        assert.deepEqual(input.updates, []);
        assert.equal(input.patch, '');
        assert.deepEqual(input.documentCatalog.map(document => document.path), input.requiredPaths);
      }
    }
    return simulate(url, init);
  } });
  assert.equal(writerCalls, result.plan.batches.length);
  assert.equal(checkerCalls, result.plan.batches.length + 1);
  assert.equal(requests, result.plan.expectedCalls + 1);
  assert.equal(result.usage.apiCalls, requests);
  assert.deepEqual(new Set(result.verification.reviewedPaths), new Set(actualPaths));
  assert.equal(result.trace.filter(event => event.status === 'coverage').length, 1);
  for (const path of reviewed) assert.match(await readFile(resolve(root, path), 'utf8'), /Client.city stores/);
});

test('an incomplete supplemental checker stops after one additional call without writing any docs', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  let writerCalls = 0, checkerCalls = 0;
  const simulate = model(tally());
  await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
    if (body.messages[0].content.startsWith('Ты docs_writer')) { writerCalls++; return simulate(url, init); }
    checkerCalls++;
    return response({ approved: true, reviewedPaths: input.requiredPaths.slice(0, 1), issues: [] });
  } }), /неполный ответ проверяющего/);
  assert.equal(writerCalls, 1);
  assert.equal(checkerCalls, 2);
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('unknown duplicate and empty checker paths are rejected without a coverage retry', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  for (const reviewedPaths of [['docs/nonexistent.md'], ['README.md', 'README.md'], []]) {
    let requests = 0;
    const simulate = model(tally());
    await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      return body.messages[0].content.startsWith('Ты docs_writer') ? simulate(url, init)
        : response({ approved: true, reviewedPaths, issues: [] });
    } }));
    assert.equal(requests, 2);
  }
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});

test('supplemental checker respects shared budget and does not retry HTTP errors', async t => {
  const { config, root, originals, mcp, base } = await fixture(t, false, actualPaths);
  for (const bounded of [true, false]) {
    let requests = 0;
    const simulate = model(tally());
    await assert.rejects(syncDocs({ ...config, ...(bounded ? { maxCalls: 2 } : {}) }, mcp, base, { apply: true, fetchImpl: async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      if (body.messages[0].content.startsWith('Ты docs_writer')) return simulate(url, init);
      if (requests === 2) return response({ approved: true, reviewedPaths: ['README.md', 'docs/architecture.md'], issues: [] });
      return new Response('billing', { status: 402 });
    } }), error => bounded ? error.code === 'LLM_BUDGET_EXCEEDED' && error.usage.apiCalls === 2 : error.status === 402 && error.usage.apiCalls === 3);
    assert.equal(requests, bounded ? 2 : 3);
  }
  for (const [path, content] of Object.entries(originals)) assert.equal(await readFile(resolve(root, path), 'utf8'), content);
});
