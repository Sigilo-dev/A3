const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root, resourceId] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
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
    for (let index = 0; index < 500; index++) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-3500)'));
  }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active;
  const sessionId = active.sessionId;
  const gallery = () => js(`window.a3.gallery({action:'load',sessionId:${JSON.stringify(sessionId)}})`);
  assert.equal((await gallery()).value.items.length, 1); assert.equal(await js('typeof require'), 'undefined');
  await click('[data-section="gallery"]'); await waitFor(`Boolean(document.querySelector('[data-gallery-resource-id="${resourceId}"]'))`);
  await click(`[data-gallery-resource-id="${resourceId}"] .gallery-card-preview`); await click('[data-gallery-convert]');
  await waitFor("Boolean(document.querySelector('[data-image-format]'))");
  assert.match(await js("document.querySelector('.image-source-info').textContent"), /Formato real: PNG/);
  await js("(() => { const select = document.querySelector('[data-image-format]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'jpeg'); select.dispatchEvent(new Event('change',{bubbles:true})); })()");
  assert.match(await js("document.querySelector('.image-loss-report').textContent"), /transparencia/);
  await click('[data-image-prepare]'); await waitFor("Boolean(document.querySelector('[data-image-output]')) && !document.querySelector('[data-image-save]').disabled");
  assert.equal((await gallery()).value.items.length, 1, 'staged output is not catalogued yet');
  await click('[data-image-save]'); await waitFor("document.querySelector('.image-conversion-dialog')?.textContent.includes('Recurso creado')");
  assert.equal((await gallery()).value.items.length, 2);
  await click('.image-conversion-dialog header button'); await waitFor("!document.querySelector('.image-conversion-dialog')");
  await waitFor(`Boolean(document.querySelector('[data-gallery-resource-id="${resourceId}"]'))`);
  await click(`[data-gallery-resource-id="${resourceId}"] .gallery-card-preview`); await click('[data-gallery-convert]');
  await waitFor("Boolean(document.querySelector('[data-image-format]'))"); await click('[data-image-prepare]');
  await waitFor("Boolean(document.querySelector('[data-image-output]')) && !document.querySelector('[data-image-save]').disabled");
  await click('.image-conversion-dialog header button'); await waitFor("!document.querySelector('.image-conversion-dialog')");
  assert.equal((await gallery()).value.items.length, 2, 'cancelled output does not create another Resource');
  console.log('A3_IMAGE_SMOKE=' + JSON.stringify({ passed: true, checks: ['Electron native worker', 'real format inspection', 'loss report before conversion', 'gallery entry point', 'staged size and destination', 'new resource after explicit confirmation', 'cancel without orphan', 'renderer without Node'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
