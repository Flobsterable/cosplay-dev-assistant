import { buildIndex, search } from './rag.js';
import { executionConfig } from './config.js';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const runs = new WeakMap();
function newUsage() {
  return { apiCalls: 0, cacheHits: 0, inputCharacters: 0, promptTokens: 0, completionTokens: 0,
    cachedPromptTokens: 0, cacheMissTokens: 0, totalTokens: 0 };
}
export function createRunConfig(config) {
  const copy = { ...config, ...executionConfig(config) };
  runs.set(copy, newUsage());
  return copy;
}
export function usageSummary(config) {
  return { ...(runs.get(config) || newUsage()) };
}

function signed(config, value) {
  return createHmac('sha256', config.apiKey).update(value).digest('hex');
}
async function readCached(config, key) {
  if (!config.cacheDir) return null;
  try {
    const cached = JSON.parse(await readFile(resolve(config.cacheDir, `${key}.json`), 'utf8'));
    if (typeof cached.content !== 'string' || !cached.content.trim() || typeof cached.signature !== 'string') return null;
    const expected = Buffer.from(signed(config, `${key}\n${cached.content}`), 'hex');
    const actual = Buffer.from(cached.signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? cached.content : null;
  } catch { return null; }
}
async function saveCached(config, key, content) {
  if (!config.cacheDir) return;
  const temporary = resolve(config.cacheDir, `${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(temporary, JSON.stringify({ content, signature: signed(config, `${key}\n${content}`) }), { mode: 0o600 });
    await rename(temporary, resolve(config.cacheDir, `${key}.json`));
  } catch { /* Cache availability must not change an already verified API response. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function prepareQuestion(projectRoot, mcp, question) {
  if (!question.trim() || question.length > 4000) throw new Error('Вопрос должен содержать от 1 до 4000 символов.');
  // Re-read the small corpus so edits and branch switches cannot leave stale answers.
  const index = await buildIndex(projectRoot);
  const context = await mcp.context();
  const sources = search(index, question);
  return { question, context, sources, documents: index.documents };
}

export async function complete(config, messages, fetchImpl = fetch, json = false, maxTokens = 1400) {
  const limits = executionConfig(config);
  if (!config.apiKey || !config.model) {
    throw new Error('Заполните LLM_API_KEY и LLM_MODEL в tools/dev-assistant/.env. Для проверки без ключа используйте --retrieve.');
  }
  const url = new URL(config.baseUrl.replace(/\/$/, '') + '/chat/completions');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('LLM_BASE_URL должен быть HTTP(S) URL.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Для внешнего API используйте HTTPS.');
  }
  const inputCharacters = JSON.stringify(messages).length;
  if (!runs.has(config)) runs.set(config, newUsage());
  const usage = runs.get(config);
  const body = JSON.stringify({
    model: config.model,
    ...(url.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0.2,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    messages
  });
  const cacheKey = signed(config, `${url.href}\n${body}`);
  const cached = await readCached(config, cacheKey);
  if (cached !== null) { usage.cacheHits++; return cached; }
  if (usage.apiCalls >= limits.maxCalls || usage.inputCharacters + inputCharacters > limits.maxInputCharacters) {
    const error = new Error('Достигнут бюджет запуска LLM: число запросов или суммарный входной контекст. Ничего не обрезано; измените LLM_MAX_CALLS/LLM_MAX_INPUT_CHARACTERS явно.');
    error.code = 'LLM_BUDGET_EXCEEDED';
    error.retryable = false;
    throw error;
  }
  // Reserve before awaiting so concurrent subagents share the same spend guard.
  usage.apiCalls++;
  usage.inputCharacters += inputCharacters;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(60000),
    body
  });
  if (!response.ok) {
    const error = new Error(`API модели вернул HTTP ${response.status}. Проверьте ключ, модель, баланс и LLM_BASE_URL.`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  const data = await response.json();
  const measured = data.usage || {};
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  usage.promptTokens += count(measured.prompt_tokens);
  usage.completionTokens += count(measured.completion_tokens);
  usage.cachedPromptTokens += count(measured.prompt_cache_hit_tokens ?? measured.prompt_tokens_details?.cached_tokens);
  usage.cacheMissTokens += count(measured.prompt_cache_miss_tokens);
  usage.totalTokens += count(measured.total_tokens ?? (count(measured.prompt_tokens) + count(measured.completion_tokens)));
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Ответ модели обрезан лимитом токенов. Уменьшите задачу или диапазон diff.');
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('API модели вернул пустой ответ.');
  // A broken JSON response must not become a persistent failure on every rerun.
  let cacheable = true;
  if (json) {
    try { const value = JSON.parse(answer); cacheable = value !== null && typeof value === 'object' && !Array.isArray(value); }
    catch { cacheable = false; }
  }
  if (cacheable) await saveCached(config, cacheKey, answer);
  return answer;
}

export function formatEvidence(evidence) {
  return [
    `Ветка: ${evidence.context.branch}`,
    `MCP tools/call: ${evidence.context.tools.join(', ')}`,
    `RAG: ${evidence.documents.length} документов, ${evidence.sources.length} разделов (${evidence.retrieval ? 'чтение и поиск выбирает агент' : 'BM25'})`,
    ...(evidence.retrieval ? [`Поиск агентом: ${evidence.retrieval.status === 'checked' ? 'проверен по каталогу' : 'не завершён: достигнут лимит'}; прочитано документов: ${evidence.retrieval.readDocuments}`] : []),
    ...evidence.sources.map((s, i) => `[${i + 1}] ${s.path}:${s.startLine}-${s.endLine}`)
  ].join('\n');
}
