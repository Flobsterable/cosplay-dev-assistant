import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete, createRunConfig, usageSummary } from '../src/assistant.js';
import { smallModelConfig } from '../src/config.js';

const base = () => ({ apiKey: 'primary-secret', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
  smallModel: { provider: 'gemini', apiKey: 'gemini-secret' } });
const messages = content => [{ role: 'user', content }];
const reply = value => new Response(JSON.stringify({ choices: [{ message: { content: value } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));

test('small requests use Gemini with only its credential and minimal Flash Lite thinking', async () => {
  const run = createRunConfig(base());
  await complete(run, messages('short'), async (url, init) => {
    assert.equal(url.href, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer gemini-secret');
    assert.ok(!JSON.stringify(init).includes('primary-secret'));
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.equal(body.reasoning_effort, 'minimal');
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return reply('{"answer":"ok"}');
  }, true, 4000);
  assert.equal(usageSummary(run).perModel['gemini:gemini-3.5-flash-lite'].apiCalls, 1);
});

test('input and requested output thresholds route to primary without clipping', async () => {
  const run = createRunConfig(base());
  const seen = [];
  const fake = async (url, init) => {
    seen.push(JSON.parse(init.body));
    assert.equal(url.hostname, 'api.deepseek.com');
    assert.equal(init.headers.Authorization, 'Bearer primary-secret');
    assert.ok(!JSON.stringify(init).includes('gemini-secret'));
    assert.deepEqual(seen.at(-1).thinking, { type: 'disabled' });
    assert.equal(seen.at(-1).reasoning_effort, undefined);
    return reply('ok');
  };
  const large = 'x'.repeat(24001);
  await complete(run, messages(large), fake);
  await complete(run, messages('short'), fake, false, 6001);
  assert.equal(seen[0].messages[0].content, large);
  assert.equal(seen[1].max_tokens, 6001);
  assert.equal(usageSummary(run).perModel['primary:deepseek-flash'].apiCalls, 2);
});

test('disabled routing preserves existing configs; missing Gemini key blocks primary too', async () => {
  const config = base();
  delete config.smallModel;
  await complete(config, messages('small'), async url => { assert.equal(url.hostname, 'api.deepseek.com'); return reply('ok'); });
  for (const text of ['small', 'x'.repeat(25000)]) {
    let calls = 0;
    await assert.rejects(complete({ ...base(), smallModel: { provider: 'gemini' } }, messages(text), async () => { calls++; return reply('bad'); }),
      error => error.message.includes('GEMINI_API_KEY') && error.retryable === false);
    assert.equal(calls, 0);
  }
  assert.throws(() => smallModelConfig({ provider: 'unknown' }));
  assert.throws(() => smallModelConfig({ provider: 'gemini', maxInputCharacters: 0 }));
});

test('Gemini quota and payment errors never fall back or expose either key', async () => {
  for (const status of [402, 429]) {
    let calls = 0;
    await assert.rejects(complete(base(), messages('short'), async url => {
      calls++;
      assert.equal(url.hostname, 'generativelanguage.googleapis.com');
      return new Response('primary-secret gemini-secret', { status });
    }), error => error.status === status && !/primary-secret|gemini-secret/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('shared call and cumulative input budgets cover both providers; per-model snapshots are independent', async () => {
  for (const byCalls of [true, false]) {
    const smallMessages = messages('short'), largeMessages = messages('x'.repeat(25000));
    const run = createRunConfig({ ...base(), ...(byCalls ? { maxCalls: 2 } : {
      maxInputCharacters: JSON.stringify(smallMessages).length + JSON.stringify(largeMessages).length }) });
    let calls = 0;
    const fake = async () => { calls++; return reply('ok'); };
    await complete(run, smallMessages, fake);
    await complete(run, largeMessages, fake);
    await assert.rejects(complete(run, smallMessages, fake), error => error.code === 'LLM_BUDGET_EXCEEDED');
    assert.equal(calls, 2);
    const summary = usageSummary(run);
    assert.equal(summary.apiCalls, 2);
    assert.equal(summary.promptTokens, 20);
    assert.equal(summary.perModel['gemini:gemini-3.5-flash-lite'].apiCalls, 1);
    assert.equal(summary.perModel['primary:deepseek-flash'].apiCalls, 1);
    summary.perModel['primary:deepseek-flash'].apiCalls = 100;
    assert.equal(usageSummary(run).perModel['primary:deepseek-flash'].apiCalls, 1);
  }
});

test('cache uses selected provider credential and endpoint and rejects tampered Gemini responses', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'model-routing-'));
  t.after(() => rm(cacheDir, { force: true, recursive: true }));
  let calls = 0;
  const fake = async () => { calls++; return reply('safe result'); };
  const request = messages('private-source');
  await complete(createRunConfig({ ...base(), cacheDir }), request, fake);
  const cachedRun = createRunConfig({ ...base(), cacheDir });
  await complete(cachedRun, request, fake);
  assert.equal(calls, 1);
  assert.equal(usageSummary(cachedRun).perModel['gemini:gemini-3.5-flash-lite'].cacheHits, 1);
  const file = join(cacheDir, (await readdir(cacheDir))[0]);
  const saved = await readFile(file, 'utf8');
  assert.ok(!/private-source|primary-secret|gemini-secret/.test(saved));
  await writeFile(file, saved.replace('safe result', 'malicious approval'));
  await complete(createRunConfig({ ...base(), cacheDir }), request, fake);
  assert.equal(calls, 2);
  // Force primary for the same messages: no response can cross provider cache keys.
  await complete(createRunConfig({ ...base(), cacheDir, smallModel: { ...base().smallModel, maxInputCharacters: 1 } }), request, fake);
  assert.equal(calls, 3);
  // Different Gemini credential must not reuse the original credential's cache.
  await complete(createRunConfig({ ...base(), cacheDir, smallModel: { ...base().smallModel, apiKey: 'changed-gemini-secret' } }), request, fake);
  assert.equal(calls, 4);
});
