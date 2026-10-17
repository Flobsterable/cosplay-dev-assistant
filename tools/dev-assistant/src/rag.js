import { readFile, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const stopWords = new Set('как где что это для или при из на по и в с the a is of to and how where'.split(' '));
export function tokenize(text) {
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}_]+/gu) || [];
  return words.filter(w => w.length > 1 && !stopWords.has(w))
    .map(w => /^[а-я]+$/.test(w) && w.length > 5 ? w.slice(0, 5) : w);
}

// Small lexical RAG: BM25 over Markdown chunks. No embeddings or database.
export async function buildIndex(projectRoot) {
  const root = await realpath(projectRoot);
  const documents = [];
  async function visit(file) {
    const stat = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) return;
    const canonical = await realpath(file);
    if (!canonical.startsWith(root + sep)) return;
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) {
        if (!name.startsWith('.')) await visit(resolve(file, name));
      }
    } else if (/\.md$/i.test(file) && stat.size <= 1024 * 1024) {
      if (documents.length >= 300) throw new Error('Слишком много документов: лимит 300 Markdown-файлов.');
      const text = await readFile(file, 'utf8');
      documents.push({ path: relative(root, file).split(sep).join('/'), text });
    }
  }
  await visit(resolve(root, 'README.md'));
  await visit(resolve(root, 'docs'));
  if (!documents.length) throw new Error('Не найдены README.md или Markdown-файлы в docs/.');
  const chunks = [];
  for (const document of documents) {
    const lines = document.text.split(/\r?\n/);
    const sections = [];
    let boundary = 0;
    let heading = '';
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      const match = !fenced && lines[i].match(/^#{1,6}\s+(.+)/);
      if (match) {
        if (i > boundary) sections.push({ start: boundary, end: i, heading });
        boundary = i;
        heading = match[1];
      }
    }
    sections.push({ start: boundary, end: lines.length, heading });
    for (const section of sections) {
    let start = section.start;
    while (start < section.end) {
      let end = start;
      let size = 0;
      while (end < section.end && (size < 1800 || end === start)) {
        size += lines[end].length + 1;
        end++;
      }
      const text = lines.slice(start, end).join('\n');
      if (text.trim()) {
        chunks.push({ path: document.path, heading: section.heading, startLine: start + 1, endLine: end, text, tokens: tokenize(section.heading + ' ' + section.heading + ' ' + text) });
      }
      start = end < section.end && end - start > 4 ? end - 3 : end;
    }
    }
  }
  return {
    version: 2,
    fingerprint: createHash('sha256').update(JSON.stringify(documents)).digest('hex'),
    documents: documents.map(d => d.path),
    chunks
  };
}

export function search(index, question, limit = 8) {
  const terms = [...new Set(tokenize(question))];
  const chunks = index.chunks;
  const averageLength = chunks.reduce((n, c) => n + c.tokens.length, 0) / Math.max(chunks.length, 1);
  const frequencies = new Map(terms.map(term => [term, chunks.filter(c => c.tokens.includes(term)).length]));
  return chunks.map((chunk, index) => {
    let score = 0;
    for (const term of terms) {
      const count = chunk.tokens.filter(t => t === term).length;
      if (!count) continue;
      const df = frequencies.get(term);
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      score += idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * chunk.tokens.length / averageLength));
    }
    const { tokens, ...source } = chunk;
    return { ...source, sectionId: index + 1, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function saveIndex(projectRoot, index) {
  const folder = process.env.ASSISTANT_CACHE_DIR || resolve(projectRoot, 'tools/dev-assistant/.cache');
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return resolve(folder, 'index.json');
}
