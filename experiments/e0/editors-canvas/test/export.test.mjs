import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg } from '../src/export.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(root, '../fixtures/canvas.json'), 'utf8'));

test('the synthetic canvas fixture opens with two independent unconnected nodes', () => {
  assert.equal(fixture.nodes.length, 2);
  assert.equal(fixture.edges.length, 0);
  assert.equal(fixture.drawings.length, 0);
});

test('the exporter emits node text, edge and freehand geometry as SVG primitives', () => {
  const snapshot = {
    ...fixture,
    edges: [{ id: 'edge-1', source: 'entity-a', target: 'entity-b' }],
    drawings: [{
      id: 'drawing-1',
      color: '#e11d48',
      size: 8,
      points: [{ x: 320, y: 150, pressure: 0.5 }, { x: 345, y: 160, pressure: 0.6 }, { x: 375, y: 185, pressure: 0.5 }]
    }]
  };
  const svg = buildSvg(snapshot);
  assert.match(svg, /<text\b[^>]*>Entidad A<\/text>/);
  assert.match(svg, /<path data-kind="visual-edge"/);
  assert.match(svg, /<path data-kind="drawing"/);
  assert.match(svg, /<rect\b/);
  assert.doesNotMatch(svg, /<foreignObject\b|<image\b/);
});

test('SVG labels escape XML metacharacters', () => {
  const svg = buildSvg({ ...fixture, nodes: [{ ...fixture.nodes[0], data: { ...fixture.nodes[0].data, label: '<A3 & B3>' } }] });
  assert.match(svg, /&lt;A3 &amp; B3&gt;/);
});
