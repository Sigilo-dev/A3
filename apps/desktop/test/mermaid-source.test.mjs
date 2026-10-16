import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import mermaid from 'mermaid';
import { hasMermaidSourceAuthority, mermaidSourceProperties, MERMAID_RENDERER_VERSION, renderMermaidSource, supportsMermaidSourceRenderer } from '@a3/domain/mermaid-source';

const validSource = readFileSync(new URL('../../../fixtures/e3/mermaid/flowchart.mmd', import.meta.url), 'utf8');
const invalidSource = readFileSync(new URL('../../../fixtures/e3/mermaid/invalid.mmd', import.meta.url), 'utf8');

test('E3-D1 pins a Mermaid source authority descriptor to the verified MIT renderer version', () => {
  assert.deepEqual(mermaidSourceProperties(), {
    'a3.diagram.authority': 'source', 'a3.diagram.format': 'mermaid', 'a3.diagram.renderer': `mermaid@${MERMAID_RENDERER_VERSION}`
  });
  assert.equal(MERMAID_RENDERER_VERSION, '12.2.0');
  assert.equal(hasMermaidSourceAuthority(mermaidSourceProperties()), true);
  assert.equal(hasMermaidSourceAuthority({ ...mermaidSourceProperties(), 'a3.diagram.authority': 'a3-model' }), false);
  assert.equal(hasMermaidSourceAuthority({ ...mermaidSourceProperties(), 'a3.diagram.renderer': 'mermaid@99.0.0' }), false);
  assert.equal(supportsMermaidSourceRenderer('a3.diagram.mermaid', '1.0.0', mermaidSourceProperties()), true);
  assert.equal(supportsMermaidSourceRenderer('a3.diagram.mermaid', '2.0.0', mermaidSourceProperties()), false);
});

test('E3-D1 passes the complete valid fixture to the renderer and returns SVG without changing source', async () => {
  const original = validSource;
  const result = await renderMermaidSource(validSource, 'a3-unit-fixture', async () => ({
    parse: (source) => { assert.equal(source, validSource); return { diagramType: 'flowchart-v2' }; },
    render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>' })
  }));
  assert.equal(result.state, 'rendered');
  assert.equal(result.diagramType, 'flowchart-v2');
  assert.match(result.svg, /<svg/);
  assert.equal(validSource, original);
});

test('E3-D1 reports a localized syntax diagnostic and retains the invalid full source', async () => {
  const original = invalidSource;
  const result = await renderMermaidSource(invalidSource, 'a3-invalid-fixture', async () => ({
    parse: (source) => mermaid.parse(source),
    render: async () => { throw new Error('render must not run after parse failure'); }
  }));
  assert.equal(result.state, 'invalid');
  assert.equal(result.line, 2);
  assert.match(result.message, /parse|expect|syntax/i);
  assert.equal(invalidSource, original);
});

test('E3-D1 presents a stable fallback when the pinned renderer cannot load', async () => {
  const result = await renderMermaidSource(validSource, 'a3-no-engine', async () => { throw new Error('chunk missing'); });
  assert.equal(result.state, 'unavailable');
  assert.match(result.message, /12\.2\.0/);
  assert.match(result.message, /original permanece intacta/i);
});
