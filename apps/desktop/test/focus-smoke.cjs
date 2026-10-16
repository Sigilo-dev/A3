const assert = require('node:assert/strict');
const { join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const [phase, entry, profile, root] = process.argv.slice(2), folders = [];
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => folders.length ? { canceled: false, filePaths: [folders.shift()] } : { canceled: true, filePaths: [] };
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_e, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error('Renderer check: ' + source.slice(0, 200), { cause: error }); }), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(condition) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await js(condition)) return;
      const error = await js("document.querySelector('[data-session-error]')?.textContent || document.querySelector('[data-file-error]')?.textContent || document.querySelector('[data-project-error]')?.textContent || document.querySelector('[data-canvas-error]')?.textContent");
      if (error) throw new Error(error); await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Focus UI timed out: ' + condition + '\n' + await js("document.querySelector('#content')?.innerText.slice(-1600)"));
  }
  const network = []; win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (req, callback) => { network.push(req.url); callback({ cancel: true }); });
  if (phase === 'prepare') {
    await waitFor("Boolean(document.querySelector('[data-open-project]'))"); folders.push(root); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
    await require('./focus-interactions.cjs').prepare({ js, click, waitFor, root, profile });
  } else await require('./focus-interactions.cjs').restore({ js, click, waitFor, profile, folders });
  assert.deepEqual(network, []);
  console.log('A3_FOCUS_SMOKE=' + JSON.stringify({ phase, passed: true, checks: phase === 'prepare' ? ['double click and focus', 'existing tab activation', 'another view and shared resource', 'independent mode and scroll', 'immediate edit survives tab change', 'cancel project switch', 'failed save keeps session and bytes', 'close tab retains document', 'keyboard tabs'] : ['restart restores project, order, selection and viewports', 'missing resource diagnostic', 'original reference retained', 'native locate repairs descriptor only', 'page scroll restored'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
