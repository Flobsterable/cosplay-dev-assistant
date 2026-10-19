#!/usr/bin/env bash
# One paid generation per run. An explicit rerun is required after any failure.
set -euo pipefail
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
marker="Docs-Sync-Source: $MERGED_SHA"
git fetch origin "refs/heads/$TARGET_BRANCH"
git reset --hard FETCH_HEAD
git merge-base --is-ancestor "$MERGED_SHA" HEAD
generation_head=$(git rev-parse HEAD)
if git log --format=%B --fixed-strings --grep="$marker" | grep -Fxq "$marker"; then
  echo "Documentation for $MERGED_SHA was already committed." | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
if ! node "$ASSISTANT_ROOT/tools/dev-assistant/src/cli.js" /sync "$BASE_SHA" --head "$MERGED_SHA" --apply 2>&1 | tee "$RUNNER_TEMP/docs-sync-generation.txt"; then
  echo '::error::Documentation generation/verification failed. No automatic regeneration: inspect the saved report and recovery issue, fix the cause, then explicitly rerun.'
  exit 1
fi
git add -- README.md ':(glob)docs/**/*.md'
if git diff --cached --quiet; then
  echo 'Documentation is already current; no commit needed.' | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
while IFS= read -r -d '' path; do
  case "$path" in README.md|docs/*.md) ;; *) echo "Unexpected staged path: $path"; exit 1 ;; esac
done < <(git diff --cached --name-only -z)
git diff --cached --check
# Keep generated work recoverable if a concurrent merge rejects the push.
git diff --cached --binary > "$RUNNER_TEMP/docs-sync-generated.patch"
git commit -m "docs: sync after merge ${MERGED_SHA:0:8}" -m "$marker"
if git push origin "HEAD:refs/heads/$TARGET_BRANCH"; then
  echo "Documentation committed to $TARGET_BRANCH: $(git rev-parse HEAD)" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
git fetch origin "refs/heads/$TARGET_BRANCH"
if git merge-base --is-ancestor HEAD FETCH_HEAD; then
  echo 'Documentation commit is already present on the target branch.' | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
if [ "$(git rev-parse FETCH_HEAD)" = "$generation_head" ]; then
  echo '::error::Push rejected without a branch update. Check write permissions or branch protection. The generated patch is saved; generation will not be repeated automatically.'
else
  echo '::error::Target branch moved. The generated patch is saved; inspect it or explicitly rerun on the current branch. Generation will not be repeated automatically.'
fi
exit 1
