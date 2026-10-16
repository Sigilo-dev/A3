const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
const source = readFileSync(require('node:path').join(__dirname, '../../../fixtures/e3/structurizr/static-workspace.dsl'), 'utf8');
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = async (code) => win.webContents.executeJavaScript(code);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(condition, description = condition) {
    for (let index = 0; index < 600; index += 1) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`Timed out waiting for ${description}\n${await js('document.body.innerText.slice(-2600)')}`);
  }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]');
  await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  const current = await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`);
  assert.equal(current.ok, true);
  const inserted = await js(`window.a3.canvas({action:'create-content-node',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},expectedWorkspaceRevision:${current.value.revision},node:{kind:'structurizr-dsl',title:'Structurizr import fixture',position:{x:180,y:120},value:${JSON.stringify(source)}}})`);
  assert.equal(inserted.ok, true, inserted.error?.message);
  const entity = inserted.value.entities.find((item) => item.title === 'Structurizr import fixture'); assert.ok(entity);
  const selector = `[data-entity-id="${entity.id}"]`;
  await click('[data-canvas-fit]'); await waitFor(`Boolean(document.querySelector('${selector} [data-structurizr-import-preview]'))`);
  await click(`${selector} [data-structurizr-import-preview]`);
  await waitFor(`document.querySelectorAll('${selector} [data-structurizr-import-view]').length===2`, 'DSL static view preview');
  const preview = await js(`window.a3.canvas({action:'structurizr-import-preview',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},sourceEntityId:${JSON.stringify(entity.id)}})`);
  assert.equal(preview.ok, true); assert.equal(preview.value.canApply, true); assert.equal(preview.value.views.length, 2);
  assert.ok(preview.value.unconverted.some((item) => /dynamic/i.test(item.source)));
  const bytesBefore = await js(`window.a3.canvas({action:'content',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},entityId:${JSON.stringify(entity.id)},resourceId:${JSON.stringify(entity.contentResourceId)},purpose:'preview'})`);
  assert.equal(bytesBefore.ok, true); assert.equal(bytesBefore.value.text, source);
  const firstView = preview.value.views[0], secondView = preview.value.views[1];
  const firstWorkspaceId = await js(`document.querySelector('${selector} article[data-view-key="${firstView.key}"]')?.dataset.workspaceId`);
  await click(`${selector} [data-structurizr-import-view="${firstView.key}"]`);
  await waitFor(`document.querySelector('${selector} article[data-view-key="${firstView.key}"]')?.dataset.importAction==='update' && document.querySelector('${selector} [data-structurizr-import-view="${secondView.key}"]')?.disabled===false`, 'first imported view and refreshed diff');
  const context = await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(firstWorkspaceId)}})`);
  assert.equal(context.ok, true); assert.equal(context.value.c4.current.data.kind, 'context');
  const secondWorkspaceId = await js(`document.querySelector('${selector} article[data-view-key="${secondView.key}"]')?.dataset.workspaceId`);
  await click(`${selector} [data-structurizr-import-view="${secondView.key}"]`);
  await waitFor(`document.querySelector('${selector} article[data-view-key="${secondView.key}"]')?.dataset.importAction==='update'`, 'second imported view and refreshed diff');
  const containers = await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(secondWorkspaceId)}})`);
  const contexts = [context, containers];
  assert.deepEqual(contexts.map((result) => result.ok && result.value.c4.current.data.kind), ['context', 'containers']);
  const importedElements = contexts.map((result) => result.value.placements.map((placement) => placement.entityId).sort());
  assert.ok(importedElements[0].every((id) => importedElements[1].includes(id)), 'same elements retain IDs between imported views');
  const bytesAfter = await js(`window.a3.canvas({action:'content',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},entityId:${JSON.stringify(entity.id)},resourceId:${JSON.stringify(entity.contentResourceId)},purpose:'preview'})`);
  assert.equal(bytesAfter.ok, true); assert.equal(bytesAfter.value.text, source);
  console.log('A3_STRUCTURIZR_SMOKE=' + JSON.stringify({ passed: true, checks: ['DSL UI preview reports static and dynamic views', 'each static view imports through its own reversible command', 'second view uses refreshed source revision and stable element IDs', 'original DSL bytes remain intact'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
