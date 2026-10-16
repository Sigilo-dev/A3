const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
const source = readFileSync(require('node:path').join(__dirname, '../../../fixtures/e3/plantuml/import-class.puml'), 'utf8');
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = async (code) => win.webContents.executeJavaScript(code);
  async function waitFor(condition) {
    for (let i = 0; i < 600; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${condition}\nbutton=${await js(`document.querySelector('${selector} [data-plantuml-import-preview]')?.outerHTML`)}\npreview=${await js(`document.querySelector('${selector} .mermaid-import-preview')?.outerHTML.slice(0,1200)`)}\n${await js('document.body.innerText.slice(-2400)')}`);
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  const current = await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`);
  assert.equal(current.ok, true);
  const inserted = await js(`window.a3.canvas({action:'create-content-node',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},expectedWorkspaceRevision:${current.value.revision},node:{kind:'plantuml',title:'PlantUML import fixture',position:{x:180,y:120},value:${JSON.stringify(source)}}})`);
  assert.equal(inserted.ok, true, inserted.error?.message);
  const entity = inserted.value.entities.find((item) => item.title === 'PlantUML import fixture');
  const selector = `[data-entity-id="${entity.id}"]`;
  await click('[data-canvas-fit]'); await waitFor(`Boolean(document.querySelector('${selector} [data-plantuml-import-preview]'))`);
  await click(`${selector} [data-plantuml-import-preview]`);
  await waitFor(`Boolean(document.querySelector('${selector} [data-import-mode="new"]'))`);
  const view = await js(`(() => {const p=document.querySelector('${selector} [data-import-mode="new"]');return {rows:p.querySelectorAll('[role="row"]').length,ids:p.querySelectorAll('details code').length,buttons:[...p.querySelectorAll('[data-plantuml-import-apply]')].map(b=>b.disabled)};})()`);
  assert.equal(view.rows, 19); assert.ok(view.ids >= 30); assert.deepEqual(view.buttons, [false, false]);
  const original = await js(`window.a3.canvas({action:'content',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},entityId:${JSON.stringify(entity.id)},resourceId:${JSON.stringify(entity.contentResourceId)},purpose:'preview'})`);
  assert.equal(original.ok, true); assert.equal(original.value.text, source);

  await click(`${selector} [data-plantuml-import-apply="a3-model"]`);
  await waitFor(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}}).then(r=>r.ok&&r.value.entities.find(e=>e.id===${JSON.stringify(entity.id)})?.properties['a3.diagram.authority']==='a3-model')`);
  await click(`${selector} [data-plantuml-import-preview]`);
  await waitFor(`Boolean(document.querySelector('${selector} [data-import-mode="update"]'))`);
  const update = await js(`(() => {const p=document.querySelector('${selector} [data-import-mode="update"]');return [...p.querySelectorAll('.mermaid-import-row:not(.mermaid-import-head) span:last-child')].map(e=>e.textContent);})()`);
  assert.equal(update.length, 18); assert.ok(update.every((action) => action === 'unchanged'));
  await click(`${selector} [data-plantuml-import-apply="source"]`);
  await waitFor(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}}).then(r=>r.ok&&r.value.entities.find(e=>e.id===${JSON.stringify(entity.id)})?.properties['a3.diagram.authority']==='source')`);
  const final = (await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`)).value;
  assert.equal(final.uml.elements.length, 12); assert.equal(final.uml.relationships.length, 6);
  assert.equal(await js(`document.querySelector('${selector} .plantuml-source-original pre')?.textContent`), source);
  console.log('A3_PLANTUML_IMPORT_SMOKE=' + JSON.stringify({ passed: true, checks: ['PlantUML class source node exposes converter UI', 'preview shows classifiers/relationships and stable ID mapping', 'explicit model authority switch keeps source bytes intact', 'existing mapping yields update diff with unchanged records', 'source authority can be retained explicitly'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
