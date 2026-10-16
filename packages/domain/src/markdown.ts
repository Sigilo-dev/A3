export interface A3WikilinkToken {
  target: string;
  label: string | null;
  start: number;
  end: number;
}

export interface MarkdownSourceInspection {
  editable: boolean;
  reasons: readonly string[];
}

export interface MarkdownParseIssue {
  offset: number;
  line: number;
  column: number;
  code: 'unclosed-wikilink';
  message: string;
}

/** Reports source errors that the A3 Markdown extensions can locate without rewriting the source. */
export function inspectMarkdownParse(value: string): MarkdownParseIssue | null {
  let offset = 0;
  let lineNumber = 1;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  const lines = value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  for (const rawLine of lines) {
    if (!rawLine && offset >= value.length) break;
    const line = rawLine.replace(/(?:\r\n|\n|\r)$/, '');
    if (fence) {
      const markerPattern = fence.marker === '`' ? '\\x60' : '~';
      const close = new RegExp(`^ {0,3}${markerPattern}{${fence.length},}\\s*$`).test(line);
      if (close) fence = null;
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) fence = { marker: opening[1]![0] as '`' | '~', length: opening[1]!.length };
      else {
        const masked = line.replace(/(`+)[^`\r\n]*?\1/g, (code) => code.replace(/[^\r\n]/g, ' '));
        const tokens = /(?<!\\)\[\[/g;
        let token: RegExpExecArray | null;
        while ((token = tokens.exec(masked))) {
          const closing = masked.indexOf(']]', token.index + 2);
          if (closing < 0) {
            const column = token.index;
            return { offset: offset + column, line: lineNumber, column: column + 1, code: 'unclosed-wikilink', message: 'El wikilink A3 no tiene el cierre `]]`.' };
          }
          tokens.lastIndex = closing + 2;
        }
      }
    }
    offset += rawLine.length;
    lineNumber++;
  }
  return null;
}

/** Finds A3 links without interpreting code spans or fenced code blocks. */
export function findA3Wikilinks(value: string): readonly A3WikilinkToken[] {
  const matches: A3WikilinkToken[] = [];
  const masked = value.replace(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)[\s\S]*?^ {0,3}\1[ \t]*(?:\r?\n|$)/gm,
    (block) => block.replace(/[^\r\n]/g, ' ')).replace(/(`+)[^`]*?\1/g, (code) => code.replace(/[^\r\n]/g, ' '));
  const expression = /(?<!\\)\[\[([^\]\r\n]+)\]\]/g;
  for (const match of masked.matchAll(expression)) {
    const raw = match[1]!;
    const separator = raw.indexOf('|');
    const target = separator < 0 ? raw : raw.slice(0, separator);
    const label = separator < 0 ? null : raw.slice(separator + 1);
    if (!target.trim() || (label !== null && !label.trim())) continue;
    const start = match.index ?? 0;
    matches.push({ target, label, start, end: start + match[0].length });
  }
  return matches;
}

/**
 * Milkdown only receives source forms whose meaning is covered by A3's Markdown contract.
 * Unsupported constructs stay visible as escaped source text and cannot be saved from this editor.
 */
export function inspectMarkdownSource(value: string): MarkdownSourceInspection {
  const reasons = new Set<string>();
  const withoutFences = value.replace(/^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '');
  const withoutCode = withoutFences.replace(/(`+)([^`\r\n]|\r?\n(?!\r?\n))*?\1/g, '');

  if (/^---\s*\r?\n(?:[\w.-]+\s*:.*\r?\n)+---\s*$/m.test(withoutCode)) reasons.add('frontmatter');
  if (/^ {0,3}:::[^\r\n]*$/m.test(withoutCode)) reasons.add('directive-block');
  if (/^ {0,3}>\s*\[![^\]]+\]/m.test(withoutCode)) reasons.add('obsidian-callout');
  if (/!\[\[[^\]\r\n]+\]\]/.test(withoutCode)) reasons.add('embedded-wikilink');
  if (/^ {0,3}\^[\p{L}\p{N}_-]+[ \t]*$/mu.test(withoutCode) || /(?<=\s)\^[\p{L}\p{N}_-]+[ \t]*$/mu.test(withoutCode)) reasons.add('block-id');
  if (/^ {0,3}\[\^[^\]]+\]:/m.test(withoutCode) || /\[\^[^\]]+\]/.test(withoutCode)) reasons.add('footnote');
  if (/^ {0,3}(?:\$\$|\$)[^\r\n]*$/m.test(withoutCode)) reasons.add('math-block');
  if (/<!--|<!doctype\b|<\/?[a-z][^>]*>/i.test(withoutCode)) reasons.add('raw-html');
  if (/(?:\]\(\s*|<)(?:javascript|vbscript|data|file):/i.test(withoutCode)) reasons.add('executable-link');

  return { editable: reasons.size === 0, reasons: [...reasons] };
}
