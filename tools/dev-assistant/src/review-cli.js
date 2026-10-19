import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { reviewPullRequest } from './pr-review.js';
import { publishInlineReview } from './review-github.js';

async function main() {
  const flags = {};
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === '--publish') { flags.publish = true; continue; }
    if (!['--base', '--head', '--repo', '--pr', '--output'].includes(name) || !process.argv[i + 1] || Object.hasOwn(flags, name.slice(2))) throw new Error('Формат: --base REF --head REF --repo owner/repo [--pr NUMBER --publish] [--output DIR]');
    flags[name.slice(2)] = process.argv[++i];
  }
  if (!flags.base || !flags.head || !flags.repo) throw new Error('Укажите --base, --head и --repo.');
  const config = loadConfig();
  const result = await reviewPullRequest(config, { base: flags.base, head: flags.head,
    onEvent: e => console.log(`[${e.agent}] ${e.status}: ${e.detail}`) });
  const output = resolve(flags.output || 'review-output');
  await mkdir(output, { recursive: true });
  // Keep provenance/coverage, not raw source, prompts, or credentials, in artifacts.
  await writeFile(resolve(output, 'review.json'), JSON.stringify({ review: result.review, layers: result.layers,
    documentationAudit: result.documentationAudit ? { ...result.documentationAudit,
      sources: result.documentationAudit.sources.map(({ text, tokens, ...s }) => s) } : null,
    usage: result.usage, base: result.context.base, head: result.context.head,
    files: result.context.files, omitted: result.context.omitted, retrieval: result.retrieval,
    sources: result.sources.map(({ text, tokens, ...s }) => s) }, null, 2) + '\n');
  if (result.usage) console.log('[llm_usage] ' + JSON.stringify(result.usage));
  if (flags.publish) {
    const inline = await publishInlineReview({ repository: flags.repo, number: Number(flags.pr), head: result.context.head,
      findings: result.review.findings, token: process.env.GITHUB_TOKEN });
    console.log(inline.published ? `Inline-замечания: ${inline.comments} новых` : inline.reason);
  } else console.log(JSON.stringify(result.review.findings, null, 2));
  if (result.documentationAudit?.status === 'limit') {
    console.error('Аудит документации не завершён. Причина и непрочитанные разделы указаны в review.json; проверка не считается успешной.');
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(`Ошибка AI-ревью: ${error.message}`); process.exitCode = 1; });
