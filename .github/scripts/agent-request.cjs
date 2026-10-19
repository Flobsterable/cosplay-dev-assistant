'use strict';

const { readFile, appendFile } = require('node:fs/promises');

const DEFAULT_PROJECTS = 'Flobsterable/cosplay-2';
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function normalizeRequest(eventName, event, { allowedProjects = DEFAULT_PROJECTS } = {}) {
  let kind, raw;
  if (eventName === 'repository_dispatch') {
    kind = ({ 'agent-review': 'review', 'agent-docs-sync': 'docs-sync' })[event.action];
    raw = event.client_payload;
  } else if (eventName === 'workflow_dispatch') {
    raw = event.inputs;
    kind = raw?.type;
  }
  if (!['review', 'docs-sync'].includes(kind) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unsupported or malformed agent request.');
  const projects = new Set(String(allowedProjects).split(',').map(value => value.trim()).filter(Boolean));
  const repository = raw.repository;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || !projects.has(repository)) throw new Error('Project repository is not allowed.');
  for (const field of ['base', 'head']) if (typeof raw[field] !== 'string' || !SHA.test(raw[field])) throw new Error(`Request ${field} must be a full lowercase 40-character commit SHA.`);
  const branch = raw.branch;
  if (typeof branch !== 'string' || !branch || branch.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('Invalid target branch.');
  if (kind === 'docs-sync' && !['develop', 'main'].includes(branch)) throw new Error('Documentation sync is allowed only for develop or main.');
  const pr = raw.pr === undefined || raw.pr === '' || raw.pr === null ? '' : String(raw.pr);
  if ((kind === 'review' && !pr) || (pr && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr))))) throw new Error('Invalid pull request number.');
  return { kind, repository, base: raw.base, head: raw.head, branch, pr };
}

async function prepareRequest({ eventName, event, allowedProjects = DEFAULT_PROJECTS, api }) {
  const request = normalizeRequest(eventName, event, { allowedProjects });
  const result = { ...request, checkout: request.head, skip: 'false' };
  if (request.kind === 'review') {
    const pr = await api('GET', `/repos/${request.repository}/pulls/${request.pr}`);
    if (pr.head?.repo?.full_name !== request.repository || pr.base?.repo?.full_name !== request.repository) throw new Error('Fork or mismatched pull request repository is not allowed.');
    if (pr.base?.ref !== request.branch) throw new Error('Requested branch does not match the pull request base branch.');
    if (pr.state !== 'open' || pr.draft || pr.head?.sha !== request.head || pr.base?.sha !== request.base) result.skip = 'true';
  } else {
    const branch = await api('GET', `/repos/${request.repository}/branches/${encodeURIComponent(request.branch)}`);
    if (!SHA.test(branch.commit?.sha || '')) throw new Error('GitHub returned an invalid current target commit.');
    result.checkout = branch.commit.sha;
  }
  return result;
}

async function writeOutputs(result, outputPath) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required.');
  const fields = ['kind', 'repository', 'base', 'head', 'branch', 'pr', 'checkout', 'skip', 'publisher'];
  const lines = fields.map(field => {
    const value = String(result[field] ?? '');
    if (/[\r\n\x00]/.test(value)) throw new Error('Invalid workflow output.');
    return `${field}=${value}\n`;
  }).join('');
  await appendFile(outputPath, lines);
}

function recoveryMarker(request) {
  return `<!-- cosplay-dev-assistant:docs-sync repository=${request.repository} branch=${request.branch} head=${request.head} -->`;
}

async function resolvePublisher(api) {
  const identity = await api('GET', '/user');
  if (typeof identity?.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(identity.login)) {
    throw new Error('PROJECT_GITHUB_TOKEN must identify a GitHub user PAT.');
  }
  return identity.login;
}

async function updateRecovery({ request, result, runUrl, api, allowedProjects = DEFAULT_PROJECTS }) {
  // Revalidate normalized environment metadata before any issue mutation.
  request = normalizeRequest('workflow_dispatch', { inputs: { ...request, type: request.kind } }, { allowedProjects });
  if (request.kind !== 'docs-sync' || result === 'skipped') return { action: 'none' };
  if (!['success', 'failure', 'cancelled'].includes(result)) throw new Error('Unknown sync result.');
  const run = new URL(runUrl);
  if (run.protocol !== 'https:' || run.username || run.password || !/\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(run.pathname) || run.search || run.hash) throw new Error('Invalid central workflow run URL.');
  const marker = recoveryMarker(request);
  const legacyMarker = `<!-- docs-sync-recovery:${request.branch}:${request.head} -->`;
  const endpoint = `/repos/${request.repository}/issues`;
  let existing;
  // No creator-name assumption: a repository PAT opens issues as its owner.
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Issue lookup did not finish; refusing to create duplicate recovery tracking.');
    const issues = await api('GET', `${endpoint}?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error('GitHub returned invalid issue metadata.');
    existing = issues.find(issue => !issue.pull_request && typeof issue.body === 'string' &&
      issue.body.split(/\r?\n/).some(line => line === marker || line === legacyMarker));
    if (existing || issues.length < 100) break;
  }
  if (result === 'success') {
    if (!existing || existing.state === 'closed') return { action: 'none' };
    await api('PATCH', `${endpoint}/${existing.number}`, { state: 'closed', state_reason: 'completed' });
    return { action: 'closed', number: existing.number };
  }
  const body = `${marker}\nDocumentation sync requires recovery.\n\nRepository: ${request.repository}\nBranch: ${request.branch}\nSource range: ${request.base}..${request.head}\nResult: ${result}\nCentral workflow: ${run.href}\n\nRetry this exact range with the central agent workflow. No model output is included in this tracker.`;
  const title = `Документация не обновлена: ${request.branch} ${request.head.slice(0, 12)}`;
  if (existing) {
    await api('PATCH', `${endpoint}/${existing.number}`, { title, body, state: 'open' });
    return { action: 'updated', number: existing.number };
  }
  const created = await api('POST', endpoint, { title, body });
  return { action: 'created', number: created.number };
}

function createGitHubApi(token, { fetchImpl = fetch, apiUrl = 'https://api.github.com' } = {}) {
  if (!token) throw new Error('PROJECT_GITHUB_TOKEN is required.');
  return async (method, path, body) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}.`);
    return response.status === 204 ? null : response.json();
  };
}

async function main(command, env = process.env) {
  const api = createGitHubApi(env.PROJECT_GITHUB_TOKEN, { apiUrl: env.GITHUB_API_URL || 'https://api.github.com' });
  if (command === 'prepare') {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    const request = await prepareRequest({ eventName: env.GITHUB_EVENT_NAME, event, allowedProjects: env.AGENT_PROJECTS || DEFAULT_PROJECTS, api });
    request.publisher = await resolvePublisher(api);
    await writeOutputs(request, env.GITHUB_OUTPUT);
    return request;
  }
  if (command === 'status') {
    const request = { kind: env.REQUEST_KIND, repository: env.REQUEST_REPOSITORY, base: env.REQUEST_BASE,
      head: env.REQUEST_HEAD, branch: env.REQUEST_BRANCH, pr: env.REQUEST_PR };
    const runUrl = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    return updateRecovery({ request, result: env.SYNC_RESULT, runUrl, api, allowedProjects: env.AGENT_PROJECTS || DEFAULT_PROJECTS });
  }
  throw new Error('Use agent-request.cjs prepare or status.');
}

module.exports = { normalizeRequest, prepareRequest, writeOutputs, recoveryMarker, resolvePublisher, updateRecovery, createGitHubApi, main };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(`Agent request rejected: ${error.message}`); process.exitCode = 1; });
