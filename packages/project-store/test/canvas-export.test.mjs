import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canvasPdfHtml, LocalProjectManager, planCanvasPdfPages, renderCanvasExportSvg, renderCanvasExportSvgAsync } from '../dist/index.js';
import { fixtureHost, scratch } from './fixture.mjs';

const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/canvas-export.json', import.meta.url)), 'utf8'));
const options = (overrides = {}) => ({ scope: 'diagram', selection: { placements: [], groups: [], drawings: [], edges: [] }, background: 'transparent', margin: 24, scale: 1, ...overrides });

test('A3-017: SVG fixture is deterministic, preserves dimensions, selection geometry and transparent background', () => {
  const first = renderCanvasExportSvg([fixture], options());
  const second = renderCanvasExportSvg([fixture], options());
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, new RegExp(`width="${first.width}" height="${first.height}" viewBox="`));
  assert.equal(first.svg.includes('class="export-background"'), false);
  assert.match(first.svg, /class="edge"/);
  assert.match(first.svg, /class="drawing"/);
  assert.match(first.svg, /class="node"/);
  assert.match(first.svg, /Idea &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first.svg, /<script/i);
  assert.doesNotMatch(first.svg, /react-flow|canvas-toolbar|selection-box/i);
});

test('A3-017: opaque/project backgrounds and rasterized image/poster diagnostics are explicit', () => {
  const opaque = renderCanvasExportSvg([fixture], options({ background: 'opaque' }));
  assert.match(opaque.svg, /class="export-background"[^>]*fill="#ffffff"/);
  const project = renderCanvasExportSvg([fixture], options({ background: 'project' }));
  assert.match(project.svg, /class="export-background"[^>]*fill="#ffffff"/);
  assert.match(project.svg, /<image href="data:image\/png;base64,/);
  assert.match(project.svg, /<metadata id="a3-export-report">.*Reference image.*<\/metadata>/);
  assert.ok(project.rasterized.some((item) => item.includes('Reference image')));
  assert.ok(project.diagnostics.some((item) => item.includes('poster')));
  assert.match(project.svg, /href="https:\/\/youtube\.com\/watch\?v=fixture"/);
});

test('selection and group scopes include only selected geometry and validate stale IDs', () => {
  const selection = renderCanvasExportSvg([fixture], options({ scope: 'selection', selection: {
    placements: ['00000000-0000-4000-8000-000000000301'], groups: [], drawings: [], edges: []
  } }));
  assert.match(selection.svg, /Idea &lt;script/);
  assert.doesNotMatch(selection.svg, /Reference video/);
  assert.ok(selection.diagnostics.some((item) => item.includes('conexión')));
  const group = renderCanvasExportSvg([fixture], options({ scope: 'group', groupId: '00000000-0000-4000-8000-000000000601' }));
  assert.match(group.svg, /Research/);
  assert.match(group.svg, /class="drawing"/);
  assert.throws(() => renderCanvasExportSvg([fixture], options({ scope: 'group', groupId: '00000000-0000-4000-8000-000000000999' })), /no existe/);
});

test('freehand paths retain pressure geometry and rough rendering remains deterministic', () => {
  const roughFixture = structuredClone(fixture);
  roughFixture.drawings[0].style = { 'a3.ui.stroke.rendering': 'rough', 'a3.ui.stroke.color': '#2563eb', 'a3.ui.stroke.roughness': 1.4 };
  const first = renderCanvasExportSvg([roughFixture], options()), second = renderCanvasExportSvg([roughFixture], options());
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, /class="drawing" d="M[-.\d]/);
  assert.match(first.svg, /fill="#2563eb"/);
});

test('workspace scope joins multiple saved workspaces and PDF plans A3/A4 fit and tiled output', () => {
  const other = structuredClone(fixture); other.workspaceId = '00000000-0000-4000-8000-000000000007'; other.name = 'Second workspace';
  const rendered = renderCanvasExportSvg([fixture, other], options({ scope: 'workspace' }));
  assert.match(rendered.svg, /Export fixture/);
  assert.match(rendered.svg, /Second workspace/);
  const bounds = { x: 0, y: 0, width: 6000, height: 4000 };
  const a3 = planCanvasPdfPages(bounds, { paper: 'A3', orientation: 'landscape', marginMm: 10, fit: 'page', scale: 1 });
  const a4 = planCanvasPdfPages(bounds, { paper: 'A4', orientation: 'portrait', marginMm: 10, fit: 'page', scale: 1 });
  assert.equal(a3.length, 1); assert.deepEqual(a3[0].bounds, bounds);
  assert.equal(a4.length, 1);
  const tiles = planCanvasPdfPages(bounds, { paper: 'A4', orientation: 'landscape', marginMm: 10, fit: 'tiles', scale: 1 });
  assert.ok(tiles.length > 1); assert.ok(tiles.length <= 100);
  const html = canvasPdfHtml(rendered.svg, tiles, { paper: 'A4', orientation: 'landscape', marginMm: 10, fit: 'tiles', scale: 1 });
  assert.equal((html.match(/class="page"/g) ?? []).length, tiles.length);
  assert.match(html, /@page\{size:A4 landscape;margin:0\}/);
  assert.match(html, /Content-Security-Policy/);
});

test('workspace export yields between persisted workspaces and observes cancellation', async () => {
  const other = structuredClone(fixture); other.workspaceId = '00000000-0000-4000-8000-000000000007'; other.name = 'Second workspace';
  const abort = new AbortController();
  const pending = renderCanvasExportSvgAsync([fixture, other], options({ scope: 'workspace' }), abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const complete = await renderCanvasExportSvgAsync([fixture, other], options({ scope: 'workspace' }));
  assert.match(complete.svg, /Second workspace/);
});

test('the project manager reads export snapshots through the broker and denies export after profile revocation', async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'canvas-export-host');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active, workspaceId = active.workspaces[0].id;
  const snapshots = await manager.loadCanvasExportWorkspaces(active.sessionId, workspaceId, 'diagram');
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].workspaceId, workspaceId);
  await host.capabilities.setProfile({ root, projectId: active.projectId, profile: 'consultar' });
  await assert.rejects(manager.loadCanvasExportWorkspaces(active.sessionId, workspaceId, 'diagram'), { code: 'PERMISSION_DENIED' });
});
