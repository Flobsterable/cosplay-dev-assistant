import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { tokenize } from './rag.js';
const exec = promisify(execFile);

export function reviewable(path) {
  if (path.startsWith('.github/') && !/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return false;
  return !/[\x00-\x1f"]/.test(path) && !/(^|\/)(?:\.[^/]+|node_modules|build|vendor)(?:\/|$)/.test(path.replace(/^\.github\//, 'github/')) &&
    !/(?:^|\/)(?:local\.properties|.*\.env.*|.*\.(?:pem|key|keystore|jks))$/i.test(path) &&
    (/\.(?:kt|kts|toml|properties|xml|md)$/i.test(path) || /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path));
}

export function changedLines(diff) {
  const result = new Map();
  let file, oldLine = 0, newLine = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!inHunk && line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t$/, ''); if (p !== '/dev/null') file = p.replace(/^a\//, '');
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, ''); if (p !== '/dev/null') file = p.replace(/^b\//, '');
      if (file && !result.has(file)) result.set(file, { LEFT: new Set(), RIGHT: new Set() });
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!file || !result.has(file)) continue;
    if (line.startsWith('+')) result.get(file).RIGHT.add(newLine++);
    else if (line.startsWith('-')) result.get(file).LEFT.add(oldLine++);
    else if (line.startsWith(' ')) { oldLine++; newLine++; }
  }
  return result;
}

export async function buildReviewContext(root, baseRef, headRef, { documentationSync = false } = {}) {
  async function git(...args) {
    return (await exec('git', ['-c', `safe.directory=${resolve(root)}`, '-c', 'core.quotePath=false', '-C', root, ...args], { timeout: 20000, maxBuffer: documentationSync ? Infinity : 4 * 1024 * 1024 })).stdout;
  }
  async function sha(ref) {
    if (typeof ref !== 'string' || !ref.length || ref.length > 200 || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error('Некорректный Git ref.');
    return (await git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)).trim();
  }
  const baseTip = await sha(baseRef), head = await sha(headRef);
  const base = (await git('merge-base', baseTip, head)).trim();
  const raw = (await git('diff', '--name-status', '-z', '--no-renames', base, head, '--')).split('\0');
  const files = [];
  for (let i = 0; i + 1 < raw.length; i += 2) files.push({ status: raw[i], path: raw[i + 1] });
  if (!documentationSync && files.length > 100) throw new Error('PR содержит более 100 файлов: разбейте его на меньшие изменения.');
  const eligible = files.filter(f => reviewable(f.path));
  const diff = eligible.length ? await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=5', base, head, '--', ...eligible.map(f => f.path)) : '';
  if (!documentationSync && diff.length > 100000) throw new Error('Diff превышает 100 000 символов: разбейте PR. Проверка не выполнена.');
  const chunks = [], documents = [], omitted = files.filter(f => !reviewable(f.path)).map(f => ({ path: f.path, reason: 'неподдерживаемый или исключённый тип файла' }));
  let total = 0, projectRules = null;
  async function indexTree(ref, label, filter) {
    const entries = (await git('ls-tree', '-r', '-z', ref)).split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s);
      if (!match || !reviewable(match[3]) || (filter && !filter.has(match[3]))) continue;
      const [, , blob, path] = match;
      const bytes = Number((await git('cat-file', '-s', blob)).trim());
      if (!documentationSync && (bytes > 128000 || total + bytes > 1500000)) { omitted.push({ path, reason: `${label}: лимит корпуса/файла` }); continue; }
      const text = await git('cat-file', 'blob', blob);
      if (text.includes('\0')) { omitted.push({ path, reason: 'бинарное содержимое' }); continue; }
      total += bytes;
      if (label === 'rules') projectRules = { path, ref, text };
      const catalogPath = `${label}:${path}`;
      documents.push(catalogPath);
      const lines = text.split(/\r?\n/);
      for (let start = 0; start < lines.length; start += 60) {
        const end = Math.min(start + 60, lines.length), body = lines.slice(start, end).join('\n');
        if (!body.trim()) continue;
        const heading = lines.slice(start, end).filter(l => /^(?:#{1,6}\s|\s*(?:public |private |internal |suspend |data |sealed |@Composable)*\b(?:fun|class|interface|object)\b)/.test(l)).join(' ').slice(0, 300) || path;
        chunks.push({ path: catalogPath, sourcePath: path, revision: label, heading, startLine: start + 1, endLine: end, text: body, tokens: tokenize(path + ' ' + heading + ' ' + body) });
      }
    }
  }
  // Established project rules come from the target base tip, not from PR changes.
  await indexTree(baseTip, 'rules', new Set(['docs/review-rules.md']));
  await indexTree(head, 'head');
  await indexTree(base, 'base', new Set(eligible.map(f => f.path)));
  return { base, baseTip, head, files, diff, eligible, omitted, projectRules, changedLines: changedLines(diff), index: { documents, chunks } };
}
