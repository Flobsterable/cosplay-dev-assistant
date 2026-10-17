import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig() {
  const envFile = resolve(toolRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PROJECT_ROOT?.trim()) throw new Error('Задайте PROJECT_ROOT: абсолютный путь к отдельному репозиторию приложения.');
  return {
    projectRoot: resolve(process.env.PROJECT_ROOT),
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || ''
  };
}
