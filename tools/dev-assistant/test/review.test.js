import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildReviewContext, changedLines, reviewable } from '../src/review-context.js';
import { reviewPullRequest, validateReview, renderReview } from '../src/pr-review.js';
import { publishReview } from '../src/review-github.js';
const exec = promisify(execFile);
const reply = data => new Response(JSON.stringify(data), { status: 200 });
const modelReply = data => reply({ choices: [{ message: { content: JSON.stringify(data) } }] });

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'pr-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, value) { await mkdir(resolve(root, path, '..'), { recursive: true }); await writeFile(resolve(root, path), value); }
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Review Test'); await git('config', 'user.email', 'test@example.invalid');
  await put('README.md', '# Project\nKotlin Multiplatform client.\n');
  await put('docs/contracts.md', '# Contract\nDo not mutate input or block UI.\n');
  await put('LoadingBlock.kt', 'fun divide(n: Int) = 10 / n\n');
  await put('Caller.kt', 'fun run() = divide(2)\n');
  await put('.env', 'SENTINEL_PRIVATE_TOKEN=value\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');
  await put('LoadingBlock.kt', 'fun divide(n: Int) = 10 / (n - 2)\n');
  await put('Caller.kt', 'fun run() = divide(2)\n// caller is unchanged semantically\n');
  await put('.env', 'SENTINEL_NEW_PRIVATE_TOKEN=value\n');
  await git('add', '.'); await git('commit', '-m', 'introduce divide by zero');
  const head = await git('rev-parse', 'HEAD');
  // Working tree is explicitly not the PR source.
  await put('LoadingBlock.kt', 'WORKTREE_SENTINEL_SHOULD_NOT_BE_READ\n');
  return { root, git, put, base, head, config: { projectRoot: root, apiKey: 'fake', model: 'fake', baseUrl: 'https://example.invalid' } };
}

test('review context uses merge-base and Git blobs, including both sides, never working files or env', async t => {
  const { root, base, head } = await fixture(t);
  const context = await buildReviewContext(root, base, head);
  assert.equal(context.base, base);
  assert.equal(context.head, head);
  assert.ok(context.index.documents.includes('head:LoadingBlock.kt'));
  assert.ok(context.index.documents.includes('base:LoadingBlock.kt'));
  assert.match(context.diff, /n - 2/);
  assert.ok(context.changedLines.get('LoadingBlock.kt').RIGHT.has(1));
  assert.ok(!JSON.stringify(context.index).includes('SENTINEL_PRIVATE'));
  assert.ok(!JSON.stringify(context).includes('WORKTREE_SENTINEL'));
  assert.ok(context.omitted.some(f => f.path === '.env'));
  assert.ok(reviewable('core/platform/LoadingBlock.kt'));
  assert.ok(!reviewable('config/local.properties'));
  assert.ok(!reviewable('.github/secrets.md'));
  assert.ok(reviewable('.github/workflows/release.yml'));
  await assert.rejects(buildReviewContext(root, '--output=evil', head), /Git ref/);
});

test('changed-line parser handles additions, deletions and header-like content within a hunk', () => {
  const diff = 'diff --git a/a.kt b/a.kt\n--- a/a.kt\n+++ b/a.kt\n@@ -2,2 +2,2 @@\n--- removed\n+++ added\n keep\n';
  const lines = changedLines(diff).get('a.kt');
  assert.deepEqual([...lines.LEFT], [2]); assert.deepEqual([...lines.RIGHT], [2]);
});

test('review rejects invented paths, unchanged lines and unsupported source IDs', async t => {
  const { root, base, head } = await fixture(t), context = await buildReviewContext(root, base, head);
  const finding = { category: 'bug', priority: 'P1', path: 'LoadingBlock.kt', side: 'RIGHT', line: 1, title: 'Zero divisor', body: 'n=2 fails; guard the divisor.', sources: [1] };
  for (const change of [{ path: '../secret' }, { line: 999 }, { sources: [99] }, { category: 'style' }, { side: 'OTHER' }]) {
    assert.throws(() => validateReview({ summary: 'x', findings: [{ ...finding, ...change }] }, context, [{}]));
  }
  assert.equal(validateReview({ summary: 'x', findings: [finding] }, context, [{}]).findings.length, 1);
});

test('review selects code/docs through the agent, verifies the draft and formats three categories', async t => {
  const { config, base, head } = await fixture(t);
  let reviewers = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body), payload = JSON.parse(body.messages[1].content);
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(body.messages[0].content)) return modelReply(payload.readSections.length
      ? { action: 'done' } : { action: 'read', paths: ['head:LoadingBlock.kt', 'head:Caller.kt', 'head:docs/contracts.md'] });
    reviewers++;
    assert.ok(payload.documentation.some(s => s.path === 'head:Caller.kt'));
    assert.ok(payload.documentation.some(s => s.path === 'head:docs/contracts.md'));
    assert.match(body.messages[0].content, /CancellationException/);
    if (reviewers === 2) assert.ok(payload.draft);
    const id = payload.documentation.find(d => d.path === 'head:LoadingBlock.kt').id;
    return modelReply({ summary: 'One regression', findings: [{ category: 'bug', priority: 'P1', path: 'LoadingBlock.kt', side: 'RIGHT', line: 1, title: 'Zero divisor', body: 'divide(2) divides by zero. @someone <tag> Validate divisor.', sources: [id] }] });
  };
  const result = await reviewPullRequest(config, { base, head, fetchImpl });
  assert.equal(reviewers, 2);
  const markdown = renderReview(result, 'owner/project');
  assert.match(markdown, /Потенциальные баги/); assert.match(markdown, /Архитектурные проблемы/); assert.match(markdown, /Рекомендации/);
  assert.match(markdown, new RegExp(head));
  assert.ok(!markdown.includes('@someone')); assert.ok(!markdown.includes('<tag>'));
});

test('publication updates only the bot marker and skips a head that changed before write', async () => {
  const head = 'a'.repeat(40), requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/pulls/')) return reply({ head: { sha: head }, state: 'open' });
    if (init.method === 'PATCH') return reply({ html_url: 'https://github.com/o/r/pull/1#issuecomment-7' });
    return reply([{ id: 6, user: { login: 'human' }, body: '<!-- cosplay-ai-review --> spoof' }, { id: 7, user: { login: 'github-actions[bot]' }, body: '<!-- cosplay-ai-review --> old' }]);
  };
  const result = await publishReview({ repository: 'o/r', number: 1, head, body: '<!-- cosplay-ai-review --> new', token: 'fake', fetchImpl });
  assert.equal(result.published, true);
  assert.ok(requests.at(-1).url.endsWith('/issues/comments/7'));
  let calls = 0;
  const stale = await publishReview({ repository: 'o/r', number: 1, head, body: '<!-- cosplay-ai-review --> new', token: 'fake', fetchImpl: async (_url, init) => {
    assert.equal(init.method, 'GET'); calls++;
    if (calls === 2) return reply([]);
    return reply({ state: 'open', head: { sha: calls === 3 ? 'b'.repeat(40) : head } });
  } });
  assert.equal(stale.published, false);
});
