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

// Seed current production code. Historical definitions remain available through
// retrieval, but the diff already supplies the before/after changed lines.
// Deleted files have no head definition, so seed their base sections instead.
export function changedProductionSections(context) {
  const headPaths = new Set(context.index.chunks.filter(s => s.revision === 'head').map(s => s.sourcePath));
  return context.index.chunks.flatMap((s, i) => {
    if (/\.md$/i.test(s.sourcePath) || /(?:^|\/)src\/[^/]*test\//i.test(s.sourcePath)) return [];
    if (s.revision !== 'head' && !(s.revision === 'base' && !headPaths.has(s.sourcePath))) return [];
    const lines = context.changedLines.get(s.sourcePath)?.[s.revision === 'base' ? 'LEFT' : 'RIGHT'];
    return lines && [...lines].some(line => line >= s.startLine && line <= s.endLine) ? [i + 1] : [];
  });
}
