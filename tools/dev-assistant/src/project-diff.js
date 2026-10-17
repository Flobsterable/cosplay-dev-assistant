import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { editableDocs } from './doc-paths.js';
const exec = promisify(execFile);
const paths = ['*.kt', '*.kts', '*.toml', 'gradle.properties', '.github/workflows/release.yml'];
export async function readProjectDiff(root, base) {
  if (typeof base !== 'string' || !base.length || base.length > 200 || base.startsWith('-') || /[\s\x00-\x1f]/.test(base)) throw new Error('Укажите Git ref или SHA без пробелов и опций.');
  async function git(...args) {
    return (await exec('git', ['-c', `safe.directory=${resolve(root)}`, '-C', root, ...args], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  const baseSha = (await git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)).trim();
  const headSha = (await git('rev-parse', 'HEAD')).trim();
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', '--unified=5', baseSha, headSha, '--', ...paths);
  if (diff.length > 60000) throw new Error('Diff превышает 60 000 символов. Выберите меньший диапазон коммитов.');
  const files = (await git('diff', '--name-only', baseSha, headSha, '--', ...paths)).trim().split('\n').filter(Boolean);
  const dirtyDocs = (await git('status', '--porcelain', '--', ...editableDocs)).trim();
  return { base: baseSha, head: headSha, files, diff, dirtyDocs: Boolean(dirtyDocs) };
}
