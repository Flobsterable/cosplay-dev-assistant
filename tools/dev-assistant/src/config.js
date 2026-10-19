import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} должен быть положительным целым числом.`);
  return number;
}
export function smallModelConfig(config) {
  if (!config) return undefined;
  if (config.provider !== 'gemini') throw new Error('LLM_SMALL_TASK_PROVIDER должен быть gemini.');
  return { provider: 'gemini', apiKey: config.apiKey || '', model: config.model || 'gemini-3.5-flash-lite',
    baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
    maxInputCharacters: positiveInteger(config.maxInputCharacters, 24000, 'LLM_SMALL_TASK_MAX_INPUT_CHARACTERS'),
    maxOutputTokens: positiveInteger(config.maxOutputTokens, 6000, 'LLM_SMALL_TASK_MAX_OUTPUT_TOKENS') };
}
export function executionConfig(config = {}) {
  const executionMode = config.executionMode ?? 'economy';
  if (!['economy', 'thorough'].includes(executionMode)) throw new Error('LLM_EXECUTION_MODE должен быть economy или thorough.');
  return { executionMode,
    maxCalls: positiveInteger(config.maxCalls, 24, 'LLM_MAX_CALLS'),
    maxInputCharacters: positiveInteger(config.maxInputCharacters, 1000000, 'LLM_MAX_INPUT_CHARACTERS') };
}
export function loadConfig() {
  const envFile = resolve(toolRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PROJECT_ROOT?.trim()) throw new Error('Задайте PROJECT_ROOT: абсолютный путь к отдельному репозиторию приложения.');
  return {
    projectRoot: resolve(process.env.PROJECT_ROOT),
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || '',
    cacheDir: process.env.LLM_CACHE_DIR || '',
    smallModel: smallModelConfig(process.env.LLM_SMALL_TASK_PROVIDER || process.env.GEMINI_API_KEY
      ? { provider: process.env.LLM_SMALL_TASK_PROVIDER || 'gemini', apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL, baseUrl: process.env.GEMINI_BASE_URL,
        maxInputCharacters: process.env.LLM_SMALL_TASK_MAX_INPUT_CHARACTERS,
        maxOutputTokens: process.env.LLM_SMALL_TASK_MAX_OUTPUT_TOKENS } : undefined),
    ...executionConfig({ executionMode: process.env.LLM_EXECUTION_MODE,
      maxCalls: process.env.LLM_MAX_CALLS, maxInputCharacters: process.env.LLM_MAX_INPUT_CHARACTERS })
  };
}
