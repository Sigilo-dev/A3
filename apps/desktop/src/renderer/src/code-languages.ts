import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

export const CODE_LANGUAGES = ['text', 'markdown', 'json', 'javascript', 'typescript', 'python', 'rust', 'cpp', 'html', 'css', 'yaml', 'toml', 'sql'] as const;
export type CodeLanguage = typeof CODE_LANGUAGES[number];
export function codeLanguageFor(path: string, hint?: string | null): CodeLanguage {
  const aliases: Record<string, CodeLanguage> = { md: 'markdown', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust', c: 'cpp', 'c++': 'cpp', h: 'cpp', yml: 'yaml', plaintext: 'text' };
  const declared = hint?.trim().toLowerCase();
  if (declared && (CODE_LANGUAGES as readonly string[]).includes(declared)) return declared as CodeLanguage;
  if (declared && aliases[declared]) return aliases[declared];
  const extension = path.toLowerCase().split('.').at(-1) ?? '';
  const extensions: Record<string, CodeLanguage> = { md: 'markdown', markdown: 'markdown', json: 'json', jsonc: 'json', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', py: 'python', pyw: 'python', rs: 'rust', c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', ino: 'cpp', html: 'html', htm: 'html', css: 'css', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql' };
  return extensions[extension] ?? 'text';
}

/** Only the selected, bundled language module is loaded. No project-provided executable extensions. */
export async function loadCodeLanguage(language: CodeLanguage): Promise<LanguageSupport | Extension> {
  switch (language) {
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'rust': return (await import('@codemirror/lang-rust')).rust();
    case 'cpp': return (await import('@codemirror/lang-cpp')).cpp();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'toml': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    default: return [];
  }
}
