import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const paths = ['*.kt', '*.kts', '*.toml', 'gradle.properties', '.github/workflows/release.yml'];
export async function readProjectDiff(root, base, head = 'HEAD') {
  for (const ref of [base, head]) {
    if (typeof ref !== 'string' || !ref.length || ref.length > 200 || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error('Укажите Git ref или SHA без пробелов и опций.');
  }
  async function git(...args) {
    return (await exec('git', ['-c', `safe.directory=${resolve(root)}`, '-C', root, ...args], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  const baseSha = (await git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)).trim();
  const headSha = (await git('rev-parse', '--verify', '--end-of-options', `${head}^{commit}`)).trim();
  const checkoutHead = (await git('rev-parse', 'HEAD')).trim();
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', '--unified=5', baseSha, headSha, '--', ...paths);
  if (diff.length > 100000) throw new Error('Diff превышает 100 000 символов. Выберите меньший диапазон коммитов.');
  const files = (await git('diff', '--name-only', baseSha, headSha, '--', ...paths)).trim().split('\n').filter(Boolean);
  const dirtyDocs = (await git('status', '--porcelain', '--', 'README.md', 'docs/')).trim();
  return { base: baseSha, head: headSha, checkoutHead, files, diff, dirtyDocs: Boolean(dirtyDocs) };
}
