import { changedLines } from './review-context.js';

// README/docs already have a separate bounded slot in the sync/verifier payload.
// Do not make their repeated retrieval consume the source-code budget as well.
export function sourceIndexForDocs(index) {
  const chunks = index.chunks.filter(s => !/\.md$/i.test(s.sourcePath));
  return { documents: [...new Set(chunks.map(s => s.path))], chunks };
}

export function changedSourceSections(index, diff) {
  const changed = changedLines(diff);
  return index.chunks.flatMap((s, i) => {
    const lines = changed.get(s.sourcePath)?.[s.revision === 'base' ? 'LEFT' : 'RIGHT'];
    return lines && [...lines].some(line => line >= s.startLine && line <= s.endLine) ? [i + 1] : [];
  });
}
