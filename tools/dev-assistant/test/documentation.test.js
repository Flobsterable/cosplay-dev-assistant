import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkDocumentationLinks, validateDocsVerification } from '../src/docs-verifier.js';
import { auditDocumentation, validateDocsAudit } from '../src/docs-audit.js';
import { buildReviewContext } from '../src/review-context.js';
import { syncDocs } from '../src/sync-docs.js';
import { connectProject } from '../src/mcp-client.js';
import { renderReview } from '../src/pr-review.js';
import { collectIndexedContext } from '../src/document-agent.js';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
async function fixture(t, documented = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'docs-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await mkdir(resolve(root, 'docs'));
  const readme = '# Application\n\nRun the Kotlin Multiplatform client.\n';
  await writeFile(resolve(root, 'README.md'), readme);
  await writeFile(resolve(root, 'docs/config.md'), '# Configuration\n\nClient uses the default timeout.\n');
  await writeFile(resolve(root, 'Client.kt'), 'class Client\n');
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Docs Test'); await git('config', 'user.email', 'test@example.invalid');
  await git('add', '.'); await git('commit', '-m', 'initial');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(resolve(root, 'Client.kt'), 'class Client(val timeoutMs: Long = 5000)\n');
  if (documented) await writeFile(resolve(root, 'docs/config.md'), '# Configuration\n\nClient.timeoutMs defaults to 5000 ms.\n');
  await git('add', '.'); await git('commit', '-m', 'configurable timeout');
  const head = await git('rev-parse', 'HEAD');
  const config = { projectRoot: root, apiKey: 'test', model: 'test', baseUrl: 'https://example.invalid' };
  const context = await buildReviewContext(root, base, head);
  return { root, git, config, context, base, head, readme };
}

function retrieval(system, payload) {
  if (!/^Ты агент поиска|^Ты независимый проверяющий/.test(system)) return null;
  return response(payload.readSections.length ? { action: 'done' } : { action: 'read', paths: payload.catalog.map(d => d.path) });
}

test('PR audit flags an undocumented public parameter, verifies it and renders a separate section', async t => {
  const { config, context } = await fixture(t);
  let verified = false;
  const audit = await auditDocumentation(config, context, { fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    const retrieved = retrieval(system, payload); if (retrieved) return retrieved;
    const code = payload.sources.find(s => s.path === 'head:Client.kt');
    const doc = payload.sources.find(s => s.path === 'head:docs/config.md');
    assert.match(code.text, /timeoutMs/); assert.match(doc.text, /default timeout/);
    if (payload.draft) verified = true;
    return response({ summary: 'Новый параметр не описан.', findings: [{ path: 'Client.kt', side: 'RIGHT', line: 1,
      document: 'docs/config.md', title: 'Опишите timeoutMs', body: 'Добавлен настраиваемый timeoutMs=5000; обновите руководство.', sources: [code.id, doc.id] }] });
  } });
  assert.equal(verified, true); assert.equal(audit.status, 'checked'); assert.equal(audit.findings.length, 1);
  const report = renderReview({ context, sources: [], retrieval: { status: 'checked' }, review: { summary: 'Code review', findings: [] }, documentationAudit: audit }, 'o/r');
  assert.match(report, /Актуальность документации/); assert.match(report, /timeoutMs/); assert.match(report, /Источники аудита: \[D/);
});

test('PR audit sees documentation updated in the same PR even when retrieval did not select it', async t => {
  const { config, context } = await fixture(t, true);
  const audit = await auditDocumentation(config, context, { fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(system)) return response(payload.readSections.length
      ? { action: 'done' } : { action: 'read', paths: ['head:Client.kt'] });
    assert.ok(payload.sources.some(s => s.path === 'head:docs/config.md' && s.text.includes('5000 ms')));
    return response({ summary: 'Документация уже обновлена автором.', findings: [] });
  } });
  assert.equal(audit.status, 'checked'); assert.deepEqual(audit.findings, []);
});

test('audit does not report a clean result when source retrieval is incomplete', async t => {
  const { config, context } = await fixture(t);
  const audit = await auditDocumentation(config, context, { fetchImpl: async () => response({ action: 'read', paths: ['unknown.kt'] }) });
  assert.equal(audit.status, 'limit'); assert.deepEqual(audit.findings, []);
  assert.equal(audit.retrieval.invalidRequests, 8);
  assert.equal(audit.retrieval.steps, 8);
  assert.match(audit.summary, /Отклонено запросов чтения: 8/);
  assert.ok(audit.sources.length > 0);
});

