import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { findA3Wikilinks, inspectMarkdownSource } from '../dist/src/index.js';

test('A3-009 wikilinks keep targets, aliases, and stable heading or block fragments', () => {
  const value = '[[Página]] [[Página|Texto]] [[Página#Sección|Abrir]] [[Página^bloque|Bloque]] `[[no-es-un-enlace]]`\n\n```md\n[[tampoco]]\n```';
  assert.deepEqual(findA3Wikilinks(value).map(({ target, label }) => ({ target, label })), [
    { target: 'Página', label: null }, { target: 'Página', label: 'Texto' },
    { target: 'Página#Sección', label: 'Abrir' }, { target: 'Página^bloque', label: 'Bloque' }
  ]);
});

test('E0-D1 Markdown fixture retains its wikilink token and is marked read-only for the unsupported block', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../../experiments/e0/editors-canvas/fixtures/markdown.md'), 'utf8');
  const links = findA3Wikilinks(source);
  assert.deepEqual(links.map(({ target, label }) => ({ target, label })), [{ target: 'entidad-a3', label: 'Entidad vinculada' }]);
  assert.deepEqual(inspectMarkdownSource(source), { editable: false, reasons: ['directive-block'] });
});

test('A3-009 rejects visual writes for syntax Milkdown cannot preserve and keeps regular Markdown editable', () => {
  assert.deepEqual(inspectMarkdownSource('# Página\n\n- [ ] tarea\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[[Página|enlace]]'), { editable: true, reasons: [] });
  for (const [source, reason] of [
    [':::bloque-desconocido\npayload\n:::', 'directive-block'],
    ['---\ntitle: Nota\n---', 'frontmatter'],
    ['<!-- comentario -->', 'raw-html'],
    ['[abrir](javascript:alert(1))', 'executable-link'],
    ['![[nota]]', 'embedded-wikilink']
  ]) {
    const result = inspectMarkdownSource(source);
    assert.equal(result.editable, false, source);
    assert.ok(result.reasons.includes(reason), source);
  }
  assert.deepEqual(inspectMarkdownSource('```html\n<script>alert(1)</script>\n```'), { editable: true, reasons: [] }, 'code stays literal text');
});
