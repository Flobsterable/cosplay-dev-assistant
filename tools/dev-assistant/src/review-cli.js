import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { reviewPullRequest, renderReview } from './pr-review.js';
import { publishReview, publishInlineReview } from './review-github.js';

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
  const body = renderReview(result, flags.repo);
  const output = resolve(flags.output || 'review-output');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'review.md'), body + '\n');
  // Keep provenance/coverage, not raw source, prompts, or credentials, in artifacts.
  await writeFile(resolve(output, 'review.json'), JSON.stringify({ review: result.review, layers: result.layers,
    documentationAudit: result.documentationAudit ? { ...result.documentationAudit,
      sources: result.documentationAudit.sources.map(({ text, tokens, ...s }) => s) } : null,
    base: result.context.base, head: result.context.head,
    files: result.context.files, omitted: result.context.omitted, retrieval: result.retrieval,
    sources: result.sources.map(({ text, tokens, ...s }) => s) }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, body + '\n');
  if (flags.publish) {
    const published = await publishReview({ repository: flags.repo, number: Number(flags.pr), head: result.context.head, body, token: process.env.GITHUB_TOKEN });
    console.log(published.published ? `Ревью опубликовано: ${published.url}` : published.reason);
    if (published.published) {
      const inline = await publishInlineReview({ repository: flags.repo, number: Number(flags.pr), head: result.context.head,
        findings: result.review.findings, summaryUrl: published.url, token: process.env.GITHUB_TOKEN });
      console.log(inline.published ? `Inline-замечания опубликованы: ${inline.comments} новых` : inline.reason);
    }
  } else console.log(body);
}
main().catch(error => { console.error(`Ошибка AI-ревью: ${error.message}`); process.exitCode = 1; });
