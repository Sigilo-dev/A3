import { createHash } from 'node:crypto';
export const MEMORY_DEFAULTS = [
  { role: 'overview', path: 'memory/overview.md', title: 'Visión general', content: '# Visión general\n\nDescribe el propósito, alcance y contexto del proyecto.\n' },
  { role: 'decisions', path: 'memory/decisions.md', title: 'Decisiones', content: '# Decisiones\n\nRegistra decisiones, motivos y alternativas consideradas.\n' },
  { role: 'constraints', path: 'memory/constraints.md', title: 'Restricciones', content: '# Restricciones\n\nDocumenta límites técnicos, de alcance y de recursos.\n' }
] as const;
export interface MemorySummarySource { kind: 'entity' | 'resource'; id: string; label: string; hash: string; }
export interface MemorySummary { recordedAt: string; actor: { kind: string; id: string }; sources: MemorySummarySource[]; }
export interface SearchSource {
  key: string; origin: string; title: string; tags: string[]; text: string; hash: string;
  entityIds: string[]; resourceId?: string; itemId?: string;
  placements: { workspaceId: string; workspaceName: string; placementId: string }[];
}
export interface SearchHit extends Omit<SearchSource, 'text'> { snippet: string; score: number; }
export interface SearchStats { documents: number; updated: number; removed: number; unchanged: number; generation: number; }
export interface ProjectSearchState {
  sessionId: string; projectId: string; query: string; results: SearchHit[]; total: number; stats: SearchStats;
  diagnostics: string[]; exclusions: string[]; partial: boolean;
}
export interface ProjectMemoryState {
  sessionId: string; projectId: string; canWrite: boolean; reason: string;
  documents: { entityId: string; resourceId: string; title: string; path: string; role: string; summary?: MemorySummary; diagnostic?: string }[];
  missingRoles: string[];
}
export interface MemoryDocumentInput {
  entityId: string; resourceId: string; title: string; role: string; path: string; content: string; summary?: MemorySummary;
}
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const ignoredParts = /^(?:\.git|\.a3|node_modules|\.venv|venv|env|\.env|__pycache__|\.mypy_cache|\.pytest_cache|\.tox|\.nox|dist|build|out|target|coverage|\.next|\.cache|bin|obj)$/i;
const secret = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const compiled = /\.(?:exe|dll|so|dylib|pyc|pyo|class|o|obj|a|lib|wasm|zip|jar|gz|7z|tar|mp4|mp3|png|jpg|jpeg|avif|webp|pdf|sqlite|db|lock)$/i;
export function validSearchPatterns(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160 && /^[\w./*? -]+$/.test(item) && !item.split('/').includes('..') && !item.startsWith('/'));
}
function matchGlob(path: string, pattern: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; regex += '(?:.*/)?'; } else regex += '.*'; }
    else if (char === '*') regex += '[^/]*'; else if (char === '?') regex += '[^/]'; else regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp('^(?:' + (pattern.includes('/') ? '' : '.*/') + ')?' + regex + '(?:/.*)?$', 'i').test(path);
}
export function searchExcluded(path: string, additional: readonly string[] = []): boolean {
  return path.toLowerCase() === 'a3.project.json' || path.split('/').some((part) => ignoredParts.test(part) || secret.test(part)) || compiled.test(path) || additional.some((pattern) => matchGlob(path, pattern));
}
export const searchFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host-only, disposable and session-bound. Source bytes remain authoritative. */
export class LocalSearchIndex {
  #entries = new Map<string, { source: SearchSource; fingerprint: string; searchable: string; title: string; tags: string }>();
  #generation = 0;
  update(sources: SearchSource[], rebuild = false): SearchStats {
    if (rebuild) this.#entries.clear();
    const seen = new Set<string>(); let updated = 0, unchanged = 0, removed = 0;
    for (const source of sources) {
      seen.add(source.key); const fingerprint = searchFingerprint(source), existing = this.#entries.get(source.key);
      if (existing?.fingerprint === fingerprint) { unchanged++; continue; }
      this.#entries.set(source.key, { source: structuredClone(source), fingerprint, title: normalize(source.title), tags: normalize(source.tags.join(' ')), searchable: normalize(source.title + '\n' + source.tags.join(' ') + '\n' + source.text) }); updated++;
    }
    for (const key of this.#entries.keys()) if (!seen.has(key)) { this.#entries.delete(key); removed++; }
    return { documents: this.#entries.size, updated, unchanged, removed, generation: ++this.#generation };
  }
  search(query: string): { results: SearchHit[]; total: number } {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    const results: SearchHit[] = [];
    if (!terms.length) return { results, total: 0 };
    for (const entry of this.#entries.values()) {
      if (!terms.every((term) => entry.searchable.includes(term))) continue;
      const { text, ...metadata } = entry.source;
      const lines = text.split(/\r?\n/), matched = lines.find((line) => terms.some((term) => normalize(line).includes(term))) ?? lines[0] ?? '';
      const at = Math.max(0, normalize(matched).indexOf(terms[0]!)), start = Math.max(0, at - 80);
      const snippet = (start ? '…' : '') + matched.slice(start, start + 300) + (matched.length > start + 300 ? '…' : '');
      results.push({ ...metadata, snippet, score: terms.reduce((score, term) => score + (entry.title.includes(term) ? 6 : entry.tags.includes(term) ? 4 : 1), 0) });
    }
    results.sort((a, b) => b.score - a.score || a.origin.localeCompare(b.origin) || a.key.localeCompare(b.key));
    return { results: structuredClone(results.slice(0, 100)), total: results.length };
  }
}
