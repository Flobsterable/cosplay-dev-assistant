const marker = '<!-- cosplay-ai-review -->';
export const reviewHeadMarker = head => `<!-- cosplay-ai-review-head:${head} -->`;
export async function publishReview({ repository, number, head, body, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/i.test(head) || !token) throw new Error('Некорректные параметры публикации ревью.');
  async function api(path, method = 'GET', data) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000), ...(data ? { body: JSON.stringify(data) } : {})
    });
    if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}.`);
    return response.json();
  }
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
