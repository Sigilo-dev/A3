const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, clipboard } = require('electron');
const [entry, profile, root] = process.argv.slice(2), folders = [root];
const clipboardWrites = []; clipboard.writeText = async (value) => { clipboardWrites.push(value); };
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => folders.length ? { canceled: false, filePaths: [folders.shift()] } : { canceled: true, filePaths: [] };
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_e, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error('Renderer check: ' + source.slice(0, 250), { cause: error }); }), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(condition) {
    for (let i = 0; i < 180; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + condition + '\n' + await js("document.querySelector('#content')?.innerText.slice(-2200)"));
  }
  async function input(selector, value) { await js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
  async function context(selector, kind) { await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`); await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:140,clientY:170})); undefined`); await waitFor(`Boolean(document.querySelector('[data-context-menu="${kind}"]'))`); }
  async function dismissMenu() { await js("document.querySelector('[data-context-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); undefined"); }
  const network = []; win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (req, callback) => { network.push(req.url); callback({ cancel: true }); });
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active;
  const invoke = async (request) => { const r = await js(`window.a3.canvas(${JSON.stringify({ ...request, sessionId: project.sessionId, workspaceId: project.workspaces[0].id })})`); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  let canvas = await invoke({ action: 'load' });
  const createPage = async (title, value, x) => { canvas = await invoke({ action: 'create-content-node', expectedWorkspaceRevision: canvas.revision, node: { kind: 'page', title, value, position: { x: (x - canvas.viewport.x) / canvas.viewport.zoom, y: (80 - canvas.viewport.y) / canvas.viewport.zoom } } }); return canvas.entities.find((e) => e.title === title); };
  const target = await createPage('Destino', '# Intro\n\nPárrafo ^block\n', 380);
  const initial = (await js(`window.a3.navigation({action:'index',sessionId:'${project.sessionId}'})`)).value;
  const targetPath = initial.pages.find((p) => p.entityId === target.id).path.split('/').at(-1);
  const source = await createPage('Origen', `# Origen\n\n[[Destino|Alias]] [[Destino^block|Bloque]] [[Duplicado#Duplicado|Encabezado ambiguo]] [Normal](${targetPath}#intro)\n`, 80);
  const duplicates = [];
  for (const x of [700, 1020]) { canvas = await invoke({ action: 'create-content-node', expectedWorkspaceRevision: canvas.revision, node: { kind: 'page', title: 'Duplicado', value: '# Duplicado\n', position: { x, y: 600 } } }); duplicates.push(canvas.entities.filter((e) => e.title === 'Duplicado').at(-1).id); }
  const placement = canvas.placements.find((p) => p.entityId === source.id);
  canvas = await invoke({ action: 'create-drawing', expectedWorkspaceRevision: canvas.revision, points: [{ x: 10, y: 400 }, { x: 60, y: 420 }, { x: 100, y: 400 }], parameters: { size: 4, thinning: .5, smoothing: .5, streamline: .5, simulatePressure: true } });
  const drawing = canvas.drawings.at(-1);
  canvas = await invoke({ action: 'create-group', expectedWorkspaceRevision: canvas.revision, name: 'Context group', members: [{ kind: 'placement', id: placement.id }] }); const group = canvas.groups.at(-1);
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  await click('[data-canvas-fit]');
  console.log('NAVIGATION_PHASE=links');
  await js(`document.querySelector('[data-entity-id="${source.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); undefined`);
  await waitFor("document.querySelector('#markdown-title')?.textContent==='Origen' && Boolean(document.querySelector('[data-outgoing] button'))");
  const session = async () => (await js(`window.a3.workspaceSession({action:'load',sessionId:'${project.sessionId}'})`)).value;
  const sourceTab = (await session()).selectedId;
  await js("[...document.querySelectorAll('[data-outgoing] button')].find((b)=>b.textContent.includes('Alias')).click(); undefined");
  await waitFor("document.querySelector('#markdown-title')?.textContent==='Destino' && Boolean(document.querySelector('[data-backlinks] button'))");
  const targetTab = (await session()).selectedId, count = (await session()).tabs.length;
  await click('[data-navigation-back]'); await waitFor("document.querySelector('#markdown-title')?.textContent==='Origen'");
  await click('[data-navigation-forward]'); await waitFor("document.querySelector('#markdown-title')?.textContent==='Destino'"); assert.equal((await session()).tabs.length, count);
  await click(`[data-focus-tab="${sourceTab}"]`); await waitFor(`Boolean(document.querySelector('[data-a3-wikilink="Destino"]'))`);
  await js(`document.querySelector('[data-a3-wikilink="Destino"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); undefined`); await waitFor(`document.querySelector('[data-focus-tab="${targetTab}"]')?.getAttribute('aria-selected')==='true'`); assert.equal((await session()).tabs.length, count);
  await click(`[data-focus-tab="${sourceTab}"]`); await waitFor("document.querySelector('#markdown-title')?.textContent==='Origen'");
  await js("[...document.querySelectorAll('[data-outgoing] button')].find((b)=>b.textContent.includes('Bloque')).click(); undefined");
  await waitFor("document.querySelector('#markdown-title')?.textContent==='Destino' && Boolean(document.querySelector('[data-markdown-source-editor] .cm-activeLine'))");
  await waitFor("document.querySelector('[data-markdown-source-editor] .cm-activeLine')?.textContent.includes('^block')");
  await click(`[data-focus-tab="${sourceTab}"]`); await waitFor("document.querySelector('#markdown-title')?.textContent==='Origen'");
  await js("[...document.querySelectorAll('[data-outgoing] button')].find((b)=>b.dataset.linkStatus==='ambiguous').click(); undefined");
  await waitFor("document.querySelectorAll('[data-link-choice]').length===2"); assert.equal((await session()).selectedId, sourceTab);
  await js("document.querySelector('[data-link-choice]').click(); undefined"); await waitFor("document.querySelector('#markdown-title')?.textContent==='Duplicado'");
  await waitFor("Boolean(document.querySelector('[data-markdown-source-editor] .cm-activeLine'))");
  await click('[data-markdown-visual]'); await waitFor("document.querySelector('[data-markdown-visual]')?.getAttribute('aria-pressed')==='true' && Boolean(document.querySelector('.ProseMirror'))");
  console.log('NAVIGATION_PHASE=page-menu');
  await click(`[data-focus-tab="${targetTab}"]`);
  await js(`document.querySelector('[data-focus-tab="${targetTab}"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})); undefined`);
  await waitFor(`Boolean(document.querySelector('[data-context-menu="page"]'))`);
  await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); undefined");
  assert.equal(await js("document.activeElement.dataset.contextAction"), 'another-view'); await dismissMenu();
  assert.equal(await js('document.activeElement.dataset.focusTab'), targetTab);
  await context(`[data-focus-tab="${targetTab}"]`, 'page');
  await click('[data-context-action="copy-link"]'); for (let i = 0; i < 180 && !clipboardWrites.length; i++) await new Promise((resolve) => setTimeout(resolve, 50)); assert.match(clipboardWrites.at(-1) ?? '', new RegExp(target.id));
  await context(`[data-focus-tab="${targetTab}"]`, 'page'); await waitFor("document.querySelector('[data-context-action=" + '"rename"' + "]')?.getAttribute('aria-disabled')==='false'");
  await click('[data-context-action="rename"]'); await waitFor("Boolean(document.querySelector('[data-text-prompt]'))"); await input('[data-text-prompt]', 'Destino nuevo'); await click('[data-text-confirm]');
  await waitFor("document.querySelector('#markdown-title')?.textContent==='Destino nuevo'");
  const index = (await js(`window.a3.navigation({action:'index',sessionId:'${project.sessionId}'})`)).value;
  assert.ok(index.links.filter((l) => l.sourceId === source.id).filter((l) => l.target.includes('Destino')).every((l) => l.entityId === target.id));
  console.log('NAVIGATION_PHASE=context-types');
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  for (const [selector, kind, action] of [['[data-canvas-ready]', 'canvas', 'paste-text'], [`[data-entity-id="${source.id}"]`, 'placement', 'duplicate-content'], [`[data-group-id="${group.id}"]`, 'group', 'collapse'], [`[data-drawing-id="${drawing.id}"]`, 'stroke', 'delete']]) {
    await context(selector, kind); const actions = await js("[...document.querySelectorAll('[data-context-action]')].map((b)=>b.dataset.contextAction)"); assert.ok(actions.includes(action), actions.join(',')); assert.ok(!actions.some((id) => /git|convert|export|uml/i.test(id))); await dismissMenu();
  }
  await click('[data-section="files"]'); await waitFor("Boolean(document.querySelector('[data-file-entry]'))");
  const fileId = await js("[...document.querySelectorAll('[data-file-entry]')].find((b)=>b.textContent.includes('a3.project.json')).dataset.fileItemId");
  const folderId = await js("[...document.querySelectorAll('[data-file-entry]')].find((b)=>b.textContent.includes('pages')).dataset.fileItemId");
  const fileSelector = `[data-file-item-id="${fileId}"]`;
  await context(fileSelector, 'file'); assert.equal(await js("Boolean(document.querySelector('[data-context-action=" + '"copy-relative"' + "]'))"), true); await dismissMenu();
  await js("[...document.querySelectorAll('[data-file-entry]')].find((b)=>b.textContent.includes('pages')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); undefined"); await waitFor("Boolean(document.querySelector('[data-context-menu=" + '"folder"' + "]'))"); await dismissMenu();
  console.log('NAVIGATION_PHASE=permissions-and-shortcuts');
  const { createProjectCapabilityBroker } = await import(pathToFileURL(join(__dirname, '../../../packages/project-store/dist/index.js')).href);
  const broker = createProjectCapabilityBroker({ stateDirectory: profile, authenticatedActor: { kind: 'user', id: 'desktop-local-user' }, confirmUserAction: () => true });
  await broker.setProfile({ root, projectId: project.projectId, profile: 'consultar' });
  await context(`[data-file-item-id="${folderId}"]`, 'folder'); await waitFor("document.querySelector('[data-context-action=" + '"rename"' + "]')?.getAttribute('aria-disabled')==='true'");
  assert.match(await js("document.querySelector('[data-context-action=" + '"rename"' + "]').textContent"), /document.edit/); await dismissMenu();
  await click('[data-section="preferences"]'); await waitFor("Boolean(document.querySelector('[data-shortcut=" + '"redo"' + "]'))");
  await input('[data-shortcut="redo"]', 'Ctrl+Z'); await waitFor("document.querySelector('[data-shortcut-conflict]')?.textContent.includes('Colisión')"); assert.equal(await js("document.querySelector('[data-shortcuts-save]').disabled"), true);
  await click('[data-shortcuts-reset]'); await waitFor("!document.querySelector('[data-shortcut-conflict]')");
  await input('[data-shortcut="back"]', 'Alt+J'); await click('[data-shortcuts-save]'); await waitFor("document.querySelector('.shortcut-preferences [role=" + '"status"' + "]')?.textContent.includes('guardados')");
  assert.equal(JSON.parse(await readFile(join(profile, 'local-projects/shortcuts.json'), 'utf8')).back, 'Alt+J');
  await click('[data-section="canvas"]'); await click(`[data-focus-tab="${targetTab}"]`);
  await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',altKey:true,bubbles:true,cancelable:true})); undefined");
  await waitFor(`document.querySelector('[data-focus-tab="${targetTab}"]')?.getAttribute('aria-selected')==='false'`);
  const extra = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../out/preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await extra.loadURL('about:blank'); const denied = await extra.webContents.executeJavaScript(`window.a3.navigation({action:'index',sessionId:'${project.sessionId}'})`); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'PERMISSION_DENIED'); extra.destroy();
  assert.deepEqual(network, []);
  console.log('A3_NAVIGATION_SMOKE=' + JSON.stringify({ passed: true, checks: ['alias and ID navigation', 'block anchor source jump', 'ambiguous destination selector', 'back/forward without duplicate tabs', 'backlinks', 'transactional page rename', 'page/canvas/placement/group/stroke/file/folder menus', 'permission reason', 'shortcut conflict/reset/local save', 'foreign window IPC denied', 'offline'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
