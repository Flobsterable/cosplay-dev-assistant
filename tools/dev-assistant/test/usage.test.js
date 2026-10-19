import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, createRunConfig, usageSummary } from '../src/assistant.js';
import { selectEvidence, groundedJSON } from '../src/efficient-context.js';
import { executionConfig } from '../src/config.js';
import { tokenize } from '../src/rag.js';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = () => ({ apiKey: 'never-log-secret', model: 'mock', baseUrl: 'https://example.invalid' });
const response = (value, usage) => new Response(JSON.stringify({ usage, choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));
const index = { chunks: [
  { path: 'head:api.kt', heading: 'API', text: 'Festival city field', startLine: 1, endLine: 2 },
  { path: 'head:use.kt', heading: 'Display', text: 'show city', startLine: 1, endLine: 2 },
  { path: 'head:use.kt', heading: 'Constraint', text: 'empty values are hidden', startLine: 3, endLine: 4 },
  { path: 'docs/other.md', heading: 'Unrelated', text: 'zebras', startLine: 1, endLine: 1 }
].map(chunk => ({ ...chunk, tokens: tokenize(chunk.text) })) };

test('run budget counts failed requests and reserves concurrent calls without logging credentials', async () => {
  const run = createRunConfig({ ...config(), maxCalls: 1 });
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('never-log-secret', { status: 402 }); };
  const results = await Promise.allSettled([complete(run, [], fetchImpl), complete(run, [], fetchImpl)]);
  assert.equal(requests, 1);
  assert.equal(results[0].reason.status, 402);
  assert.equal(results[0].reason.retryable, false);
  assert.equal(results[1].reason.code, 'LLM_BUDGET_EXCEEDED');
  assert.ok(results.every(result => !result.reason.message.includes('never-log-secret')));
  assert.equal(usageSummary(run).apiCalls, 1);
  assert.equal(usageSummary(createRunConfig(run)).apiCalls, 0);
});

test('cumulative input budget refuses an entire next request and validates direct configs', async () => {
  const messages = [{ role: 'user', content: 'a'.repeat(100) }];
  const run = createRunConfig({ ...config(), maxInputCharacters: JSON.stringify(messages).length });
  await complete(run, messages, async () => response('ok'));
  await assert.rejects(complete(run, messages, () => { throw new Error('must not call'); }), error => error.code === 'LLM_BUDGET_EXCEEDED');
  assert.equal(usageSummary(run).inputCharacters, JSON.stringify(messages).length);
  assert.throws(() => createRunConfig({ ...config(), maxCalls: 0 }));
  assert.throws(() => createRunConfig({ ...config(), executionMode: 'unlimited' }));
  await assert.rejects(complete({ ...config(), maxInputCharacters: -1 }, [], () => { throw new Error('must not call'); }));
  assert.equal(executionConfig().executionMode, 'economy');
});

test('provider usage counters include cache tokens and count truncated responses', async () => {
  const run = createRunConfig(config());
  await complete(run, [], async () => response('ok', { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 90 }, prompt_cache_miss_tokens: 30 }));
  const summary = usageSummary(run);
  assert.deepEqual(summary, { apiCalls: 1, cacheHits: 0, inputCharacters: 2, promptTokens: 120, completionTokens: 30,
    totalTokens: 150, cachedPromptTokens: 90, cacheMissTokens: 30 });
  summary.apiCalls = 500;
  assert.equal(usageSummary(run).apiCalls, 1);
  await assert.rejects(complete(run, [], async () => new Response(JSON.stringify({
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 8 },
    choices: [{ finish_reason: 'length', message: { content: 'partial' } }]
  }))), /обрезан/);
  assert.equal(usageSummary(run).apiCalls, 2);
  assert.equal(usageSummary(run).promptTokens, 130);
  assert.equal(usageSummary(run).cachedPromptTokens, 98);
});

