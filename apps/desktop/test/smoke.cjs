const assert = require('node:assert/strict');
const { mkdir, writeFile, readFile, rename, lstat } = require('node:fs/promises');
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
  assert.deepEqual(probe.bridge, ['getAppInfo', 'projects', 'files']);
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
  const js = (source) => win.webContents.executeJavaScript(source);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await js(condition)) return;
      const failure = await js("document.querySelector('[data-project-error]')?.textContent");
      const fileFailure = await js("document.querySelector('[data-file-error]')?.textContent");
      if (failure || fileFailure) throw new Error(failure || fileFailure);
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
    checks: ['renderer isolation', 'limited IPC', 'sender validation', 'navigation', 'activity', 'CSP', 'popup denial', 'external navigation denial', 'UI create/reopen', 'draft flushed on close', 'relocation', 'cancel incorporation', 'preserve bytes', 'explorer create and rename', 'resource identity preserved', 'keyboard open/rename/duplicate/delete-cancel', 'incremental tree navigation', 'stale sessions', 'window close'] }));
  win.close();
}

if (mode === 'healthy') void healthy().catch((error) => { console.error(error); app.exit(2); });
require(entry);
