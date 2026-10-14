const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const [mode, entry, profile, screenshot] = process.argv.slice(2);
const expectedURL = new URL(process.env.ELECTRON_RENDERER_URL || 'a3://desktop/index.html').href;
const development = expectedURL.startsWith('http:');
app.setPath('userData', profile);
// Hide test windows without introducing test switches or IPC into the product.
BrowserWindow.prototype.show = function () {};
let startupDialog;
dialog.showErrorBox = (title, message) => {
  startupDialog = { title, message };
  if (mode !== 'healthy') {
    console.log('A3_SMOKE=' + JSON.stringify({ mode, passed: title.includes('A3') && message.includes('npm run build'), startupDialog }));
  }
};

const created = new Promise((resolve) => app.once('browser-window-created', (_event, window) => resolve(window)));

async function healthy() {
  const win = await created;
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
  assert.deepEqual(probe.bridge, ['getAppInfo']);
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
  assert.equal(navigation.title, 'Archivos');
  assert.equal(navigation.active, 'files');
  assert.equal(navigation.panel, true);
  assert.equal(navigation.cspBlocked, !development);
  assert.equal(navigation.popupDenied, true);

  const extra = new BrowserWindow({ show: false, webPreferences: {
    session: win.webContents.session, preload: join(dirname(entry), '../preload/index.cjs'),
    contextIsolation: true, sandbox: true, nodeIntegration: false
  } });
  await extra.loadURL(expectedURL);
  const denied = await extra.webContents.executeJavaScript('window.a3.getAppInfo()');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  extra.destroy();

  await win.webContents.executeJavaScript("location.href = 'https://example.com'; undefined");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(win.webContents.getURL(), expectedURL);
  assert.equal(startupDialog, undefined);
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log('A3_SMOKE=' + JSON.stringify({ mode, passed: true, electron: probe.result.value.electron,
    checks: ['renderer isolation', 'limited IPC', 'sender validation', 'navigation', 'activity', 'CSP', 'popup denial', 'external navigation denial', 'window close'] }));
  win.close();
}

if (mode === 'healthy') void healthy().catch((error) => { console.error(error); app.exit(2); });
require(entry);
