const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const script = resolve(__dirname, '../../../.github/scripts/docs-sync-run.sh');

function runScenario(t, failModel) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-workflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'node'), `#!/usr/bin/env bash
echo request >> "$MOCK_ROOT/calls"
echo '${failModel ? 'HTTP 402: insufficient balance' : 'Documents generated and verified'}'
exit ${failModel ? 1 : 0}
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'git'), `#!/usr/bin/env bash
case "$1" in
  rev-parse) if [ "$2" = FETCH_HEAD ]; then echo remote-head; else echo generation-head; fi ;;
  log) : ;;
  merge-base) if [ "$4" = FETCH_HEAD ]; then exit 1; fi ;;
  diff)
    case "$3" in
      --quiet) exit 1 ;;
      --name-only) printf 'docs/features.md\\0' ;;
      --binary) echo 'saved generated changes' ;;
    esac ;;
  push) echo rejected >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync(bash, ['-c', 'export MOCK_ROOT="$(cd "$MOCK_ROOT" && pwd)"; export PATH="$MOCK_ROOT/bin:$PATH"; export RUNNER_TEMP="$MOCK_ROOT"; export GITHUB_STEP_SUMMARY="$MOCK_ROOT/summary"; bash "$TEST_SCRIPT"'], {
    env: { ...process.env, MOCK_ROOT: dir, TEST_SCRIPT: script.replaceAll('\\', '/'), ASSISTANT_ROOT: '/trusted-agent', TARGET_BRANCH: 'develop', BASE_SHA: 'a'.repeat(40), MERGED_SHA: 'b'.repeat(40) }, encoding: 'utf8'
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'request\n', 'exactly one paid generation');
  assert.match(readFileSync(join(dir, 'docs-sync-generation.txt'), 'utf8'), failModel ? /HTTP 402/ : /verified/);
  return { dir, result };
}

test('permanent model failure stops immediately and preserves its report', t => {
  const { dir, result } = runScenario(t, true);
  assert.match(result.stdout, /No automatic regeneration/);
  assert.equal(existsSync(join(dir, 'docs-sync-generated.patch')), false);
});

test('push conflict preserves the patch without regenerating documentation', t => {
  const { dir, result } = runScenario(t, false);
  assert.match(result.stdout, /Target branch moved/);
  assert.match(readFileSync(join(dir, 'docs-sync-generated.patch'), 'utf8'), /saved generated changes/);
});



test('central execution loads only trusted scripts and keeps LLM keys in the agent workflow', () => {
  const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/agent.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /queue: max/);
  const group = workflow.split("\n").find(line => line.startsWith("  group: agent-"));
  assert.ok(!group.includes("inputs.head"), "documentation ranges share a serial queue by branch");
  assert.match(workflow, /secrets.GEMINI_API_KEY/);
  assert.match(workflow, /secrets.LLM_API_KEY/);
  assert.match(workflow, /secrets.PROJECT_GITHUB_TOKEN/);
  assert.match(workflow, /REVIEW_PUBLISHER_LOGIN:/);
  assert.ok(workflow.includes('run: bash "$ASSISTANT_ROOT/.github/scripts/docs-sync-run.sh"'));
  assert.ok(!workflow.includes('run: bash .github/scripts/'));
});