test('audit preloads changed code and all docs above the old search budget, with independent coverage', async t => {
  const { root, config, context } = await fixture(t);
  await writeFile(resolve(root, 'docs/large.md'), '# Guide\n' + 'Documentation context. '.repeat(2900));
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('add', '.'); await git('commit', '-m', 'large guide');
  const current = await buildReviewContext(root, context.base, await git('rev-parse', 'HEAD'));
  let retrievalCalls = 0, coverage = false;
  const audit = await auditDocumentation(config, current, { fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(system)) {
      retrievalCalls++;
      assert.ok(payload.readSections.some(s => s.path === 'head:Client.kt' && s.text.includes('timeoutMs')));
      assert.ok(payload.readSections.some(s => s.path === 'head:docs/large.md'));
      assert.ok(payload.readSections.reduce((sum, s) => sum + s.text.length, 0) > 60000);
      if (/^Ты независимый/.test(system)) coverage = true;
      return response({ action: 'done', reason: 'Seeded sources cover the change.' });
    }
    return response({ summary: 'Docs checked.', findings: [] });
  } });
  assert.equal(audit.status, 'checked'); assert.equal(retrievalCalls, 2); assert.equal(coverage, true);
  assert.ok(audit.retrieval.characters <= 140000);
});

test('incomplete retrieval names deferred sections and distinguishes character and step limits', async () => {
  const index = { documents: ['head:Large.kt'], chunks: [{ path: 'head:Large.kt', sourcePath: 'Large.kt', revision: 'head', startLine: 1, endLine: 70, text: '123456', heading: 'API' }] };
  const config = { apiKey: 'test', model: 'test', baseUrl: 'https://example.invalid' };
  const result = await collectIndexedContext(index, config, 'Check API', { maxCharacters: 5, initialSectionIds: [1], fetchImpl: async () => response({ action: 'done' }) });
  assert.equal(result.retrieval.status, 'limit');
  assert.deepEqual(result.retrieval.limits, ['characters']);
  assert.equal(result.retrieval.steps, 2);
  assert.deepEqual(result.retrieval.deferredSections, [{ sectionId: 1, path: 'head:Large.kt', startLine: 1, endLine: 70, characters: 6 }]);
  const report = renderReview({ context: { head: 'a'.repeat(40), base: 'b'.repeat(40), files: [], omitted: [] }, sources: [], retrieval: { status: 'checked' }, review: { summary: 'Code', findings: [] },
    documentationAudit: { status: 'limit', summary: result.retrieval.reason, retrieval: result.retrieval, findings: [], sources: [] } }, 'o/r');
  assert.match(report, /Статус аудита: не завершён/);
  assert.match(report, /head:Large.kt:1-70/);
  assert.match(report, /2\/8/); assert.match(report, /0\/5/);
  assert.doesNotMatch(report, /Статус аудита: limit|Подтверждённых расхождений документации не найдено/);
});

test('audit seeds current production and deleted definitions without exhausting budget on history and tests', async () => {
  const chunk = (revision, sourcePath, size) => ({ path: `${revision}:${sourcePath}`, sourcePath, revision,
    startLine: 1, endLine: 70, heading: sourcePath, text: 'x'.repeat(size) });
  const chunks = [chunk('head', 'docs/guide.md', 70000), chunk('head', 'Client.kt', 35000),
    chunk('base', 'Client.kt', 35000), chunk('head', 'app/src/desktopTest/ClientTest.kt', 65000),
    chunk('base', 'Deleted.kt', 5000)];
  const changedLines = new Map(['Client.kt', 'app/src/desktopTest/ClientTest.kt', 'Deleted.kt']
    .map(path => [path, { LEFT: new Set([1]), RIGHT: new Set([1]) }]));
  const context = { diff: 'production API changed; old API deleted; tests expanded', omitted: [], changedLines,
    index: { chunks, documents: chunks.map(s => s.path) } };
  const config = { apiKey: 'test', model: 'test', baseUrl: 'https://example.invalid' };
  const result = await auditDocumentation(config, context, { fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), payload = JSON.parse(messages[1].content);
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(messages[0].content)) {
      assert.deepEqual(payload.readSections.map(s => s.path), ['head:docs/guide.md', 'head:Client.kt', 'base:Deleted.kt']);
      assert.ok(payload.catalog.some(s => s.path === 'base:Client.kt'));
      assert.ok(payload.catalog.some(s => s.path.includes('desktopTest')));
      return response({ action: 'done' });
    }
    return response({ summary: 'Public API covered.', findings: [] });
  } });
  assert.equal(result.status, 'checked');
  assert.equal(result.retrieval.characters, 110000);
});

