import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { findA3Wikilinks, inspectMarkdownParse, inspectMarkdownSource } from '../dist/src/index.js';

test('A3-009 wikilinks keep targets, aliases, and stable heading or block fragments', () => {
  const value = '[[Página]] [[Página|Texto]] [[Página#Sección|Abrir]] [[Página^bloque|Bloque]] `[[no-es-un-enlace]]`\n\n```md\n[[tampoco]]\n```';
  assert.deepEqual(findA3Wikilinks(value).map(({ target, label }) => ({ target, label })), [
    { target: 'Página', label: null }, { target: 'Página', label: 'Texto' },
    { target: 'Página#Sección', label: 'Abrir' }, { target: 'Página^bloque', label: 'Bloque' }
  ]);
});

test('E0-D1 Markdown fixture retains its wikilink token and stays source-only for the unsupported block', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../../experiments/e0/editors-canvas/fixtures/markdown.md'), 'utf8');
  const links = findA3Wikilinks(source);
  assert.deepEqual(links.map(({ target, label }) => ({ target, label })), [{ target: 'entidad-a3', label: 'Entidad vinculada' }]);
  assert.deepEqual(inspectMarkdownSource(source), { editable: false, reasons: ['directive-block'] });
});

test('A3-009 source diagnostics locate an incomplete wikilink without interpreting code or changing line endings', () => {
  assert.deepEqual(inspectMarkdownParse('# Inicio\n\n[[incompleto\n'), {
    offset: 10, line: 3, column: 1, code: 'unclosed-wikilink', message: 'El wikilink A3 no tiene el cierre `]]`.'
  });
  assert.deepEqual(inspectMarkdownParse('# Inicio\r\n\r\n[[incompleto\r\n')?.line, 3, 'CRLF source keeps correct line locations');
  assert.equal(inspectMarkdownParse('`[[literal`\n\n```md\n[[también literal\n```'), null, 'inline and fenced code remain literal');
  assert.equal(inspectMarkdownParse('[[válido]] y [[incompleto')?.code, 'unclosed-wikilink');
  assert.equal(inspectMarkdownParse('[[válido|enlace]]'), null);
});

test('A3-009 rejects visual writes for syntax Milkdown cannot preserve and keeps regular Markdown editable', () => {
  assert.deepEqual(inspectMarkdownSource('# Página\n\n- [ ] tarea\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[[Página|enlace]]'), { editable: true, reasons: [] });
  for (const [source, reason] of [
    [':::bloque-desconocido\npayload\n:::', 'directive-block'],
    ['Texto con ID ^bloque-estable', 'block-id'],
    ['^bloque-estable', 'block-id'],
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