test('authenticated exact-request cache survives runs, rejects tampering and never stores prompts or keys', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'assistant-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const messages = [{ role: 'user', content: 'private-source-sentinel' }];
  let requests = 0;
  const mock = async () => { requests++; return response('safe result'); };
  await complete(createRunConfig({ ...config(), cacheDir }), messages, mock);
  const cachedRun = createRunConfig({ ...config(), cacheDir });
  assert.equal(await complete(cachedRun, messages, mock), 'safe result');
  assert.equal(requests, 1);
  assert.equal(usageSummary(cachedRun).cacheHits, 1);
  assert.equal(usageSummary(cachedRun).apiCalls, 0);
  const file = join(cacheDir, (await readdir(cacheDir))[0]);
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes('private-source-sentinel'));
  assert.ok(!saved.includes('never-log-secret'));
  await writeFile(file, saved.replace('safe result', 'approved malicious edit'));
  await complete(createRunConfig({ ...config(), cacheDir }), messages, mock);
  assert.equal(requests, 2);
  await complete(createRunConfig({ ...config(), cacheDir, model: 'changed' }), messages, mock);
  assert.equal(requests, 3);
  await complete(createRunConfig({ ...config(), cacheDir }), [{ role: 'user', content: 'changed source' }], mock);
  assert.equal(requests, 4);
});

test('HTTP errors identify only rate/server failures as retryable', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500, 503]) {
    await assert.rejects(complete(config(), [], async () => new Response('never-log-secret', { status })),
      error => error.status === status && error.retryable === (status === 429 || status >= 500) && !error.message.includes('never-log-secret'));
  }
});

test('local evidence selection retains mandatory paths, original section IDs and full text', () => {
  const sources = selectEvidence(index, 'Festival', { initialSectionIds: [4], paths: ['head:use.kt'] });
  assert.deepEqual(sources.map(s => s.sectionId), [1, 2, 3, 4]);
  assert.ok(sources.every(s => !Object.hasOwn(s, 'tokens')));
  assert.equal(sources[2].text, index.chunks[2].text);
});

test('grounded calls can explicitly request whole source files locally and then produce output', async () => {
  const run = createRunConfig(config());
  const calls = [];
  const result = await groundedJSON(run, { system: 'Answer task', payload: { question: 'usage?' }, index,
    sources: selectEvidence(index, 'Festival'), fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const payload = JSON.parse(body.messages[1].content);
      calls.push(payload);
      assert.match(body.messages[0].content, /недоверенные/);
      assert.ok(!init.body.includes('never-log-secret'));
      return response(calls.length === 1 ? { readPaths: ['head:use.kt'], reason: 'Check usage' } : { answer: 'confirmed' });
    } });
  assert.deepEqual(result.value, { answer: 'confirmed' });
  assert.deepEqual(result.sources.map(s => s.sectionId), [1, 2, 3]);
  assert.deepEqual(calls[0].sourceCatalog.find(s => s.path === 'head:use.kt').headings, ['Display', 'Constraint']);
  assert.equal(calls[1].sources.length, 3);
  assert.equal(usageSummary(run).apiCalls, 2);
});

test('grounding rejects unknown paths, repeat reads, malformed results and endless expansion', async () => {
  for (const value of [{ readPaths: ['.env'] }, { readPaths: ['head:api.kt'] }, { readPaths: [] }, 'invalid']) {
    let calls = 0;
    await assert.rejects(groundedJSON(config(), { system: 'task', payload: {}, index,
      sources: selectEvidence(index, 'Festival'), fetchImpl: async () => { calls++; return response(value); } }));
    assert.equal(calls, 1);
  }
  const larger = { chunks: Array.from({ length: 5 }, (_, i) => ({ path: `path${i}`, text: 'data', tokens: [] })) };
  let calls = 0;
  await assert.rejects(groundedJSON(config(), { system: 'task', payload: {}, index: larger,
    fetchImpl: async () => response({ readPaths: [`path${calls++}`] }) }), /лимит/);
  assert.equal(calls, 4);
});
