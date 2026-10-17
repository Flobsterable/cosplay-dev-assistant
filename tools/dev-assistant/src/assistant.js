import { buildIndex, search } from './rag.js';

export async function prepareQuestion(projectRoot, mcp, question) {
  if (!question.trim() || question.length > 4000) throw new Error('Вопрос должен содержать от 1 до 4000 символов.');
  // Re-read the small corpus so edits and branch switches cannot leave stale answers.
  const index = await buildIndex(projectRoot);
  const context = await mcp.context();
  const sources = search(index, question);
  return { question, context, sources, documents: index.documents };
}

export async function complete(config, messages, fetchImpl = fetch, json = false, maxTokens = 1400) {
  if (!config.apiKey || !config.model) {
    throw new Error('Заполните LLM_API_KEY и LLM_MODEL в tools/dev-assistant/.env. Для проверки без ключа используйте --retrieve.');
  }
  const url = new URL(config.baseUrl.replace(/\/$/, '') + '/chat/completions');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('LLM_BASE_URL должен быть HTTP(S) URL.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Для внешнего API используйте HTTPS.');
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: config.model,
      ...(url.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
      temperature: 0.2,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages
    })
  });
  if (!response.ok) throw new Error(`API модели вернул HTTP ${response.status}. Проверьте ключ, модель, баланс и LLM_BASE_URL.`);
  const data = await response.json();
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Ответ модели обрезан лимитом токенов. Уменьшите задачу или диапазон diff.');
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('API модели вернул пустой ответ.');
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