test('re-reading preloaded sections switches to independent coverage without marking them checked automatically', async () => {
  const index = { documents: ['head:API.kt'], chunks: [{ path: 'head:API.kt', sourcePath: 'API.kt', revision: 'head', startLine: 1, endLine: 1, text: 'fun api() = Unit', heading: 'API' }] };
  const config = { apiKey: 'test', model: 'test', baseUrl: 'https://example.invalid' };
  let calls = 0;
  const result = await collectIndexedContext(index, config, 'Check API', { initialSectionIds: [1], fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), payload = JSON.parse(messages[1].content);
    assert.equal(payload.catalog[0].sections[0].read, true);
    if (++calls === 1) return response({ action: 'read', paths: ['head:API.kt'] });
    assert.match(messages[0].content, /^Ты независимый проверяющий/);
    return response({ action: 'done', reason: 'Existing source is sufficient.' });
  } });
  assert.equal(result.retrieval.status, 'checked'); assert.equal(calls, 2);
  assert.equal(result.retrieval.noProgressRequests, 1);
  const incomplete = await collectIndexedContext(index, config, 'Check API', { initialSectionIds: [1], maxSteps: 2, fetchImpl: async () => response({ action: 'read', paths: ['head:API.kt'] }) });
  assert.equal(incomplete.retrieval.status, 'limit');
  assert.equal(incomplete.retrieval.noProgressRequests, 2);
});

test('CLI saves an incomplete audit report but exits nonzero', async t => {
  const { root, base, head } = await fixture(t);
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { messages } = JSON.parse(raw), system = messages[0].content, payload = JSON.parse(messages[1].content);
    const value = /^Ты агент поиска|^Ты независимый проверяющий/.test(system)
      ? payload.question.startsWith('Проверь актуальность README/docs')
        ? { action: 'read', paths: ['unknown.kt'] } : { action: 'done' }
      : { summary: 'Code checked.', findings: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const output = resolve(root, 'report');
  await assert.rejects(exec(process.execPath, [resolve('src/review-cli.js'), '--base', base, '--head', head, '--repo', 'o/r', '--output', output], {
    env: { ...process.env, PROJECT_ROOT: root, LLM_API_KEY: 'fake', LLM_MODEL: 'fake', LLM_BASE_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_STEP_SUMMARY: '' }
  }), error => error.code === 1 && /не считается успешной/.test(error.stderr));
  const report = JSON.parse(await readFile(resolve(output, 'review.json'), 'utf8'));
  assert.equal(report.documentationAudit.status, 'limit');
  assert.equal(report.documentationAudit.retrieval.invalidRequests, 8);
  assert.ok(report.documentationAudit.sources.length);
  assert.ok(!report.documentationAudit.sources.some(s => Object.hasOwn(s, 'text')));
});

test('audit validation rejects invented documents, unchanged lines and unsupported evidence', async t => {
  const { context } = await fixture(t);
  const sources = [{ sourcePath: 'Client.kt' }, { sourcePath: 'docs/config.md', revision: 'head' }];
  const finding = { path: 'Client.kt', side: 'RIGHT', line: 1, document: 'docs/config.md', title: 'Config', body: 'Update timeout.', sources: [1, 2] };
  for (const change of [{ document: 'docs/invented.md' }, { line: 400 }, { sources: [1] }, { sources: [99] }]) {
    assert.throws(() => validateDocsAudit({ summary: 'x', findings: [{ ...finding, ...change }] }, context, sources, ['docs/config.md']));
  }
});

test('post-merge sync keeps large docs outside the code budget for generation and verification', async t => {
  const { root, git, config, base } = await fixture(t);
  await writeFile(resolve(root, 'docs/large.md'), '# Large guide\n' + 'Existing documentation. '.repeat(2800));
  await git('add', '.'); await git('commit', '-m', 'large existing guide');
  const mcp = await connectProject(root); t.after(() => mcp.close());
  let coveragePasses = 0;
  const updated = '# Configuration\n\nClient.timeoutMs defaults to 5000 ms.\n';
  const result = await syncDocs(config, mcp, base, { apply: true, fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    if (/^Ты агент поиска|^Ты независимый проверяющий/.test(system)) {
      assert.ok(payload.catalog.every(d => !d.path.endsWith('.md')));
      assert.ok(payload.readSections.some(s => s.sourcePath === 'Client.kt' && s.text.includes('timeoutMs')));
      assert.ok(Object.values(payload.gitContext.documents).join('').length > 60000);
      if (/^Ты независимый/.test(system)) coveragePasses++;
      return response({ action: 'done' });
    }
    if (system.startsWith('Ты change_agent')) return new Response(JSON.stringify({ choices: [{ message: { content: 'Client.timeoutMs added.' } }] }));
    if (system.startsWith('Ты docs_sync_agent')) return response({ summary: 'Document timeout.', updates: [{ path: 'docs/config.md', content: updated }] });
    return response({ approved: true, reviewedPaths: ['docs/config.md'], issues: [] });
  } });
  assert.equal(result.verification.status, 'checked'); assert.equal(coveragePasses, 2);
  assert.equal(await readFile(resolve(root, 'docs/config.md'), 'utf8'), updated);
});

