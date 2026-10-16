const assert = require('node:assert/strict');
const { mkdir, writeFile, readFile, rename, lstat, cp } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, dialog, clipboard } = require('electron');

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
  const markdownOnly = process.argv.includes('--markdown-only');
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
  assert.deepEqual(probe.bridge, ['getAppInfo', 'projects', 'workspaceSession', 'files', 'canvas', 'markdown', 'code', 'onFileDrop']);
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

  if (!markdownOnly) {
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
  await new Promise((resolve) => setTimeout(resolve, 180));
  if ((await readViewport()).zoom === fitted.zoom) await js("document.querySelector('.canvas-host').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -30, ctrlKey: true }))");
  await waitFor(`Number(document.querySelector('[data-canvas-ready]').dataset.viewportZoom) !== ${fitted.zoom}`);
  const zoomed = await readViewport();
  assert.ok(Math.abs((cursor.x - zoomed.x) / zoomed.zoom - worldUnderCursor.x) < 0.01);
  assert.ok(Math.abs((cursor.y - zoomed.y) / zoomed.zoom - worldUnderCursor.y) < 0.01);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: paneRect.x, y: paneRect.y, deltaX: 25, deltaY: -18, canScroll: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  if ((await readViewport()).x === zoomed.x) await js("document.querySelector('.canvas-host').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 25, deltaY: -18 }))");
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
  assert.equal(await js("document.querySelectorAll('.react-flow__node, .react-flow__edge').length"), 0, 'empty initial workspace stays empty during viewport checks');
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
  }

  if (!markdownOnly) {
  const paste = async () => {
    await js("document.querySelector('.canvas-host').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
  };
  await clipboard.writeText('https://youtu.be/dQw4w9WgXcQ'); await paste();
  await waitFor("(async () => (await (async () => { const p=(await window.a3.projects({action:'list'})).value.active; return (await window.a3.canvas({action:'load',sessionId:p.sessionId,workspaceId:p.workspaces[0].id})).value.entities; })()).some((entity) => entity.type === 'a3.content.youtube'))()");
  assert.equal(networkRequests.length, 0, 'YouTube creates a fallback card without a metadata or thumbnail request');
  await clipboard.writeText('Texto de portapapeles'); await click('[data-canvas-paste-text]');
  await waitFor("(async () => (await (async () => { const p=(await window.a3.projects({action:'list'})).value.active; return (await window.a3.canvas({action:'load',sessionId:p.sessionId,workspaceId:p.workspaces[0].id})).value.entities; })()).some((entity) => entity.type === 'a3.content.short-text' && entity.title === 'Texto pegado'))()");
  assert.equal(await js("document.querySelectorAll('.react-flow__node').length"), 2, `YouTube and paste-as-text each create one node; status=${await js("document.querySelector('[data-canvas-status]')?.textContent")}, error=${await js("document.querySelector('[role=alert]')?.textContent")}`);
  }

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
  const markdownImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(canvasFixture, 'editor.ts'), '\ufefffunction saludo(): string {\r\n  return "hola";\r\n}\r\n');
  await writeFile(join(canvasFixture, 'binary.fixture'), Buffer.from([0, 65, 66]));
  await writeFile(join(canvasFixture, 'mixed.fixture'), 'one\r\ntwo\n');
  await mkdir(join(canvasFixture, 'assets'), { recursive: true });
  await writeFile(join(canvasFixture, 'assets/reference.png'), markdownImage);
  await writeFile(join(canvasFixture, '.a3/resources/00000000-0000-4000-8000-000000000020.json'), JSON.stringify({ schemaVersion: '1.0.0',
    id: '00000000-0000-4000-8000-000000000020', revision: 1, kind: 'project-file', path: 'assets/reference.png', mediaType: 'image/png', extensions: {} }, null, 2) + '\n');
  folders.push(canvasFixture); await click('[data-open-project]');
  await waitFor("document.querySelector('[data-active-project] h2')?.textContent === 'Ejemplo E0-A'");
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-node-count]')?.textContent.startsWith('2 representaciones')");
  assert.equal(await js("document.querySelectorAll('.react-flow__node').length"), 2);
  assert.equal(await js("document.querySelectorAll('[data-node-fallback=\"true\"]').length"), 1);
  await waitFor("(() => { const n = document.querySelector('[data-entity-id=\"00000000-0000-4000-8000-000000000003\"]'); return n?.textContent.includes('demo.smoke') && n.textContent.includes('Puerto visible') && n.textContent.includes('Visión del fixture'); })()");
  const fallbackCard = await js("document.querySelector('[data-entity-id=\"00000000-0000-4000-8000-000000000003\"]')?.textContent");
  assert.ok(fallbackCard.includes('demo.smoke') && fallbackCard.includes('Puerto visible') && fallbackCard.includes('Visión del fixture'));
  await click('[data-section="files"]');
  if (!markdownOnly) {
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
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
  }

  // Milkdown handles the visual subset; CodeMirror edits full source and retains unknown E0 syntax.
  const markdownSafeSource = '# Página Milkdown\n\n## Sección\n\n[[Visión#Sección|Ir a sección]]\n\n![Referencia](../assets/reference.png)\n\n- [ ] tarea pendiente\n\n| Propiedad | Valor |\n| --- | --- |\n| modo | prueba |\n\nTexto inicial.\n';
  const unsupportedFixture = await readFile(join(__dirname, '../../../experiments/e0/editors-canvas/fixtures/markdown.md'), 'utf8');
  const unsupportedSource = `\uFEFF${unsupportedFixture.replace(/\r?\n/g, '\r\n')}\r\n^block-estable\r\n[[enlace incompleto\r\n`;
  await click('[data-section="files"]');
  const markdownTargets = await js(`(async () => {
    const project = (await window.a3.projects({ action: 'list' })).value.active, workspaceId = project.workspaces[0].id;
    let canvas = (await window.a3.canvas({ action: 'load', sessionId: project.sessionId, workspaceId })).value;
    let pageIndex = 0;
    const add = async (expectedWorkspaceRevision, title, value) => window.a3.canvas({ action: 'create-content-node', sessionId: project.sessionId, workspaceId,
      expectedWorkspaceRevision, node: { kind: 'page', title, position: { x: 120 + pageIndex++ * 360, y: 120 }, value } });
    const safe = await add(canvas.revision, 'Milkdown de prueba', ${JSON.stringify(markdownSafeSource)});
    if (!safe.ok) throw new Error(safe.error.message); canvas = safe.value;
    const safeEntity = canvas.entities.find((entity) => entity.title === 'Milkdown de prueba');
    const unsupported = await add(canvas.revision, 'Fuente E0 no compatible', ${JSON.stringify(unsupportedSource)});
    if (!unsupported.ok) throw new Error(unsupported.error.message);
    const unsupportedEntity = unsupported.value.entities.find((entity) => entity.title === 'Fuente E0 no compatible');
    return { project, workspaceId, safeEntityId: safeEntity.id, safeResourceId: safeEntity.contentResourceId,
      unsupportedEntityId: unsupportedEntity.id, unsupportedResourceId: unsupportedEntity.contentResourceId };
  })()`);
  await click('[data-section="canvas"]');
  await waitFor(`Boolean(document.querySelector('[data-open-markdown="${markdownTargets.safeEntityId}"]')) && Boolean(document.querySelector('[data-open-markdown="${markdownTargets.unsupportedEntityId}"]'))`);
  await click(`[data-open-markdown="${markdownTargets.safeEntityId}"]`);
  await waitFor("Boolean(document.querySelector('.markdown-dialog'))");
  await waitFor("Boolean(document.querySelector('.markdown-surface .ProseMirror')) || Boolean(document.querySelector('.markdown-error'))");
  await waitFor("document.querySelector('.markdown-surface img[data-a3-asset=\"ready\"]')?.naturalWidth === 1");
  const markdownEditorState = await js("({ dialog: document.querySelector('.markdown-dialog')?.innerText, editor: document.querySelector('.markdown-surface')?.innerHTML.slice(0, 1200), error: document.querySelector('.markdown-error')?.textContent })");
  assert.equal(markdownEditorState.error, undefined, JSON.stringify(markdownEditorState));
  assert.ok(markdownEditorState.editor?.includes('a3-wikilink'), JSON.stringify(markdownEditorState));
  assert.equal(await js("document.querySelector('[data-markdown-save]').disabled"), true, 'opening an unchanged document does not enable serialization');
  await click('[data-markdown-source-mode]');
  await waitFor("Boolean(document.querySelector('[data-markdown-source-editor] .cm-editor'))");
  assert.equal(await js("document.querySelector('[data-markdown-save]').disabled"), true, 'CodeMirror no-op keeps the shared document clean');
  await click('[data-markdown-visual]');
  await waitFor("Boolean(document.querySelector('.markdown-surface .ProseMirror'))");
  assert.equal(await js("document.querySelectorAll('.markdown-surface input[type=checkbox]').length"), 1, 'GFM checkboxes render as controls');
  await click('[data-markdown-preview]');
  assert.equal(await js("document.querySelector('.markdown-surface .ProseMirror').getAttribute('contenteditable')"), 'false', 'preview is the same non-editable document view');
  await waitFor("document.querySelector('.markdown-task-checkbox')?.disabled === true");
  assert.equal(await js("document.querySelector('.markdown-task-checkbox').disabled"), true, 'preview disables checkbox mutations');
  await click('[data-markdown-visual]');
  await js("document.querySelector('.markdown-task-checkbox').click()");
  await js(`(() => { const block = document.querySelector('.markdown-surface .ProseMirror p:last-of-type'); block.focus(); const range = document.createRange(); range.selectNodeContents(block); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, ' editada'); })()`);
  await waitFor("!document.querySelector('[data-markdown-save]').disabled");
  await click('[data-markdown-save]'); await waitFor("document.querySelector('#markdown-status')?.textContent === 'Guardado'");
  const savedMarkdown = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}' })`);
  assert.equal(savedMarkdown.ok, true);
  assert.match(savedMarkdown.value.content, /\[\[Visión#Sección\|Ir a sección\]\]/, 'A3 wikilink remains unescaped in the Markdown source');
  assert.match(savedMarkdown.value.content, /!\[Referencia[^\]]*\]\(\.\.\/assets\/reference\.png\)/, 'portable image references remain Markdown');
  assert.match(savedMarkdown.value.content, /[*+-] \[x\] tarea pendiente/, 'task checkbox edits the shared Markdown source');
  assert.match(savedMarkdown.value.content, /editada/);
  await click('[data-markdown-close]');
  await waitFor("!document.querySelector('.markdown-dialog')");
  await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady === 'true'");
  const reopenedMarkdownNode = await js(`(async () => { const p=(await window.a3.projects({action:'list'})).value.active;
    return { section: document.querySelector('[aria-current="page"]')?.dataset.section,
    canvas: document.querySelector('[data-canvas-ready]')?.outerHTML.slice(0, 350),
    nodeCount: document.querySelectorAll('.react-flow__node').length,
    buttons: [...document.querySelectorAll('[data-open-markdown]')].map((item) => item.dataset.openMarkdown),
    stored: (await window.a3.canvas({action:'load',sessionId:p.sessionId,workspaceId:p.workspaces[0].id})).value.placements.map((item)=>item.entityId) }; })()`);
  assert.ok(reopenedMarkdownNode.buttons.includes(markdownTargets.safeEntityId), JSON.stringify(reopenedMarkdownNode));
  await click(`[data-open-markdown="${markdownTargets.safeEntityId}"]`);
  await waitFor("document.querySelector('.markdown-surface .ProseMirror')?.textContent.includes('editada')");

  const staleBase = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}' })`);
  await js(`(() => { const block = document.querySelector('.markdown-surface .ProseMirror p:last-of-type'); block.focus(); const range = document.createRange(); range.selectNodeContents(block); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, ' local'); })()`);
  await waitFor("!document.querySelector('[data-markdown-save]').disabled");
  const externalSave = await js(`window.a3.markdown({ action: 'save', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}', entityRevision: ${staleBase.value.entityRevision}, expectedRevision: ${staleBase.value.revision}, expectedHash: '${staleBase.value.hash}', content: ${JSON.stringify(staleBase.value.content + '\nCambio externo.\n')} })`);
  assert.equal(externalSave.ok, true);
  await click('[data-markdown-save]'); await waitFor("document.querySelector('[role=alert]')?.textContent.includes('REVISION_CONFLICT')");
  await waitFor("Boolean(document.querySelector('[data-markdown-conflict]'))");
  const comparedMarkdown = await js("({ local: document.querySelector('.markdown-conflict-versions section:first-child pre')?.textContent, saved: document.querySelector('.markdown-conflict-versions section:last-child pre')?.textContent })");
  assert.match(comparedMarkdown.local, /local/); assert.match(comparedMarkdown.saved, /Cambio externo/);
  await js('window.confirm = () => true; undefined');
  await click('[data-markdown-conflict-keep-draft]');
  await waitFor("!document.querySelector('[data-markdown-conflict]') && document.querySelector('#markdown-status')?.textContent.includes('Conflicto resuelto')");
  assert.equal(await js("document.querySelector('.markdown-surface .ProseMirror').textContent.includes('local')"), true, 'stale local draft remains available after conflict');
  const afterConflict = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}' })`);
  assert.match(afterConflict.value.content, /local/, 'the selected local version is saved against the compared current revision');
  assert.doesNotMatch(afterConflict.value.content, /Cambio externo/);
  await click('[data-markdown-source-mode]'); await waitFor("Boolean(document.querySelector('[data-markdown-source-editor] .cm-editor'))");
  await js(`(() => { const editor=document.querySelector('[data-markdown-source-editor] .cm-content'); const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT); let node; while(node=walker.nextNode()){ const at=node.textContent.indexOf('Texto inicial.'); if(at>=0){ const range=document.createRange(); range.setStart(node,at); range.setEnd(node,at+'Texto inicial.'.length); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText',false,'Texto en fuente.'); break; } } })()`);
  await waitFor("!document.querySelector('[data-markdown-save]').disabled"); await click('[data-markdown-save]');
  await waitFor("document.querySelector('#markdown-status')?.textContent === 'Guardado'");
  const savedSourceMode = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}' })`);
  assert.match(savedSourceMode.value.content, /Texto en fuente\./);
  assert.doesNotMatch(savedSourceMode.value.content, /\r\n/, 'source editing retains the imported LF representation');
  await click('[data-markdown-close]');

  await waitFor(`Boolean(document.querySelector('[data-open-markdown="${markdownTargets.unsupportedEntityId}"]'))`);
  await click(`[data-open-markdown="${markdownTargets.unsupportedEntityId}"]`);
  await waitFor("Boolean(document.querySelector('[data-markdown-source-editor] .cm-editor'))");
  assert.equal(await js("document.querySelector('[data-markdown-source-editor] .cm-content').textContent.includes('payload:')"), true);
  await waitFor("Boolean(document.querySelector('[data-markdown-diagnostic]'))");
  assert.match(await js("document.querySelector('[data-markdown-diagnostic]').textContent"), /línea \d+, columna 1/);
  assert.equal(await js("document.querySelector('.markdown-surface')"), null, 'unknown E0 block stays source-only');
  const unsupportedOpened = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.unsupportedEntityId}', resourceId: '${markdownTargets.unsupportedResourceId}' })`);
  assert.equal(unsupportedOpened.value.canWrite, true, 'unsupported syntax remains editable through CodeMirror');
  assert.equal(unsupportedOpened.value.content, unsupportedSource);
  await js(`(() => { const editor=document.querySelector('[data-markdown-source-editor] .cm-content'); editor.focus(); const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT); let node; while(node=walker.nextNode()){ const at=node.textContent.indexOf('palabra con tilde'); if(at>=0){ const range=document.createRange(); range.setStart(node,at); range.setEnd(node,at+'palabra con tilde'.length); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText',false,'palabra revisada'); break; } } })()`);
  await waitFor("!document.querySelector('[data-markdown-save]').disabled");
  await click('[data-markdown-save]'); await waitFor("document.querySelector('.markdown-error')?.textContent.includes('línea')");
  const parseFailure = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.unsupportedEntityId}', resourceId: '${markdownTargets.unsupportedResourceId}' })`);
  assert.equal(parseFailure.value.content, unsupportedSource, 'parse diagnostic keeps the original saved source untouched');
  await js(`(() => { const editor=document.querySelector('[data-markdown-source-editor] .cm-content'); const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT); let node; while(node=walker.nextNode()){ const at=node.textContent.indexOf('[[enlace incompleto'); if(at>=0){ const range=document.createRange(); range.setStart(node,at); range.setEnd(node,at+'[[enlace incompleto'.length); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText',false,'[[enlace corregido]]'); break; } } })()`);
  await waitFor("!document.querySelector('[data-markdown-diagnostic]')");
  await waitFor("!document.querySelector('[data-markdown-save]').disabled");
  await click('[data-markdown-save]'); await waitFor("document.querySelector('#markdown-status')?.textContent === 'Guardado'");
  const editedUnsupported = await js(`window.a3.markdown({ action: 'open', sessionId: '${markdownTargets.project.sessionId}', entityId: '${markdownTargets.unsupportedEntityId}', resourceId: '${markdownTargets.unsupportedResourceId}' })`);
  assert.match(editedUnsupported.value.content, /palabra revisada/);
  assert.match(editedUnsupported.value.content, /\[\[entidad-a3\|Entidad vinculada\]\]/);
  assert.match(editedUnsupported.value.content, /:::bloque-desconocido[\s\S]*payload: \{.*sin interpretar.*\}[\s\S]*:::/);
  assert.match(editedUnsupported.value.content, /export const marcador/);
  assert.match(editedUnsupported.value.content, /\^block-estable/);
  assert.match(editedUnsupported.value.content, /\[\[enlace corregido\]\]/);
  assert.equal(editedUnsupported.value.content.charCodeAt(0), 0xfeff, 'source keeps the imported BOM');
  assert.doesNotMatch(editedUnsupported.value.content, /(?<!\r)\n/, 'CodeMirror preserves the original CRLF separator on a real source edit');
  await click('[data-markdown-close]');

  const codeDocumentId = await require('./code-interactions.cjs')({ win, js, click, input, waitFor, root: canvasFixture });
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
  const deniedMarkdown = await extra.webContents.executeJavaScript(`window.a3.markdown({ action: 'open', sessionId: '${fixtureSession.sessionId}', entityId: '${markdownTargets.safeEntityId}', resourceId: '${markdownTargets.safeResourceId}' })`);
  assert.equal(deniedMarkdown.error.code, 'PERMISSION_DENIED');
  const deniedSession = await extra.webContents.executeJavaScript(`window.a3.workspaceSession({ action: 'load', sessionId: '${fixtureSession.sessionId}' })`);
  assert.equal(deniedSession.error.code, 'PERMISSION_DENIED');
  const deniedCode = await extra.webContents.executeJavaScript(`window.a3.code({ action: 'reload', sessionId: '${fixtureSession.sessionId}', documentId: '${codeDocumentId}' })`);
  assert.equal(deniedCode.error.code, 'PERMISSION_DENIED');
  extra.destroy();

  await win.webContents.executeJavaScript("location.href = 'https://example.com'; undefined");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(win.webContents.getURL(), expectedURL);
  assert.equal(startupDialog, undefined);
  assert.deepEqual(networkRequests, [], 'Project lifecycle must not issue network requests.');
  await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
  const checks = ['renderer isolation', 'limited IPC', 'sender validation', 'navigation', 'activity', 'CSP', 'popup denial', 'external navigation denial',
    'UI create/reopen', 'draft flushed on close', 'relocation', 'cancel incorporation', 'preserve bytes', 'explorer create and rename', 'resource identity preserved',
    'keyboard open/rename/duplicate/delete-cancel', 'incremental tree navigation',
    ...(!markdownOnly ? ['canvas explicit fit', 'native wheel and cursor zoom', 'React Flow native pan', 'resize without fit', 'workspace reopen without drift',
      'extensive viewport rebasing', 'grid phase after rebase'] : []),
    'placements render as fallback nodes', 'visible fallback exposes properties, content and ports',
    ...(!markdownOnly ? ['create placement through canvas', 'React Flow resize control and validated size update', 'placement resize remains persisted after reopen',
      'rectangle and multiple selection', 'selection drag and keyboard move', 'canvas alignment with store-owned undo/redo', 'representation duplication preserves entity IDs',
      'duplicate undo/redo after workspace reopen', 'locked placement stays fixed', 'visual edge create/reconnect/style/reopen/delete', 'text tool focus and keyboard navigation',
      'freehand mouse points persist in world coordinates', 'pointer pressure is retained when reported', 'selection, deletion and reopen of strokes', 'Rough.js sketch style persists and reopens',
      'conversion creates editable vector drawing node', 'spatial groups create/rename/move/collapse/reopen and preserve external edges'] : []),
    'Milkdown GFM and A3 wikilinks', 'same-resource Markdown edit/preview/reopen', 'local portable image preview', 'revision conflict preserves both versions',
    'CodeMirror source and Milkdown share one document', 'unknown Markdown blocks survive source edit', 'revision conflict compare/resolve',
    'CodeMirror code editor through explorer and code nodes', 'code Unicode BOM/CRLF save/reopen', 'line numbers, fold gutter, search/replace and languages',
    'binary and mixed-EOL readonly', 'code conflict compare/resolve', 'code exit cancellation preserves writer', 'code IPC validation and sender denial',
    'technical relation sources unchanged', 'canvas and Markdown IPC denied to foreign window', 'stale sessions', 'window close'];
  console.log('A3_SMOKE=' + JSON.stringify({ mode, passed: true, electron: probe.result.value.electron, checks }));
  win.close();
}

if (mode === 'healthy') void healthy().catch((error) => { console.error(error); app.exit(2); });
require(entry);
