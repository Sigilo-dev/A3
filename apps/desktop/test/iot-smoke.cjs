const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
app.setPath('userData', profile);
BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));

async function run() {
  const win = await created;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event) => {
    if (event.level >= 2) console.error(`renderer console error ${event.sourceId}:${event.lineNumber}: ${event.message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => console.error(`renderer process gone: ${JSON.stringify(details)}`));
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(condition) {
    for (let i = 0; i < 500; i++) {
      if (await js(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${condition}\n${await js('document.body.innerText.slice(-2500)')}`);
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const select = (selector, value) => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const input = (selector, value) => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))");
  await click('[data-open-project]');
  await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active;
  const sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  const loadExpression = `window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`;
  const load = async () => (await js(loadExpression)).value;
  const waitState = (expression) => waitFor(`(async()=>{const r=await ${loadExpression};return r.ok&&(${expression})})()`);
  await click('[data-section="canvas"]');
  await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  await js("document.querySelector('[data-iot-inspector]').open=true; undefined");
  await select('[aria-label="Colección IoT"]', 'a3.iot.collection.sensors');
  const inspector = await js("document.querySelector('[data-iot-inspector] form').innerText");
  assert.match(inspector, /BME280/);
  assert.match(inspector, /1\.71/);
  await input('[data-iot-create-component] input[name="title"]', 'BME280 UI smoke');
  await click('[data-iot-create-component] button[type="submit"]');
  await waitState(`r.value.entities.some(e=>e.title==='BME280 UI smoke'&&e.type==='a3.iot.component')`);
  const saved = await load();
  const entity = saved.entities.find((item) => item.title === 'BME280 UI smoke');
  assert.ok(entity);
  assert.equal(entity.ports.length, 8);
  assert.equal(entity.properties['a3.iot.component'].catalogId, 'bosch.bme280');
  assert.deepEqual(entity.ports.find((port) => port.id === 'package.8').limits.voltage,
    { state: 'known', value: { min: 1.71, max: 3.6, unit: 'V' } });
  const placement = saved.placements.find((item) => item.entityId === entity.id);
  assert.ok(placement);
  assert.ok(saved.history.canUndo);
  const reopened = await load();
  assert.deepEqual(reopened.entities.find((item) => item.id === entity.id).ports.map((port) => port.id), entity.ports.map((port) => port.id));
  console.log('A3_IOT_SMOKE=' + JSON.stringify({ passed: true, checks: ['catalog inspector and known limits', 'host-mediated insertion', 'stable port identities', 'saved placement and history', 'persisted workspace reload'] }));
  win.close();
}

void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
