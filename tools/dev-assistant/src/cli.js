import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { buildIndex, saveIndex } from './rag.js';
import { connectProject } from './mcp-client.js';
import { prepareQuestion, formatEvidence } from './assistant.js';
import { orchestrate } from './orchestrator.js';
import { syncDocs } from './sync-docs.js';

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  if (args[0] === '--index') {
    const index = await buildIndex(config.projectRoot);
    const saved = await saveIndex(config.projectRoot, index);
    console.log(`RAG BM25: ${index.documents.length} документов, ${index.chunks.length} фрагментов.\n${index.documents.join('\n')}\nИндекс: ${saved}`);
    return;
  }
  const mcp = await connectProject(config.projectRoot);
  try {
    if (args[0] === '--doctor') {
      const index = await buildIndex(config.projectRoot);
      const tools = (await mcp.client.listTools()).tools.map(tool => tool.name);
      console.log(JSON.stringify({ node: process.version, project: config.projectRoot, documents: index.documents, chunks: index.chunks.length, tools, mcp: await mcp.context(), modelConfigured: Boolean((config.apiKey && config.model) || (config.smallModel?.apiKey && config.smallModel?.model)),
        routing: { primary: { model: config.model, configured: Boolean(config.apiKey && config.model) },
          small: config.smallModel ? { provider: config.smallModel.provider, model: config.smallModel.model, configured: Boolean(config.smallModel.apiKey),
            maxInputCharacters: config.smallModel.maxInputCharacters, maxOutputTokens: config.smallModel.maxOutputTokens } : null } }, null, 2));
      return;
    }
    async function ask(input, retrieve = false) {
      if (/^\/sync(?:\s|$)/.test(input)) {
        const parts = input.split(/\s+/).slice(1);
        let head = 'HEAD';
        const headIndex = parts.indexOf('--head');
        if (headIndex !== -1) {
          if (!parts[headIndex + 1] || parts[headIndex + 1].startsWith('-')) throw new Error('После --head укажите Git ref или SHA.');
          head = parts[headIndex + 1];
          parts.splice(headIndex, 2);
        }
        const apply = parts.includes('--apply');
        const planOnly = parts.includes('--plan');
        if (apply && planOnly) throw new Error('--plan нельзя сочетать с --apply.');
        const refs = parts.filter(p => !['--apply', '--plan'].includes(p));
        if (refs.length > 1) throw new Error('Формат: /sync BASE [--head SHA] [--apply]');
        const result = await syncDocs(config, mcp, refs[0] || 'HEAD~1', { apply, planOnly, head,
          onEvent: event => console.log(`[${event.agent}] ${event.status}: ${event.detail}`) });
        console.log('\n' + result.answer);
        if (result.usage) console.log('[llm_usage] ' + JSON.stringify(result.usage));
        return;
      }
      if (!/^\/help(?:\s|$)/.test(input)) throw new Error('Используйте /help ваш вопрос. Выход: /exit');
      const question = input.replace(/^\/help\s*/, '').trim() || 'Как устроена структура и архитектура проекта?';
      if (retrieve) {
        const evidence = await prepareQuestion(config.projectRoot, mcp, question);
        console.log('\n' + formatEvidence(evidence));
        console.log('\nДиагностика поиска, без вызова модели:\n' + evidence.sources.map((s, i) => `[${i + 1}]\n${s.text}`).join('\n\n'));
      } else {
        const result = await orchestrate(config, mcp, question, {
          onEvent: event => console.log(`[${event.agent}] ${event.status}: ${event.detail}`)
        });
        console.log('\n' + result.answer + '\n\n' + formatEvidence(result.evidence));
      }
    }
    if (args.length) {
      const retrieve = args[0] === '--retrieve';
      await ask((retrieve ? args.slice(1) : args).join(' '), retrieve);
      return;
    }
    console.log('KMP Assistant · оркестратор v1.2 (агент сам выбирает и читает README/docs)\n/help ваш вопрос — документация + Git-ветка через MCP\n/sync HEAD~1 — обновление документации по diff; --apply сохраняет изменения\n/exit — выход');
    const rl = createInterface({ input: stdin, output: stdout });
    const stop = () => rl.close();
    rl.on('SIGINT', stop);
    try {
      for (;;) {
        let input;
        try { input = (await rl.question('\n> ')).trim(); }
        catch (error) { if (error.code === 'ERR_USE_AFTER_CLOSE' || error.code === 'ABORT_ERR') break; throw error; }
        if (input === '/exit') break;
        if (!input) continue;
        try { await ask(input); }
        catch (error) { console.error(`Ошибка: ${error.message}`); }
      }
    } finally { rl.close(); }
  } finally { await mcp.close(); }
}
main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
