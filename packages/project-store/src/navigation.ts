import { posix } from 'node:path';
import { findA3Wikilinks } from '@a3/domain';

export interface NavigationSource { entityId: string; resourceId: string; title: string; path: string; content: string; revision: number; resourceRevision: number; mounted?: boolean; }
export interface PageAnchor { kind: 'heading' | 'block'; name: string; offset: number; }
export interface NavigationPage extends Omit<NavigationSource, 'content'> { anchors: PageAnchor[]; }
export interface PageLink { sourceId: string; target: string; label: string; kind: 'wiki' | 'markdown'; start: number; end: number;
  status: 'resolved' | 'ambiguous' | 'missing' | 'external'; candidates: string[]; entityId?: string; anchor?: PageAnchor; }
export interface NavigationIndex { pages: NavigationPage[]; links: PageLink[]; diagnostics: string[]; }
const key = (s: string): string => s.trim().normalize('NFC').toLocaleLowerCase('en-US');
const slug = (s: string): string => key(s).replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/g, '-');
const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Mask, never parse or execute, source code and HTML. Offsets remain in the original string. */
function prose(source: string, maskHtml = true): string {
  let fence = ''; let size = 0;
  const blank = (s: string): string => s.replace(/[^\r\n]/g, ' ');
  const masked = source.replace(/^---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m, (s, offset) => offset === 0 ? blank(s) : s)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank).replace(/<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank);
  return masked.split(/(?<=\n)/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (marker && marker[1]![0] === fence && marker[1]!.length >= size) fence = ''; return line.replace(/[^\r\n]/g, ' '); }
    if (marker) { fence = marker[1]![0]!; size = marker[1]!.length; return line.replace(/[^\r\n]/g, ' '); }
    return line.replace(maskHtml ? /(`+)[^`]*?\1|<!--.*?-->|<[^>]*>/g : /(`+)[^`]*?\1|<!--.*?-->/g, (v) => ' '.repeat(v.length));
  }).join('');
}
export function pageAnchors(content: string): PageAnchor[] {
  const anchors: PageAnchor[] = []; let offset = 0; const counts = new Map<string, number>();
  for (const line of prose(content).split(/(?<=\n)/)) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { const name = heading[1]!.trim(), base = slug(name), n = counts.get(base) ?? 0; counts.set(base, n + 1);
      anchors.push({ kind: 'heading', name: n ? `${base}-${n}` : base, offset });
      // Both human readable headings and standard Markdown slugs resolve to this offset.
      if (key(name) !== base) anchors.push({ kind: 'heading', name, offset }); }
    const block = line.match(/(?:^|\s)\^([\p{L}\p{N}_-]+)[ \t\r\n]*$/u);
    if (block) anchors.push({ kind: 'block', name: block[1]!, offset });
    offset += line.length;
  }
  return anchors;
}
interface LinkToken { target: string; label: string; kind: PageLink['kind']; start: number; end: number; }
function tokens(content: string): LinkToken[] {
  const masked = prose(content), found: LinkToken[] = findA3Wikilinks(masked).filter((t) => content[t.start - 1] !== '!')
    .map((t) => ({ ...t, label: t.label ?? t.target, kind: 'wiki' }));
  const standard = prose(content, false);
  for (const m of standard.matchAll(/(?<!!)\[([^\]\n]+)\]\(\s*(<[^>\n]+>|[^\s()]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    const raw = m[2]!, bracket = raw.startsWith('<'), destination = bracket ? raw.slice(1, -1) : raw;
    const start = m.index + m[0].indexOf(raw, m[0].indexOf('](') + 2) + (bracket ? 1 : 0);
    found.push({ kind: 'markdown', target: destination, label: m[1]!, start, end: start + destination.length });
  }
  const definitions = new Map<string, { target: string; start: number; end: number }[]>();
  for (const m of standard.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]+>|[^\s()]+)(?:[ \t]+["'][^\n]*?["'])?[ \t]*\r?$/gm)) {
    const raw = m[2]!, target = raw.startsWith('<') ? raw.slice(1, -1) : raw, start = m.index + m[0].indexOf(raw, m[0].indexOf(']:') + 2) + (raw.startsWith('<') ? 1 : 0);
    const name = key(m[1]!).replace(/\s+/g, ' '), entries = definitions.get(name) ?? []; entries.push({ target, start, end: start + target.length }); definitions.set(name, entries);
  }
  const references = standard.replace(/!\[[^\]\n]*\](?:\[[^\]\n]*\]|\([^\n]*?\))/g, (s) => ' '.repeat(s.length));
  for (const m of references.matchAll(/(?<!!|\\|\[)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    if ([':', '('].includes(standard[m.index + m[0].length] ?? '') || m[1]!.startsWith('^')) continue;
    const definition = definitions.get(key(m[2] || m[1]!).replace(/\s+/g, ' '));
    if (definition?.length === 1) found.push({ ...definition[0]!, kind: 'markdown', label: m[1]! });
  }
  return found.sort((a, b) => a.start - b.start);
}
export function resolvePageLink(index: Pick<NavigationIndex, 'pages'>, sourceId: string, target: string, kind: PageLink['kind'] = 'wiki'): Omit<PageLink, 'start' | 'end' | 'label'> {
  const base = { sourceId, target, kind }, source = index.pages.find((p) => p.entityId === sourceId);
  const raw = target.trim(), hash = raw.search(kind === 'wiki' ? /[#^]/ : /#/);
  let name: string, anchorName: string;
  try { name = decodeURIComponent(hash < 0 ? raw : raw.slice(0, hash)); anchorName = hash < 0 ? '' : decodeURIComponent(raw[hash] === '^' ? raw.slice(hash) : raw.slice(hash + 1)); } catch { return { ...base, status: 'missing', candidates: [] }; }
  if (/^[a-z][\w+.-]*:/i.test(name) || name.startsWith('//')) return { ...base, status: 'external', candidates: [] };
  let candidates: NavigationPage[];
  if (!name) candidates = source ? [source] : [];
  else if (id.test(name)) candidates = index.pages.filter((p) => key(p.entityId) === key(name));
  else if (kind === 'markdown') {
    const path = posix.normalize(posix.join(posix.dirname(source?.path ?? ''), name));
    candidates = /^[\/\\]/.test(name) || /^(?:\/|\\)|(?:^|\/)\.\.(?:\/|$)/.test(path) ? [] : index.pages.filter((p) => key(p.path) === key(path));
  } else {
    candidates = index.pages.filter((p) => [p.title, p.path, p.path.replace(/\.md$/i, ''), posix.basename(p.path, posix.extname(p.path))].some((v) => key(v) === key(name)));
  }
  if (candidates.length !== 1) return { ...base, status: candidates.length ? 'ambiguous' : 'missing', candidates: candidates.map((p) => p.entityId) };
  const page = candidates[0]!, block = anchorName.startsWith('^');
  const anchors = page.anchors.filter((a) => a.kind === (block ? 'block' : 'heading') && key(a.name) === key(block ? anchorName.slice(1) : anchorName));
  const unique = [...new Map(anchors.map((a) => [a.offset, a])).values()];
  if (anchorName && unique.length !== 1) return { ...base, status: unique.length ? 'ambiguous' : 'missing', candidates: [page.entityId] };
  return { ...base, status: 'resolved', candidates: [page.entityId], entityId: page.entityId, ...(unique[0] ? { anchor: unique[0] } : {}) };
}
export function buildNavigationIndex(sources: readonly NavigationSource[], diagnostics: string[] = []): NavigationIndex {
  const pages = sources.map(({ content, ...p }) => ({ ...p, anchors: pageAnchors(content) }));
  return { pages, diagnostics, links: sources.flatMap((p) => tokens(p.content).map((t) => ({ ...t, ...resolvePageLink({ pages }, p.entityId, t.target, t.kind) }))) };
}
/** Rewrite only uniquely resolved references and their destination spans. All other bytes stay exact. */
export function rewritePageReferences(sources: readonly NavigationSource[], replacements: readonly NavigationSource[]): Map<string, string> {
  const before = buildNavigationIndex(sources), after = buildNavigationIndex(replacements), result = new Map<string, string>();
  for (const source of sources) {
    const nextSource = replacements.find((p) => p.entityId === source.entityId)!; const edits: { start: number; end: number; value: string }[] = [];
    for (const link of before.links.filter((l) => l.sourceId === source.entityId && l.status === 'resolved')) {
      const target = after.pages.find((p) => p.entityId === link.entityId)!;
      const fragmentAt = link.target.search(link.kind === 'wiki' ? /[#^]/ : /#/), fragment = fragmentAt < 0 ? '' : link.target.slice(fragmentAt);
      let destination = link.target;
      if (link.kind === 'markdown' && (nextSource.path !== source.path || sources.find((p) => p.entityId === target.entityId)!.path !== target.path)) {
        destination = posix.relative(posix.dirname(nextSource.path), target.path).split('/').map(encodeURIComponent).join('/') + fragment;
      } else if (link.kind === 'wiki') {
        const resolved = resolvePageLink(after, source.entityId, destination);
        const oldTarget = sources.find((p) => p.entityId === target.entityId)!;
        if (resolved.status !== 'resolved' || resolved.entityId !== target.entityId || oldTarget.title !== target.title && key(link.target.split(/[#^]/)[0]!) === key(oldTarget.title)) {
          destination = target.title + fragment;
          const byTitle = resolvePageLink(after, source.entityId, destination);
          if (byTitle.status !== 'resolved' || byTitle.entityId !== target.entityId) destination = target.entityId + fragment;
        }
      }
      if (destination !== link.target) edits.push({ start: link.start, end: link.end, value: link.kind === 'wiki' ? `[[${destination}|${link.label}]]` : destination });
    }
    let content = source.content; const uniqueEdits = [...new Map(edits.map((e) => [e.start, e])).values()];
    for (const edit of uniqueEdits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
    if (content !== source.content) result.set(source.resourceId, content);
  }
  return result;
}
