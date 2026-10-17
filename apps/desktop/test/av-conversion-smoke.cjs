const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root, resourceId, engineRoot] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: [options?.title?.includes('FFmpeg') ? engineRoot : root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message); });
  contents.on('preload-error', (_event, _path, error) => console.error('Preload:', error.message));
});
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(expression) {
    for (let i = 0; i < 600; i++) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-4500)'));
  }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = active.sessionId;
  assert.equal(await js('typeof require'), 'undefined');
  assert.equal((await js("window.a3.avConversion({action:'engine-status'})")).value.available, false, 'fresh local profile has no implicit FFmpeg approval');
  assert.equal((await js("window.a3.avConversion({action:'configure-engine',path:'C:/untrusted'})")).ok, false);
  const gallery = () => js(`window.a3.gallery({action:'load',sessionId:${JSON.stringify(sessionId)}})`);
  const open = async () => {
    await click(`[data-gallery-resource-id="${resourceId}"] .gallery-card-preview`); await click('[data-gallery-convert-av]');
  };
  await click('[data-section="gallery"]'); await waitFor(`Boolean(document.querySelector('[data-gallery-resource-id="${resourceId}"]'))`); await open();
  await waitFor("document.querySelector('[data-av-state]')?.textContent.includes('Error')");
  assert.match(await js("document.querySelector('[data-av-engine]').textContent"), /Componente/);
  await click('[data-av-configure]'); await waitFor("Boolean(document.querySelector('[data-av-profile]')) && !document.querySelector('[data-av-prepare]').disabled");
  assert.match(await js("document.querySelector('[data-av-source]').textContent"), /matroska.*ffv1/s);
  assert.match(await js("document.querySelector('.av-conversion-dialog .image-loss-report').textContent"), /pérdida|pérdidas/i);
  await click('[data-av-prepare]'); await waitFor("Boolean(document.querySelector('[data-av-output]')) && !document.querySelector('[data-av-save]').disabled");
  assert.equal((await gallery()).value.items.length, 1, 'prepared output is not catalogued');
  assert.match(await js("document.querySelector('[data-av-output]').textContent"), /h264.*aac/s);
  await click('[data-av-save]'); await waitFor("document.querySelector('[data-av-state]')?.textContent.includes('Recurso creado')");
  assert.equal((await gallery()).value.items.length, 2);
  await click('.av-conversion-dialog header button'); await waitFor("!document.querySelector('.av-conversion-dialog')");
  await open(); await waitFor("Boolean(document.querySelector('[data-av-profile]')) && !document.querySelector('[data-av-prepare]').disabled");
  await click('[data-av-prepare]'); await waitFor("Boolean(document.querySelector('[data-av-output]')) && !document.querySelector('[data-av-save]').disabled");
  await click('.av-conversion-dialog header button'); await waitFor("!document.querySelector('.av-conversion-dialog')");
  assert.equal((await gallery()).value.items.length, 2, 'cancelled staging creates no Resource');
  console.log('A3_AV_SMOKE=' + JSON.stringify({ passed: true, checks: ['optional engine absent', 'native configuration with hashes/license', 'renderer without Node', 'strict IPC', 'real container/codecs', 'losses before conversion', 'progress and verified staging', 'explicit new Resource', 'cancel without orphan'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
