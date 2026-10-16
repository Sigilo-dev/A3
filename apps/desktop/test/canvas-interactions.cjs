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

  console.log('CANVAS_PHASE=freehand-mouse');
  const beforeDrawings = await canvas();
  await click('[data-canvas-tool="draw"]'); await waitFor("document.querySelector('.canvas-host')?.dataset.canvasMode === 'draw'");
  const area = await rect('.canvas-host'), from = { x: area.left + 65, y: area.top + 80 }, to = { x: area.left + 190, y: area.top + 150 };
  win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 }); await frame();
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: Math.round(from.x + (to.x - from.x) * i / 6), y: Math.round(from.y + (to.y - from.y) * i / 6) });
    await frame();
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Trazo guardado'");
  let drawn = await canvas(), mouseStroke = drawn.drawings.find((item) => !beforeDrawings.drawings.some((old) => old.id === item.id));
  assert.ok(mouseStroke); assert.ok(mouseStroke.points.length >= 2, 'mouse input is retained as editable world points');
  assert.equal(mouseStroke.parameters.simulatePressure, true, 'mouse input has no hardware pressure channel');
  assert.ok(mouseStroke.points.every((point) => !('pressure' in point)), 'mouse geometry does not invent pressure samples');
  const mousePath = join(root, '.a3/workspaces', drawn.workspaceId, 'drawings', mouseStroke.id + '.json');
  const savedMouse = JSON.parse(await readFile(mousePath, 'utf8'));
  assert.deepEqual(savedMouse.points, mouseStroke.points); assert.deepEqual(savedMouse.parameters, mouseStroke.parameters);
  await choose('[data-drawing-rendering]', 'rough');
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Parámetros del trazo guardados'");
  drawn = await canvas(); mouseStroke = drawn.drawings.find((item) => item.id === mouseStroke.id);
  assert.equal(mouseStroke.style['a3.ui.stroke.rendering'], 'rough');
  assert.ok(await js(`document.querySelector('.canvas-drawing-path[data-drawing-id="${mouseStroke.id}"]')?.querySelectorAll('path').length > 1`), 'Rough.js derives sketch paths from the editable freehand outline');
  await click('[data-canvas-zoom-in]'); await waitFor("Number(document.querySelector('[data-canvas-ready]').dataset.viewportZoom) > 1");
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Vista guardada'");
  assert.deepEqual((await canvas()).drawings.find((item) => item.id === mouseStroke.id).points, savedMouse.points, 'zoom leaves source geometry in world coordinates');

  console.log('CANVAS_PHASE=freehand-pressure-and-reopen');
  const penBefore = await canvas();
  const penResult = await js(`(() => {
    const host = document.querySelector('.canvas-host'), r = host.getBoundingClientRect();
    const send = (type, x, y, pressure, buttons) => host.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 77, pointerType: 'pen', isPrimary: true, button: type === 'pointerdown' ? 0 : -1, buttons, pressure, clientX: x, clientY: y }));
    send('pointerdown', r.left + 230, r.top + 100, 0.22, 1); send('pointermove', r.left + 250, r.top + 115, 0.84, 1); send('pointermove', r.left + 275, r.top + 145, 0.63, 1); send('pointerup', r.left + 280, r.top + 150, 0, 0); return true;
  })()`);
  assert.equal(penResult, true);
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Trazo guardado'");
  drawn = await canvas(); const penStroke = drawn.drawings.find((item) => !penBefore.drawings.some((old) => old.id === item.id)); assert.ok(penStroke);
  assert.equal(penStroke.parameters.simulatePressure, false, 'pressure-capable pointer uses recorded pressure');
  assert.ok(penStroke.points.some((point) => Math.abs(point.pressure - 0.22) < 0.001), 'PointerEvent pressure keeps the low sample within float precision');
  assert.ok(penStroke.points.some((point) => Math.abs(point.pressure - 0.84) < 0.001), 'PointerEvent pressure keeps the high sample within float precision');
  assert.ok(penStroke.points.every((point) => typeof point.x === 'number' && typeof point.y === 'number'));
  await click('[data-canvas-tool="select"]'); await waitFor(`document.querySelector('.canvas-drawing-path[data-drawing-id="${penStroke.id}"]')`);
  await click('[data-section="files"]'); await click('[data-section="canvas"]');
  await waitFor(`document.querySelector('.canvas-drawing-path[data-drawing-id="${penStroke.id}"]')`);
  assert.equal(await js(`document.querySelector('.canvas-drawing-path[data-drawing-id="${mouseStroke.id}"]')?.dataset.drawingRendering`), 'rough');
  assert.ok(await js(`document.querySelector('.canvas-drawing-path[data-drawing-id="${mouseStroke.id}"]')?.querySelectorAll('path').length > 1`), 'reopen keeps the rough presentation mode');
  assert.deepEqual((await canvas()).drawings.find((item) => item.id === penStroke.id), penStroke, 'workspace reopen preserves pressure, points and parameters');
  await js(`(() => { const stroke = document.querySelector('.canvas-drawing-path[data-drawing-id="${penStroke.id}"]'); stroke.focus(); stroke.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`document.querySelector('.canvas-drawing-path[data-drawing-id="${penStroke.id}"]')?.getAttribute('aria-pressed') === 'true'`);
  if (await js("Boolean(document.querySelector('[data-canvas-request-drawing-delete]'))")) {
    await click('[data-canvas-request-drawing-delete]'); await waitFor("document.querySelector('[data-canvas-delete-drawings]')?.disabled === false");
  }
  await waitFor("document.querySelector('[data-canvas-delete-drawings]')?.disabled === false");
  await click('[data-canvas-delete-drawings]'); await waitFor(`!document.querySelector('.canvas-drawing-path[data-drawing-id="${penStroke.id}"]')`);
  await assert.rejects(readFile(join(root, '.a3/workspaces', drawn.workspaceId, 'drawings', penStroke.id + '.json')), { code: 'ENOENT' });
  await js(`(() => { const stroke = document.querySelector('.canvas-drawing-path[data-drawing-id="${mouseStroke.id}"]'); stroke.focus(); stroke.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`document.querySelector('.canvas-drawing-path[data-drawing-id="${mouseStroke.id}"]')?.getAttribute('aria-pressed') === 'true'`);
  await click('[data-canvas-convert-drawing]');
  await waitFor("document.querySelector('[data-canvas-node-count]')?.textContent.startsWith('4 representaciones')");
  const converted = await canvas(), drawingPlacement = converted.placements.find((item) => !drawn.placements.some((old) => old.id === item.id));
  assert.ok(drawingPlacement); const drawingEntity = converted.entities.find((item) => item.id === drawingPlacement.entityId);
  assert.equal(drawingEntity.type, 'a3.core.drawing');
  await waitFor(`document.querySelector('.canvas-entity-node[data-entity-id="${drawingEntity.id}"]')?.textContent.includes('a3.core.drawing')`);
  const vectorAssetPath = join(root, 'assets/drawings', drawingEntity.contentResourceId + '.json');
  const vectorAssetBytes = await readFile(vectorAssetPath), vectorAsset = JSON.parse(vectorAssetBytes.toString('utf8'));
  assert.deepEqual(vectorAsset.strokes[0].points, savedMouse.points, 'conversion preserves source points and pressure parameters');
  assert.equal(vectorAsset.strokes[0].style['a3.ui.stroke.rendering'], 'rough', 'conversion retains the editable clean/rough presentation choice');
  await assert.rejects(readFile(join(root, '.a3/workspaces', drawn.workspaceId, 'drawings', mouseStroke.id + '.json')), { code: 'ENOENT' });
  await click('[data-section="files"]'); await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  const reopenedDrawings = await canvas();
  assert.equal(reopenedDrawings.drawings.length, 0, 'converted/deleted annotations stay removed after reopen');
  assert.ok(reopenedDrawings.placements.some((item) => item.id === drawingPlacement.id));
  for (const [name, bytes] of technical) assert.deepEqual(await readFile(join(root, '.a3/relations', name)), bytes);
  assert.deepEqual(await readFile(entityPath), entityBefore);
};
