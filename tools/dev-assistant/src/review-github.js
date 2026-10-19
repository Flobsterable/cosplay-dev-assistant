const marker = '<!-- cosplay-ai-review -->';
export const reviewHeadMarker = head => `<!-- cosplay-ai-review-head:${head} -->`;
function githubApi(repository, token, fetchImpl) {
  return async function api(path, method = "GET", data) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30000), ...(data ? { body: JSON.stringify(data) } : {})
    });
    if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}.`);
    return response.json();
  };
}
export async function publishReview({ repository, number, head, body, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/i.test(head) || !token) throw new Error('Некорректные параметры публикации ревью.');
  const api = githubApi(repository, token, fetchImpl);
  const pull = await api(`/pulls/${number}`);
  if (pull.head.sha !== head || pull.state !== 'open') return { published: false, reason: 'PR обновлён или закрыт; устаревшее ревью не опубликовано.' };
  let previous;
  const headMarker = reviewHeadMarker(head);
  function belongsToHead(comment) {
    if (comment.user?.login !== 'github-actions[bot]' || !comment.body?.startsWith(marker)) return false;
    const lines = comment.body.split('\n');
    if (lines.includes(headMarker)) return true;
    // Migrate the old single-comment format only when it refers to this exact SHA.
    return !comment.body.includes('<!-- cosplay-ai-review-head:') && lines.includes(`Коммит: \`${head}\``);
  }
  for (let page = 1; page <= 10; page++) {
    const comments = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
    previous = comments.find(belongsToHead);
    if (previous || comments.length < 100) break;
    if (page === 10) throw new Error('Слишком много комментариев для безопасного обновления отчёта.');
  }
  // Recheck immediately before the write, including after pagination.
  const current = await api(`/pulls/${number}`);
  if (current.head.sha !== head || current.state !== 'open') return { published: false, reason: 'PR изменился во время публикации; ревью пропущено.' };
  if (!body.startsWith(marker) || body.length > 60000) throw new Error('Некорректный Markdown ревью.');
  if (!body.split('\n').includes(headMarker)) body = body.replace(marker, marker + '\n' + headMarker);
  const result = previous
    ? await api(`/issues/comments/${previous.id}`, 'PATCH', { body })
    : await api(`/issues/${number}/comments`, 'POST', { body });
  return { published: true, url: result.html_url };
}

// Findings have already passed validateReview against the actual changed lines.
export async function publishInlineReview({ repository, number, head, findings, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/i.test(head) || !token || !Array.isArray(findings) || findings.length > 15) throw new Error('Некорректные параметры inline-ревью.');
  for (const f of findings) {
    if (typeof f.path !== 'string' || !f.path || !['LEFT', 'RIGHT'].includes(f.side) || !Number.isInteger(f.line) || f.line < 1 || typeof f.title !== 'string' || typeof f.body !== 'string') throw new Error('Некорректная привязка inline-замечания.');
  }
  const api = githubApi(repository, token, fetchImpl);
  const stamp = `<!-- kmp-inline-review:${head} -->`;
  const current = async () => {
    const pr = await api(`/pulls/${number}`);
    return pr.state === 'open' && pr.head.sha === head;
  };
  if (!await current()) return { published: false, reason: 'PR обновлён или закрыт; inline-ревью пропущено.' };
  const previous = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/pulls/${number}/comments?per_page=100&page=${page}`);
    previous.push(...batch.filter(c => c.user?.login === 'github-actions[bot]' && c.commit_id === head && c.body?.startsWith(stamp)));
    if (batch.length < 100) break;
    if (page === 10) throw new Error('Слишком много inline-комментариев для безопасной публикации.');
  }
  const clean = text => String(text).replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '@\u200b');
  const key = f => `${f.path}:${f.side}:${f.line ?? f.original_line}`;
  const pending = [];
  const matched = new Set();
  for (const f of findings) {
    const body = `${stamp}\n**[${clean(f.priority)}] ${clean(f.title)}**\n\n${clean(f.body)}\n\nПравила: ${clean(f.rules.map(r => `${r.layer}/${r.id}`).join(', '))}.`;
    const old = previous.find(c => key(c) === key(f));
    if (old) {
      matched.add(old.id);
      if (old.body !== body) {
        if (!await current()) return { published: false, reason: 'PR изменился; дальнейшая публикация пропущена.' };
        await api(`/pulls/comments/${old.id}`, 'PATCH', { body });
      }
    } else pending.push({ path: f.path, side: f.side, line: f.line, body });
  }
  for (const old of previous.filter(c => !matched.has(c.id))) {
    if (old.body.includes('<!-- no-longer-confirmed -->')) continue;
    if (!await current()) return { published: false, reason: 'PR изменился; дальнейшая публикация пропущена.' };
    await api(`/pulls/comments/${old.id}`, 'PATCH', { body: old.body + '\n\n<!-- no-longer-confirmed -->\nПовторная проверка этого коммита не подтвердила замечание.' });
  }
  if (pending.length) {
    if (!await current()) return { published: false, reason: 'PR изменился; inline-ревью пропущено.' };
    const review = await api(`/pulls/${number}/reviews`, 'POST', {
      commit_id: head, event: 'COMMENT', comments: pending
    });
    return { published: true, url: review.html_url, comments: pending.length };
  }
  return { published: true, comments: 0 };
}
