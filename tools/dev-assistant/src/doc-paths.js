import { buildIndex } from './rag.js';

// Discover existing project documentation; never use an application-specific list.
export async function discoverEditableDocs(root) {
  return (await buildIndex(root)).documents;
}
