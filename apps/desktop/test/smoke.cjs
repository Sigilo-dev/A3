const assert = require('node:assert/strict');
const { mkdir, writeFile, readFile, rename, lstat, cp } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const [mode, entry, profile, screenshot] = process.argv.slice(2);
const expectedURL = new URL(process.env.ELECTRON_RENDERER_URL || 'a3://desktop/index.html').href;
const development = expectedURL.startsWith('http:');
app.setPath('userData', profile);
// Hide test windows without introducing test switches or IPC into the product.
BrowserWindow.prototype.show = function () {};
let startupDialog;
const folders = [];
dialog.showOpenDialog = async () => folders.length ? { canceled: false, filePaths: [folders.shift()] } : { canceled: true, filePaths: [] };
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showErrorBox = (title, message) => {
  startupDialog = { title, message };
  if (mode !== 'healthy') {
    console.log('A3_SMOKE=' + JSON.stringify({ mode, passed: title.includes('A3') && message.includes('npm run build'), startupDialog }));
  }
};

const created = new Promise((resolve) => app.once('browser-window-created', (_event, window) => resolve(window)));

async function healthy() {
  const win = await created;
  win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_event, code) => reject(new Error(`Renderer load ${code}`)));
  });
  const probe = await win.webContents.executeJavaScript(`(async () => {
    const result = await window.a3.getAppInfo();
    return { result, bridge: Object.keys(window.a3), process: typeof process,
      require: typeof require, ipcRenderer: typeof ipcRenderer, url: location.href };
  })()`);
  assert.equal(probe.result.ok, true);
  assert.equal(probe.result.value.name, 'A3');
  assert.equal(probe.result.value.electron, '44.7.2');
  assert.equal(probe.process, 'undefined');
  assert.equal(probe.require, 'undefined');
  assert.equal(probe.ipcRenderer, 'undefined');
  assert.deepEqual(probe.bridge, ['getAppInfo', 'projects', 'files', 'canvas']);
  assert.equal(probe.url, expectedURL);
  const preferences = win.webContents.getLastWebPreferences();
  for (const [name, value] of Object.entries({ nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true })) {
    assert.equal(preferences[name], value, name);
  }

  const navigation = await win.webContents.executeJavaScript(`(async () => {
    await new Promise(requestAnimationFrame);
    document.querySelector('[data-section="files"]').click();
    await new Promise(requestAnimationFrame);
    const title = document.querySelector('h1').textContent;
    const active = document.querySelector('[aria-current="page"]').dataset.section;
    document.querySelector('footer button').click();
    await new Promise(requestAnimationFrame);
    const panel = Boolean(document.querySelector('#activity'));
    const script = document.createElement('script');
    script.textContent = 'window.inlineScriptRan = true';
    document.body.append(script);
    return { title, active, panel, cspBlocked: !window.inlineScriptRan,
      popupDenied: window.open('https://example.com') === null };
  })()`);
  assert.equal(navigation.title, 'Archivos.');
  assert.equal(navigation.active, 'files');
  assert.equal(navigation.panel, true);
  assert.equal(navigation.cspBlocked, !development);
  assert.equal(navigation.popupDenied, true);
  const networkRequests = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    if (development && new URL(request.url).origin === new URL(expectedURL).origin) callback({});
    else { networkRequests.push(request.url); callback({ cancel: true }); }
  });

  // Real UI -> preload -> sender-checked main -> broker -> store, without network.
  const projectParent = join(profile, 'project-fixtures');
  await mkdir(projectParent, { recursive: true });
  const existing = join(projectParent, 'Existing'); await mkdir(existing);
  const original = Buffer.from([0xff, 0, 13, 10, 42]); await writeFile(join(existing, 'original.bin'), original);
  const js = (source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`Renderer check failed: ${source.slice(0, 260)}`, { cause: error }); });
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await js(condition)) return;
      const failure = await js("document.querySelector('[data-project-error]')?.textContent");
      const fileFailure = await js("document.querySelector('[data-file-error]')?.textContent");
      const canvasFailure = await js("document.querySelector('[data-canvas-error]')?.textContent");
      if (failure || fileFailure || canvasFailure) throw new Error(failure || fileFailure || canvasFailure);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('UI timed out: ' + condition);
  };
  const input = (selector, value) => js(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('[data-section="projects"]');
  await waitFor("Boolean(document.querySelector('#project-name'))");
  await input('#project-name', 'Offline'); folders.push(projectParent);
  await click('[data-create-project]'); await waitFor("Boolean(document.querySelector('[data-project-preview]'))");
  await click('[data-confirm-project]'); await waitFor("document.querySelector('[data-active-project] h2')?.textContent === 'Offline'");
  const firstSession = (await js("window.a3.projects({ action: 'list' })")).value.active.sessionId;
  await input('#rename-project', 'Renamed offline');
  // Closing drains the host draft through the writer before releasing the session.
  await click('[data-close-project]'); await waitFor("!document.querySelector('[data-active-project]')");
  const createdRoot = join(projectParent, 'Offline');
  assert.equal(JSON.parse(await readFile(join(createdRoot, 'a3.project.json'), 'utf8')).name, 'Renamed offline');
  await click('[data-open-recent]'); await waitFor("document.querySelector('[data-active-project] h2')?.textContent === 'Renamed offline'");
  await click('[data-close-project]'); await waitFor("!document.querySelector('[data-active-project]')");
  const moved = join(projectParent, 'Moved'); await rename(createdRoot, moved); folders.push(moved);
  await click('[data-relocate-project]'); await waitFor("document.querySelector('[data-active-project] .path')?.textContent.endsWith('Moved')");
  await assert.rejects(lstat(createdRoot), { code: 'ENOENT' });
  const stale = await js(`window.a3.projects({ action: 'rename', sessionId: ${JSON.stringify(firstSession)}, name: 'stale' })`);
  assert.equal(stale.error.code, 'STALE_SESSION');
  await click('[data-close-project]'); await waitFor("!document.querySelector('[data-active-project]')");
  folders.push(existing); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-project-preview]'))");
  await click('[data-cancel-project]'); await waitFor("!document.querySelector('[data-project-preview]')");
  await assert.rejects(lstat(join(existing, '.a3')), { code: 'ENOENT' });
  folders.push(existing); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-project-preview]'))");
  await click('[data-confirm-project]'); await waitFor("document.querySelector('[data-active-project] h2')?.textContent === 'Existing'");
  assert.deepEqual(await readFile(join(existing, 'original.bin')), original);
  assert.ok(await js("document.querySelector('.workspace-list')?.textContent.includes('Principal')"));
  const invalid = await js("window.a3.projects({ action: 'open', root: 'C:/unexpected' })");
  assert.equal(invalid.error.code, 'INVALID_REQUEST');
  assert.equal((await js("window.a3.projects({ action: 'constructor', name: 'x' })")).error.code, 'INVALID_REQUEST');

  await click('[data-section="files"]'); await waitFor("Boolean(document.querySelector('[role=tree][aria-label=\"Archivos del proyecto\"]'))");
  await waitFor("document.querySelector('.files-panel')?.getAttribute('aria-busy') === 'false'");
  await input('#new-file-name', 'keyboard-note.md'); await waitFor("document.querySelector('[data-create-file]') && !document.querySelector('[data-create-file]').disabled"); await click('[data-create-file]');
  await waitFor("Boolean([...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('keyboard-note.md'))?.dataset.resourceId)");
  const resourceId = await js("[...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('keyboard-note.md')).dataset.resourceId");
  await js("window.prompt = () => 'renamed-note.md'; undefined");
  const noteRow = "[...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('keyboard-note.md'))";
  await js(`(() => { const row = ${noteRow}; row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); })()`);
  await waitFor("Boolean([...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('renamed-note.md')))");
  assert.equal(await js("[...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('renamed-note.md')).dataset.resourceId"), resourceId);
  const renamedPath = join(existing, 'renamed-note.md');
  assert.deepEqual(await readFile(renamedPath), Buffer.alloc(0));
  await js("(() => { const rows = [...document.querySelectorAll('[data-file-entry]')]; const row = rows.find((item) => item.textContent.includes('renamed-note.md')); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
  await waitFor("Boolean(document.querySelector('.file-preview'))");
  await click('[data-cancel-file-preview]');
  await waitFor("!document.querySelector('.file-preview')");
  await js("(() => { const rows = [...document.querySelectorAll('[data-file-entry]')]; rows[0].focus(); rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()");
  assert.equal(await js("document.activeElement?.matches('[data-file-entry]')"), true);
  assert.equal(await js("document.activeElement?.dataset.fileItemId !== [...document.querySelectorAll('[data-file-entry]')][0]?.dataset.fileItemId"), true);
  await js("(() => { const row = [...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('renamed-note.md')); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true })); })()");
  await waitFor("Boolean([...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('renamed-note.md copia')))");
  const copyPath = join(existing, 'renamed-note.md copia');
  assert.deepEqual(await readFile(copyPath), Buffer.alloc(0));
  await js("(() => { const row = [...document.querySelectorAll('[data-file-entry]')].find((item) => item.textContent.includes('renamed-note.md')); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()");
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))");
  await click('[data-cancel-file-delete]'); await waitFor("!document.querySelector('[role=alertdialog]')");
  assert.deepEqual(await readFile(renamedPath), Buffer.alloc(0), 'cancel leaves file bytes unchanged');

  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  const readViewport = () => js("(() => { const { viewportX: x, viewportY: y, viewportZoom: zoom } = document.querySelector('[data-canvas-ready]').dataset; return { x: Number(x), y: Number(y), zoom: Number(zoom) }; })()");
  assert.deepEqual(await readViewport(), { x: 0, y: 0, zoom: 1 });
  assert.equal(await js("document.querySelector('[data-canvas-fit]').disabled"), true);
  await click('[data-canvas-fixture]'); await click('[data-canvas-fit]');
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Vista guardada'");
  const fitted = await readViewport();
  const paneRect = await js("(() => { const r = document.querySelector('.canvas-host').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: r.left, top: r.top, width: r.width, height: r.height }; })()");
  const cursor = { x: paneRect.x - paneRect.left, y: paneRect.y - paneRect.top };
  const worldUnderCursor = { x: (cursor.x - fitted.x) / fitted.zoom, y: (cursor.y - fitted.y) / fitted.zoom };
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: paneRect.x, y: paneRect.y, deltaX: 0, deltaY: -30, modifiers: ['control'], canScroll: true });
  await waitFor(`Number(document.querySelector('[data-canvas-ready]').dataset.viewportZoom) !== ${fitted.zoom}`);
  const zoomed = await readViewport();
  assert.ok(Math.abs((cursor.x - zoomed.x) / zoomed.zoom - worldUnderCursor.x) < 0.01);
  assert.ok(Math.abs((cursor.y - zoomed.y) / zoomed.zoom - worldUnderCursor.y) < 0.01);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: paneRect.x, y: paneRect.y, deltaX: 25, deltaY: -18, canScroll: true });
  await waitFor(`Number(document.querySelector('[data-canvas-ready]').dataset.viewportX) !== ${zoomed.x}`);
  const scrolled = await readViewport(); assert.equal(scrolled.zoom, zoomed.zoom);
  // A native drag uses React Flow; wheel/pinch are normalized in the A3 visual adapter.
  win.webContents.sendInputEvent({ type: 'mouseDown', x: paneRect.x, y: paneRect.y, button: 'middle', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: paneRect.x + 35, y: paneRect.y + 21, movementX: 35, movementY: 21 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: paneRect.x + 35, y: paneRect.y + 21, button: 'middle', clickCount: 1 });
  await waitFor(`Number(document.querySelector('[data-canvas-ready]').dataset.viewportX) !== ${scrolled.x}`);
  await waitFor("document.querySelector('[data-canvas-status]')?.textContent === 'Vista guardada'");
  const beforeResize = await readViewport(); const [width, height] = win.getSize(); win.setSize(width + 130, height + 80);
  await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepEqual(await readViewport(), beforeResize, 'resize must not fit or alter the camera');
  const matrix = await js("new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).toString()"); assert.ok(matrix.startsWith('matrix('));
  await click('[data-section="files"]'); await click('[data-section="canvas"]');
  await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  assert.deepEqual(await readViewport(), beforeResize, 'reopening workspace preserves exact camera values');
  assert.equal(await js("document.querySelectorAll('.react-flow__node, .react-flow__edge').length"), 0);
  const canvasState = await js("window.a3.projects({ action: 'list' })");
  const canvasActive = canvasState.value.active; const canvasWorkspaceId = canvasActive.workspaces[0].id;
  const malformedCanvas = await js(`window.a3.canvas({ action: 'stage', sessionId: '${canvasActive.sessionId}', workspaceId: '${canvasWorkspaceId}', expectedRevision: 1, viewport: { x: null, y: 0, zoom: 1 } })`);
  assert.equal(malformedCanvas.error.code, 'INVALID_REQUEST');
  const savedWorkspace = JSON.parse(await readFile(join(existing, '.a3', 'workspaces', canvasWorkspaceId, 'workspace.json'), 'utf8'));
  assert.deepEqual(savedWorkspace.viewport, beforeResize);
  const extensive = { x: -1e12 + 0.125, y: 1e12 - 0.25, zoom: 0.73 };
  const canvasBase = await js(`window.a3.canvas({ action: 'load', sessionId: '${canvasActive.sessionId}', workspaceId: '${canvasWorkspaceId}' })`);
  assert.equal((await js(`window.a3.canvas({ action: 'stage', sessionId: '${canvasActive.sessionId}', workspaceId: '${canvasWorkspaceId}', expectedRevision: ${canvasBase.value.revision}, viewport: ${JSON.stringify(extensive)} })`)).ok, true);
  assert.equal((await js(`window.a3.canvas({ action: 'flush', sessionId: '${canvasActive.sessionId}', workspaceId: '${canvasWorkspaceId}' })`)).ok, true);
  await click('[data-section="files"]'); await click('[data-section="canvas"]');
  await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  assert.deepEqual(await readViewport(), extensive);
  const localTransform = await js("(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform); return { x: m.e, y: m.f, zoom: m.a }; })()");
  assert.ok(Math.abs(localTransform.x) < 1 && Math.abs(localTransform.y) < 1, 'extensive camera must use a nearby visual origin');
  assert.equal(localTransform.zoom, extensive.zoom);
  const gridTransform = await js("document.querySelector('.react-flow__background pattern').getAttribute('patternTransform')");
  assert.equal(gridTransform.includes('--'), false, 'grid offset must remain a valid SVG transform after origin rebasing');
  await click('[data-section="files"]'); await click('[data-section="canvas"]');
  await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  assert.deepEqual(await readViewport(), extensive);

  // Open an isolated E0 fixture to exercise real persisted placements and fallback cards.
  await click('[data-section="projects"]'); await click('[data-close-project]'); await waitFor("!document.querySelector('[data-active-project]')");
  const canvasFixture = join(projectParent, 'Canvas fixture');
  await cp(join(__dirname, '../../../fixtures/e0/project'), canvasFixture, { recursive: true });
  const fixtureEntityPath = join(canvasFixture, '.a3', 'entities', '00000000-0000-4000-8000-000000000003.json');
  const fixtureEntity = JSON.parse(await readFile(fixtureEntityPath, 'utf8'));
  fixtureEntity.properties['demo.smoke'] = 'Fallback property'; fixtureEntity.ports = [{ id: 'smoke-port', label: 'Puerto visible' }];
  fixtureEntity.contentResourceId = '00000000-0000-4000-8000-000000000004';
  await writeFile(fixtureEntityPath, JSON.stringify(fixtureEntity, null, 2) + '\n');
  const fixtureEdgePath = join(canvasFixture, '.a3/workspaces/00000000-0000-4000-8000-000000000006/visual-edges/00000000-0000-4000-8000-000000000011.json');
  const fixtureEdge = JSON.parse(await readFile(fixtureEdgePath, 'utf8'));
  fixtureEdge.style['a3.ui.line.route'] = 'future-route'; fixtureEdge.style['future.keep'] = { opaque: true };
  await writeFile(fixtureEdgePath, JSON.stringify(fixtureEdge, null, 2) + '\n');
  folders.push(canvasFixture); await click('[data-open-project]');
  await waitFor("document.querySelector('[data-active-project] h2')?.textContent === 'Ejemplo E0-A'");
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-node-count]')?.textContent.startsWith('2 representaciones')");
  assert.equal(await js("document.querySelectorAll('.react-flow__node').length"), 2);
  assert.equal(await js("document.querySelectorAll('[data-node-fallback=\"true\"]').length"), 1);
  await waitFor("(() => { const n = document.querySelector('[data-entity-id=\"00000000-0000-4000-8000-000000000003\"]'); return n?.textContent.includes('demo.smoke') && n.textContent.includes('Puerto visible') && n.textContent.includes('Visión del fixture'); })()");
  const fallbackCard = await js("document.querySelector('[data-entity-id=\"00000000-0000-4000-8000-000000000003\"]')?.textContent");
  assert.ok(fallbackCard.includes('demo.smoke') && fallbackCard.includes('Puerto visible') && fallbackCard.includes('Visión del fixture'));
  await click('[data-canvas-create-placement]');
  await waitFor("document.querySelector('[data-canvas-node-count]')?.textContent.startsWith('3 representaciones')");
  const placementState = await js("(async () => { const p = (await window.a3.projects({ action: 'list' })).value.active; const w = p.workspaces[0].id; return { p, w, canvas: (await window.a3.canvas({ action: 'load', sessionId: p.sessionId, workspaceId: w })).value }; })()");
  const fixturePlacementIds = ['00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000010'];
  const createdPlacement = placementState.canvas.placements.find((item) => !fixturePlacementIds.includes(item.id));
  assert.ok(createdPlacement); assert.equal(createdPlacement.entityId, '00000000-0000-4000-8000-000000000002');
  await js(`document.querySelector('.react-flow__node[data-id="${createdPlacement.id}"]').click(); undefined`);
  await waitFor(`Boolean(document.querySelector('.react-flow__node[data-id="${createdPlacement.id}"] .react-flow__resize-control.bottom.right.handle'))`);
  const resizedCanvas = await js(`window.a3.canvas({ action: 'update-placement', sessionId: '${placementState.p.sessionId}', workspaceId: '${placementState.w}', placementId: '${createdPlacement.id}', expectedRevision: ${createdPlacement.revision}, patch: { size: { width: 440, height: 270 } } })`);
  assert.equal(resizedCanvas.ok, true);
  const resizedPlacement = resizedCanvas.value.placements.find((item) => item.id === createdPlacement.id);
  assert.deepEqual(resizedPlacement.size, { width: 440, height: 270 });
  await click('[data-section="files"]'); await click('[data-section="canvas"]');
  await waitFor("document.querySelector('[data-canvas-node-count]')?.textContent.startsWith('3 representaciones')");
  const reopenedNodeSize = await js(`(() => { const n = document.querySelector('.react-flow__node[data-id="${createdPlacement.id}"]'); return { width: Number.parseFloat(n.style.width), height: Number.parseFloat(n.style.height) }; })()`);
  assert.deepEqual(reopenedNodeSize, resizedPlacement.size);
  await waitFor("document.querySelectorAll('.react-flow__edge').length === 1");
  await require('./canvas-interactions.cjs')({ win, js, click, input, waitFor, root: canvasFixture, createdPlacement }).catch(async (error) => {
    await mkdir(dirname(screenshot), { recursive: true }); await writeFile(screenshot, (await win.webContents.capturePage()).toPNG()); throw error;
  });
  const fixtureSession = (await js("window.a3.projects({ action: 'list' })")).value.active;
  const fixtureWorkspaceId = fixtureSession.workspaces[0].id;

  const extra = new BrowserWindow({ show: false, webPreferences: {
    session: win.webContents.session, preload: join(dirname(entry), '../preload/index.cjs'),
    contextIsolation: true, sandbox: true, nodeIntegration: false
  } });
  await extra.loadURL(expectedURL);
  const denied = await extra.webContents.executeJavaScript('window.a3.getAppInfo()');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  const deniedProject = await extra.webContents.executeJavaScript("window.a3.projects({ action: 'list' })");
  assert.equal(deniedProject.error.code, 'PERMISSION_DENIED');
  const deniedCanvas = await extra.webContents.executeJavaScript(`window.a3.canvas({ action: 'load', sessionId: '${fixtureSession.sessionId}', workspaceId: '${fixtureWorkspaceId}' })`);
  assert.equal(deniedCanvas.error.code, 'PERMISSION_DENIED');
  extra.destroy();

  await win.webContents.executeJavaScript("location.href = 'https://example.com'; undefined");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(win.webContents.getURL(), expectedURL);
  assert.equal(startupDialog, undefined);
  assert.deepEqual(networkRequests, [], 'Project lifecycle must not issue network requests.');
  await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log('A3_SMOKE=' + JSON.stringify({ mode, passed: true, electron: probe.result.value.electron,
    checks: ['renderer isolation', 'limited IPC', 'sender validation', 'navigation', 'activity', 'CSP', 'popup denial', 'external navigation denial', 'UI create/reopen', 'draft flushed on close', 'relocation', 'cancel incorporation', 'preserve bytes', 'explorer create and rename', 'resource identity preserved', 'keyboard open/rename/duplicate/delete-cancel', 'incremental tree navigation', 'canvas explicit fit', 'native wheel and cursor zoom', 'React Flow native pan', 'resize without fit', 'workspace reopen without drift', 'extensive viewport rebasing', 'grid phase after rebase', 'placements render as fallback nodes', 'visible fallback exposes properties, content and ports', 'create placement through canvas', 'React Flow resize control and validated size update', 'placement resize remains persisted after reopen', 'rectangle and multiple selection', 'selection drag and keyboard move', 'canvas alignment with store-owned undo/redo', 'representation duplication preserves entity IDs', 'duplicate undo/redo after workspace reopen', 'locked placement stays fixed', 'visual edge create/reconnect/style/reopen/delete', 'text tool focus and keyboard navigation', 'freehand mouse points persist in world coordinates', 'pointer pressure is retained when reported', 'selection, deletion and reopen of strokes', 'Rough.js sketch style persists and reopens', 'conversion creates editable vector drawing node', 'spatial groups create/rename/move/collapse/reopen and preserve external edges', 'technical relation sources unchanged', 'canvas IPC denied to foreign window', 'stale sessions', 'window close'] }));
  win.close();
}

if (mode === 'healthy') void healthy().catch((error) => { console.error(error); app.exit(2); });
require(entry);
