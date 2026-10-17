import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPromptContext } from '../dist/src/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e4/prompts/context-cases.json', import.meta.url), 'utf8'));

test('A3-019/A3-022: compiles only explicit sources and exposes origin/hash manifest without visual edges', () => {
  const result = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, fixture.documents, fixture.unavailable, { maxBytes: 16 * 1024 });
  assert.equal(result.visualEdgesIncluded, 0);
  assert.deepEqual(result.included.map((entry) => entry.key).sort(), fixture.documents.map((entry) => entry.key).sort());
  assert.equal(result.omitted[0].reason, 'unsupported-media-type');
  assert.equal(result.included.find((entry) => entry.category === 'project-memory').originPath, 'memory/principios.md');
  assert.match(result.parts[0].markdown, /SHA-256 del origen/);
  assert.match(result.parts[0].markdown, /Mantener la experiencia local-first/);
  assert.ok(result.parts.every((part) => part.bytes <= 16 * 1024));
  const bounded = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, fixture.documents, fixture.unavailable, { maxBytes: 4 * 1024 });
  assert.ok(bounded.parts.every((part) => part.bytes <= 4 * 1024));
});

test('A3-019: marks user exclusions and never silently truncates an over-budget source', () => {
  const largeContent = 'Requisito completo Ω\n'.repeat(1000);
  const large = { ...fixture.documents[0], content: largeContent, sourceBytes: Buffer.byteLength(largeContent) };
  const excluded = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, [large], [], {
    maxBytes: 4 * 1024, excludedSourceKeys: [large.key]
  });
  assert.equal(excluded.included.length, 0);
  assert.equal(excluded.omitted[0].reason, 'user-excluded');

  const overflow = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, [large], [], { maxBytes: 4 * 1024 });
  assert.equal(overflow.included.length, 0);
  assert.equal(overflow.omitted[0].reason, 'source-exceeds-budget');
  assert.ok(overflow.parts.every((part) => part.bytes <= 4 * 1024));
  assert.doesNotMatch(overflow.parts[0].markdown, /Requisito completo/);
});

test('A3-019: split mode preserves a large selected source across byte-bounded parts', () => {
  const largeContent = Array.from({ length: 900 }, (_, i) => `Bloque ${i + 1}: datos completos Ω`).join('\n');
  const large = { ...fixture.documents[1], contentFormat: 'text', content: largeContent, sourceBytes: Buffer.byteLength(largeContent) };
  const result = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, [large], [], { maxBytes: 4 * 1024, split: true });
  assert.equal(result.omitted.length, 0);
  assert.equal(result.included.length, 1);
  assert.ok(result.included[0].parts.length > 1);
  assert.ok(result.parts.every((part) => part.bytes <= 4 * 1024));
  const combined = result.parts.map((part) => part.markdown).join(''); let cursor = 0;
  for (const line of largeContent.split('\n')) {
    const offset = combined.indexOf(line, cursor); assert.ok(offset >= cursor, `fragment missing or reordered: ${line}`); cursor = offset + line.length;
  }
});

test('A3-022: project compilations do not share another project name or sources', () => {
  const privateSource = { ...fixture.documents[1], content: 'solo proyecto A: secreto de prueba' };
  const first = buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, [privateSource], [], { maxBytes: 16 * 1024 });
  const second = buildPromptContext('00000000-0000-4000-8000-000000000099', 'proyecto B', fixture.base, [], [], { maxBytes: 16 * 1024 });
  assert.match(first.parts[0].markdown, /solo proyecto A/);
  assert.doesNotMatch(second.parts[0].markdown, /solo proyecto A|fixture A3/);
  assert.equal(second.projectId, '00000000-0000-4000-8000-000000000099');
});

test('A3-019: an undersized budget is rejected instead of permitting an implicit trim', () => {
  assert.throws(() => buildPromptContext(fixture.project.id, fixture.project.name, fixture.base, [], [], { maxBytes: 64 }), /presupuesto/i);
});
