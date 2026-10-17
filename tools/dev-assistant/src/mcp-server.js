import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readProjectDiff } from './project-diff.js';

const exec = promisify(execFile);
const root = resolve(process.argv[2] || process.cwd());
const server = new McpServer({ name: 'project-context', version: '1.0.0' });
const git = async (...args) => (await exec('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

server.registerTool('get_current_branch', {
  description: 'Текущая Git-ветка копии проекта; при detached HEAD — короткий SHA.',
  inputSchema: {}, annotations: readOnly
}, async () => {
  const branch = (await git('branch', '--show-current')).trim();
  return result({ branch: branch || `detached:${(await git('rev-parse', '--short', 'HEAD')).trim()}` });
});

server.registerTool('get_project_diff', {
  description: 'Diff Kotlin/Gradle/release.yml от base до HEAD. Только закоммиченные изменения.',
  inputSchema: { base: z.string().min(1).max(200) }, annotations: readOnly
}, async ({ base }) => result(await readProjectDiff(root, base)));

await server.connect(new StdioServerTransport());
