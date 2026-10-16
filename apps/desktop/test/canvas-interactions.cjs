const assert = require('node:assert/strict');
const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function canvasInteractions({ win, js, click, input, waitFor, root, createdPlacement }) {
  const P1 = '00000000-0000-4000-8000-000000000008', P2 = '00000000-0000-4000-8000-000000000010';
  const canvas = () => js("(async () => { const p = (await window.a3.projects({ action: 'list' })).value.active; return (await window.a3.canvas({ action: 'load', sessionId: p.sessionId, workspaceId: p.workspaces[0].id })).value; })()");
  const before = await canvas();
  const technical = await Promise.all((await readdir(join(root, '.a3/relations'))).sort().map(async (name) => [name, await readFile(join(root, '.a3/relations', name))]));
  const entityPath = join(root, '.a3/entities/00000000-0000-4000-8000-000000000002.json'), entityBefore = await readFile(entityPath);
  const frame = () => js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const key = (key, extra = {}) => js(`(() => { const host = document.querySelector('.canvas-host'); host.focus(); host.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, ...${JSON.stringify(extra)} })); })()`);
  const rect = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; })()`);
  const drag = async (from, to) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 }); await frame();
    for (let i = 1; i <= 5; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: Math.round(from.x + (to.x - from.x) * i / 5), y: Math.round(from.y + (to.y - from.y) * i / 5) }); await frame(); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 }); await frame();
    // Hidden Electron windows do not reliably deliver the captured pointer release to the pane.
    // Complete the pointer gesture at the DOM boundary; mouse dragging still uses native events.
    await js(`document.querySelector('.react-flow__pane').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: ${to.x}, clientY: ${to.y} })); undefined`);
    await frame();
  };
  const choose = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const selectNode = (id) => js(`(() => { const node = document.querySelector('.react-flow__node[data-id="${id}"]'); node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  console.log('CANVAS_PHASE=selection');
  await key('Escape');
  const pane = await rect('.canvas-host');
  await drag({ x: pane.left + 5, y: pane.top + 5 }, { x: pane.right - 6, y: pane.bottom - 6 });
  await waitFor("document.querySelectorAll('.react-flow__node.selected').length >= 2");
  const selected = await js("[...document.querySelectorAll('.react-flow__node.selected')].map((node) => node.dataset.id)");
  assert.deepEqual(await readFile(entityPath), entityBefore, 'selection alone does not mutate the shared entity');
  const header = await rect(`.react-flow__node[data-id="${P1}"] .canvas-entity-header`);
  await drag(header, { x: header.x + 25, y: header.y + 15 });
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Organización guardada'");
  const moved = await canvas();
  for (const placementId of selected) assert.notDeepEqual(moved.placements.find((item) => item.id === placementId).position, before.placements.find((item) => item.id === placementId).position);
  assert.deepEqual(await readFile(entityPath), entityBefore);

  console.log('CANVAS_PHASE=lock-and-keyboard'); await key('Escape');
  await selectNode(P1);
  await waitFor("Boolean(document.querySelector('[data-canvas-lock]'))");
  await click('[data-canvas-lock]'); await waitFor("document.querySelector('[data-canvas-lock]')?.getAttribute('aria-pressed') === 'true'");
  const locked = (await canvas()).placements.find((item) => item.id === P1);
  const lockedHeader = await rect(`.react-flow__node[data-id="${P1}"] .canvas-entity-header`);
  await drag(lockedHeader, { x: lockedHeader.x + 25, y: lockedHeader.y + 15 });
  await selectNode(P1); await waitFor("document.querySelector('[data-canvas-lock]')?.getAttribute('aria-pressed') === 'true'");
  await key('ArrowRight');
  assert.deepEqual((await canvas()).placements.find((item) => item.id === P1).position, locked.position);
  await click('[data-canvas-lock]'); await waitFor("document.querySelector('[data-canvas-lock]')?.getAttribute('aria-pressed') === 'false'");
  const unlocked = (await canvas()).placements.find((item) => item.id === P1);
  await key('ArrowRight');
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Organización guardada'");
  assert.equal((await canvas()).placements.find((item) => item.id === P1).position.x, unlocked.position.x + 1);

  console.log('CANVAS_PHASE=connect-and-reconnect'); await key('Escape'); await click('[data-canvas-tool="connect"]');
  await choose('[data-edge-source]', P1); await choose('[data-edge-target]', createdPlacement.id); await click('[data-edge-save]');
  await waitFor("document.querySelectorAll('.react-flow__edge').length === 2 && Boolean(document.querySelector('[data-edge-label]'))");
  const connected = await canvas(), edge = connected.visualEdges.find((edge) => !before.visualEdges.some((old) => old.id === edge.id)); assert.ok(edge);
  await click('[data-canvas-tool="text"]'); await waitFor("document.activeElement?.matches('[data-edge-label]')");
  await input('[data-edge-label]', 'Referencia visual smoke');
  await choose('[name="direction"]', 'both'); await choose('[name="route"]', 'orthogonal'); await choose('[name="pattern"]', 'dashed');
  await choose('[data-edge-source]', P2); await choose('[data-edge-target]', P1); await click('[data-edge-save]');
  await waitFor("document.querySelector('.react-flow__edge.selected')?.textContent.includes('Referencia visual smoke')");
  const edited = (await canvas()).visualEdges.find((item) => item.id === edge.id);
  assert.equal(edited.sourcePlacementId, P2); assert.equal(edited.targetPlacementId, P1); assert.equal(edited.style['a3.ui.line.direction'], 'both');
  console.log('CANVAS_PHASE=reopen'); await click('[data-section="files"]'); await click('[data-section="canvas"]'); await waitFor("document.querySelectorAll('.react-flow__edge').length === 2");
  assert.deepEqual((await canvas()).visualEdges.find((item) => item.id === edge.id), edited);
  await js(`(() => { const edge = document.querySelector('.react-flow__edge[data-id="${edge.id}"]'); edge.focus(); edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor("Boolean(document.querySelector('[data-edge-delete]'))");
  assert.equal(await js("document.querySelector('[data-edge-delete]').disabled"), true);
  console.log('CANVAS_PHASE=delete'); await click('[data-edge-request-delete]'); await waitFor("document.querySelector('[data-edge-delete]')?.disabled === false");
  await click('[data-edge-delete]'); await waitFor("document.querySelectorAll('.react-flow__edge').length === 1");
  await assert.rejects(readFile(join(root, '.a3/workspaces', before.workspaceId, 'visual-edges', edge.id + '.json')), { code: 'ENOENT' });
  assert.equal((await canvas()).visualEdges.some((item) => item.id === edge.id), false);
  const preservedEdge = before.visualEdges[0];
  await js(`(() => { const edge = document.querySelector('.react-flow__edge[data-id="${preservedEdge.id}"]'); edge.focus(); edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor("Boolean(document.querySelector('[data-edge-label]'))"); await click('[data-canvas-tool="text"]');
  await input('[data-edge-label]', 'Estilo desconocido conservado'); await click('[data-edge-save]');
  await waitFor("document.querySelector('.react-flow__edge.selected')?.textContent.includes('Estilo desconocido conservado')");
  assert.deepEqual((await canvas()).visualEdges.find((item) => item.id === preservedEdge.id).style, preservedEdge.style, 'editing a label preserves unknown style values');
  for (const [name, bytes] of technical) assert.deepEqual(await readFile(join(root, '.a3/relations', name)), bytes);
  assert.deepEqual(await readFile(entityPath), entityBefore);
};
