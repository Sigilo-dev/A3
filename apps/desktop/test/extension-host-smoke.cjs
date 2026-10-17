const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root, fixturePath] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event) => { console.error('renderer:', event.message); });
  await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(expression) {
    for (let index = 0; index < 400; index++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 30)); }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-3000)'));
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]');
  await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active, manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const call = (request) => js(`window.a3.extensions(${JSON.stringify({ sessionId: active.sessionId, ...request })})`);
  const review = await js(`window.a3.extensions({action:'review',sessionId:${JSON.stringify(active.sessionId)},bytes:new Uint8Array(${JSON.stringify([...Buffer.from(JSON.stringify(manifest))])})})`);
  assert.equal(review.ok, true); assert.equal((await call({ action: 'status' })).value.extensions.length, 0);
  const installed = await call({ action: 'apply', token: review.value.token }); assert.equal(installed.ok, true);
  const extension = installed.value.extensions[0]; assert.equal(installed.value.runtimeAvailable, false);
  const approved = await call({ action: 'grant', id: manifest.id, integrity: extension.integrity, capability: 'project.read', scope: manifest.scopes['project.read'] });
  assert.equal(approved.ok, true); assert.ok(approved.value.extensions[0].permissions[0].approved);
  assert.ok(approved.value.extensions[0].permissions.every((permission) => !permission.effective));
  assert.equal((await call({ action: 'start', id: manifest.id, integrity: extension.integrity })).error.code, 'EXTENSION_SANDBOX_UNAVAILABLE');
  await click('[data-section="nodes"]'); await waitFor("Boolean(document.querySelector('#extension-host-title'))");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(manifest.name)})`);
  assert.match(await js("document.querySelector('#extension-host-title').parentElement.textContent"), /Ejecución deshabilitada/);
  await js("document.querySelector('[aria-label=\"Revisar manifiesto de extensión programada\"]').focus()");
  assert.equal(await js("document.activeElement.getAttribute('aria-label')"), 'Revisar manifiesto de extensión programada');
  assert.equal(await js('typeof require'), 'undefined');
  await click('.node-package-builder button[type="submit"]');
  await waitFor("Boolean(document.querySelector('[aria-label=\"Vista previa de instalación\"]'))");
  assert.match(await js("document.querySelector('.node-package-preview').textContent"), /comunidad\.mi-paquete/);
  assert.equal((await call({ action: 'status', root: 'C:/foreign', actor: { kind: 'user' } })).error.code, 'EXTENSION_INVALID_REQUEST');
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: join(dirname(entry), '../preload/index.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await foreign.loadURL('data:text/html,<h1>Untrusted fixture</h1>');
  const denied = await foreign.webContents.executeJavaScript(`window.a3.extensions(${JSON.stringify({ action: 'status', sessionId: active.sessionId })})`);
  assert.equal(denied.error.code, 'PERMISSION_DENIED'); foreign.destroy();
  const revoked = await call({ action: 'revoke', id: manifest.id, integrity: extension.integrity, capability: 'project.read' });
  assert.equal(revoked.ok, true); assert.ok(!revoked.value.extensions[0].permissions[0].approved);
  assert.equal((await call({ action: 'status', sessionId: '81000000-0000-4000-8000-000000000099' })).error.code, 'EXTENSION_STALE_SESSION');
  assert.equal((await call({ action: 'remove', id: manifest.id, integrity: extension.integrity })).value.extensions.length, 0);
  console.log('A3_EXTENSION_HOST_SMOKE=' + JSON.stringify({ passed: true, checks: ['native manifest review', 'independent inert approval', 'runtime blocked', 'visible unavailable UI', 'keyboard focus', 'renderer without Node', 'declarative builder without eval', 'foreign WebContents denied', 'strict IPC', 'revocation', 'project bytes unchanged'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
