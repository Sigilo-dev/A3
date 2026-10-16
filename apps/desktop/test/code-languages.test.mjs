import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, foldable, getIndentation } from '@codemirror/language';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { codeLanguageFor, loadCodeLanguage } from '../src/renderer/src/code-languages.ts';

const samples = {
  markdown: '# heading\n\n**strong**\n', json: '{\n  "café": 42\n}\n', javascript: 'function hello() {\n  return "niño";\n}\n',
  typescript: 'function hello(name: string): string {\n  return name;\n}\n', python: 'def hello():\n    return "hola"\n',
  rust: 'fn main() {\n  let value = 42;\n}\n', cpp: '#include <stdio.h>\nint main() {\n  return 0;\n}\n',
  html: '<section>\n  <h1>Hola</h1>\n</section>\n', css: 'body {\n  color: red;\n}\n', yaml: 'project:\n  name: A3\n',
  toml: '[project]\nname = "A3"\n', sql: 'SELECT name FROM projects WHERE id = 1;\n'
};
test('A3-011: bundled modules parse and highlight each promised language, including TOML stream tokens', async () => {
  for (const [name, source] of Object.entries(samples)) {
    const state = EditorState.create({ doc: source, extensions: [await loadCodeLanguage(name)] });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000); assert.ok(tree, name);
    let highlighted = 0; highlightTree(tree, classHighlighter, () => highlighted++);
    assert.ok(highlighted > 0, `${name}: actual syntax tokens are highlighted`);
  }
  const text = EditorState.create({ doc: 'arbitrary unknown file', extensions: [await loadCodeLanguage('text')] });
  assert.equal(ensureSyntaxTree(text, text.doc.length), null);
});
test('language selection follows file extensions and valid canonical language hints; unknown stays text', () => {
  for (const [extension, name] of Object.entries({ md: 'markdown', json: 'json', js: 'javascript', ts: 'typescript', py: 'python', rs: 'rust', c: 'cpp', cpp: 'cpp', html: 'html', css: 'css', yaml: 'yaml', toml: 'toml', sql: 'sql' })) {
    assert.equal(codeLanguageFor(`folder/SOURCE.${extension.toUpperCase()}`), name);
  }
  assert.equal(codeLanguageFor('source.txt', 'python'), 'python');
  assert.equal(codeLanguageFor('source.ts', 'unknown-package'), 'typescript');
  assert.equal(codeLanguageFor('unknown.custom'), 'text');
});
test('JavaScript, Python and JSON provide language-aware indentation and folding', async () => {
  for (const name of ['javascript', 'python', 'json']) {
    const state = EditorState.create({ doc: samples[name], extensions: [await loadCodeLanguage(name)] });
    ensureSyntaxTree(state, state.doc.length, 1000);
    assert.ok(foldable(state, 0, state.doc.line(1).to), `${name}: fold block`);
    assert.ok(getIndentation(state, state.doc.line(2).from) > 0, `${name}: indent body`);
  }
});
test('new runtime modules are fixed to exact MIT versions in the workspace and lockfile', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(pkg.dependencies).filter((n) => n.startsWith('@codemirror/'))) {
    const installed = JSON.parse(await readFile(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(installed.license, 'MIT', name); assert.equal(installed.version, pkg.dependencies[name], name);
    assert.equal(lock.packages[`node_modules/${name}`].version, installed.version, name);
  }
});