test('truncated multi-document generation falls back to single files and verifies all before saving', async t => {
  const { root, config, base, readme } = await fixture(t);
  const mcp = await connectProject(root); t.after(() => mcp.close());
  let writerCalls = 0;
  const updated = '# Configuration\n\nClient.timeoutMs defaults to 5000 ms.\n';
  const result = await syncDocs(config, mcp, base, { apply: true, fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    const found = retrieval(system, payload); if (found) return found;
    if (system.startsWith('Ты change_agent')) {
      assert.equal(JSON.parse(init.body).max_tokens, 8000);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Client.timeoutMs added.' } }] }));
    }
    if (system.startsWith('Ты docs_sync_agent')) {
      if (++writerCalls === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"updates":[' } }] }));
      if (writerCalls === 2) return response({ summary: 'Malformed proposal', updates: {} });
      assert.equal(Object.keys(payload.documents).length, 1);
      assert.equal(await readFile(resolve(root, 'docs/config.md'), 'utf8'), '# Configuration\n\nClient uses the default timeout.\n');
      return response({ summary: 'Config checked.', updates: Object.hasOwn(payload.documents, 'docs/config.md') ? [{ path: 'docs/config.md', content: updated }] : [] });
    }
    return response({ approved: true, reviewedPaths: ['docs/config.md'], issues: [] });
  } });
  assert.equal(writerCalls, 4); assert.equal(result.verification.status, 'checked');
  assert.equal(await readFile(resolve(root, 'README.md'), 'utf8'), readme);
  assert.equal(await readFile(resolve(root, 'docs/config.md'), 'utf8'), updated);
});

test('link checks parse reference links and images, ignore code examples and tolerate old broken links', async t => {
  const { root, readme } = await fixture(t);
  const originals = { 'README.md': readme + '\n[Old](old-missing.md)\n' };
  const valid = originals['README.md'] + '\n[Config][config]\n\n[config]: docs/config.md\n\n```md\n[Example](not-a-file.md)\n```\n';
  assert.equal((await checkDocumentationLinks(root, originals, [{ path: 'README.md', content: valid }])).status, 'checked');
  const failed = await checkDocumentationLinks(root, originals, [{ path: 'README.md', content: valid + '\n![Image](missing.png)\n[Bad][bad]\n\n[bad]: docs/missing.md\n[Escape](../outside.md)\n' }]);
  assert.equal(failed.issues.length, 3);
  assert.ok(failed.issues.some(i => i.href === 'docs/missing.md'));
});

test('documentation verifier requires an explicit verdict for every changed document', () => {
  assert.throws(() => validateDocsVerification({ approved: true, reviewedPaths: [], issues: [] }, ['README.md']));
  assert.throws(() => validateDocsVerification({ approved: true, reviewedPaths: ['README.md'], issues: [{ path: 'README.md', reason: 'Missing class' }] }, ['README.md']));
  assert.throws(() => validateDocsVerification({ approved: false, reviewedPaths: ['README.md'], issues: [] }, ['README.md']));
});

test('links validate heading anchors against proposed docs and catch breakage in untouched documents', async t => {
  const { root } = await fixture(t);
  const originals = { 'README.md': '# Project\n[Settings](docs/config.md#настройки-api-1)\n',
    'docs/config.md': '# Configuration\n## Настройки `API`\n## Настройки **API**\n' };
  assert.equal((await checkDocumentationLinks(root, originals, [])).status, 'checked');
  const failed = await checkDocumentationLinks(root, originals, [{ path: 'docs/config.md', content: '# Configuration\n## New settings\n' }]);
  assert.equal(failed.issues.length, 1); assert.equal(failed.issues[0].path, 'README.md');
  assert.match(failed.issues[0].reason, /Якорь/);
  const sameFile = await checkDocumentationLinks(root, originals, [{ path: 'docs/config.md', content: originals['docs/config.md'] + '\n[Local](#absent)\n[Root](../)\n' }]);
  assert.equal(sameFile.issues.length, 1); assert.equal(sameFile.issues[0].href, '#absent');
});

for (const mode of ['broken-link', 'invented-api', 'incomplete-verification']) {
  test(`sync blocks ${mode} before saving any document`, async t => {
    const { config, root, base, readme } = await fixture(t);
    const mcp = await connectProject(root); t.after(() => mcp.close());
    let writerCalled = false, verifierCalled = false;
    await assert.rejects(syncDocs(config, mcp, base, { apply: true, fetchImpl: async (_url, init) => {
      const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
      if (mode === 'incomplete-verification' && writerCalled && /^Ты агент поиска|^Ты независимый проверяющий/.test(system)) return response({ action: 'read', paths: ['unknown.kt'] });
      const retrieved = retrieval(system, payload); if (retrieved) return retrieved;
      if (system.startsWith('Ты change_agent')) return new Response(JSON.stringify({ choices: [{ message: { content: 'Client.timeoutMs added.' } }] }));
      if (system.startsWith('Ты docs_sync_agent')) {
        writerCalled = true;
        return response({ summary: 'Update docs', updates: [{ path: 'README.md', content: readme + (mode === 'broken-link' ? '\n[Config](docs/absent.md)\n' : '\nUse ImaginaryClient.configureMagic() to configure timeout.\n') }] });
      }
      assert.ok(system.startsWith('Ты docs_verifier'));
      verifierCalled = true;
      assert.ok(payload.sources.some(s => s.sourcePath === 'Client.kt' && s.text.includes('timeoutMs')));
      return response({ approved: false, reviewedPaths: ['README.md'], issues: [{ path: 'README.md', reason: 'ImaginaryClient.configureMagic does not exist in the read sources.' }] });
    } }), mode === 'broken-link' ? /Проверка ссылок/ : mode === 'invented-api' ? /Проверяющий отклонил/ : /Проверка документации неполна/);
    assert.equal(writerCalled, true); assert.equal(verifierCalled, mode === 'invented-api');
    assert.equal(await readFile(resolve(root, 'README.md'), 'utf8'), readme);
  });
}

test('a historical sync verifies proposed contracts against the current checkout', async t => {
  const { root, git, config, base, head, readme } = await fixture(t);
  await writeFile(resolve(root, 'Client.kt'), 'class Client(val timeoutSeconds: Long = 5)\n');
  await git('add', 'Client.kt'); await git('commit', '-m', 'replace timeout parameter');
  const mcp = await connectProject(root); t.after(() => mcp.close());
  let checkedCurrent = false;
  await assert.rejects(syncDocs(config, mcp, base, { head, apply: true, fetchImpl: async (_url, init) => {
    const { messages } = JSON.parse(init.body), system = messages[0].content, payload = JSON.parse(messages[1].content);
    const retrieved = retrieval(system, payload); if (retrieved) return retrieved;
    if (system.startsWith('Ты change_agent')) return new Response(JSON.stringify({ choices: [{ message: { content: 'timeoutMs added.' } }] }));
    if (system.startsWith('Ты docs_sync_agent')) return response({ summary: 'Document timeout', updates: [{ path: 'README.md', content: readme + '\nUse Client.timeoutMs to configure the client.\n' }] });
    assert.ok(system.startsWith('Ты docs_verifier'));
    const current = payload.sources.find(s => s.path === 'head:Client.kt');
    assert.match(current.text, /timeoutSeconds/); assert.ok(!current.text.includes('timeoutMs'));
    checkedCurrent = true;
    return response({ approved: false, reviewedPaths: ['README.md'], issues: [{ path: 'README.md', reason: 'timeoutMs has been replaced with timeoutSeconds.' }] });
  } }), /Проверяющий отклонил/);
  assert.equal(checkedCurrent, true); assert.equal(await readFile(resolve(root, 'README.md'), 'utf8'), readme);
});
