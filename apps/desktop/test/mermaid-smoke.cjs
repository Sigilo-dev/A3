const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
const valid = readFileSync(require('node:path').join(__dirname, '../../../fixtures/e3/mermaid/flowchart.mmd'), 'utf8');
const invalid = readFileSync(require('node:path').join(__dirname, '../../../fixtures/e3/mermaid/invalid.mmd'), 'utf8');
const hostile = 'flowchart LR\n  A["<script>globalThis.__a3MermaidExecuted=true</script>"] --> B\n  click A "javascript:alert(1)" "unsafe"\n';
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = async (source) => {
    try { return await win.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`Renderer evaluation failed for ${source}: ${error instanceof Error ? error.message : error}`); }
  };
  async function waitFor(condition) {
    for (let i = 0; i < 600; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + condition + '\nstates=' + JSON.stringify(await js('Array.from(document.querySelectorAll("[data-content-renderer=\\"mermaid-source\\"]")).map(e=>({placement:e.closest(".canvas-entity-node")?.dataset.placementId,state:e.dataset.mermaidState,line:e.dataset.mermaidLine}))')) + '\n' + await js('document.querySelector("[data-node-type=\\"a3.diagram.mermaid\\"]")?.outerHTML.slice(0,1800)') + '\n' + await js('document.body.innerText.slice(-2400)'));
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  async function create(title, source, x, resourceId) {
    const current = await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`);
    assert.equal(current.ok, true);
    const sourceValue = resourceId ? `{resourceId:${JSON.stringify(resourceId)}}` : `{value:${JSON.stringify(source)}}`;
    const result = await js(`window.a3.canvas({action:'create-content-node',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},expectedWorkspaceRevision:${current.value.revision},node:{kind:'mermaid',title:${JSON.stringify(title)},position:{x:${x},y:120},${sourceValue.slice(1, -1)}}})`);
    assert.equal(result.ok, true, result.error?.message);
    const entity = result.value.entities.find((item) => item.id === result.value.placements.find((placement) => placement.id === result.value.selection?.placements?.[0]?.id)?.entityId) ??
      result.value.entities.find((item) => item.title === title);
    const placed = result.value.placements.find((placement) => placement.entityId === entity.id);
    return { entity, placement: placed };
  }
  const good = await create('Mermaid válido', valid, 100);
  assert.equal(good.entity.properties['a3.diagram.authority'], 'source');
  assert.equal(good.entity.properties['a3.diagram.renderer'], 'mermaid@12.2.0');
  const original = await js(`window.a3.canvas({action:'content',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)},entityId:${JSON.stringify(good.entity.id)},resourceId:${JSON.stringify(good.entity.contentResourceId)},purpose:'preview'})`);
  assert.equal(original.ok, true); assert.equal(original.value.text, valid);
  const reference = await create('Recurso fuente existente', null, 300, good.entity.contentResourceId);
  assert.notEqual(reference.entity.id, good.entity.id); assert.equal(reference.entity.contentResourceId, good.entity.contentResourceId);
  const bad = await create('Mermaid inválido', invalid, 500), unsafe = await create('Mermaid no ejecutable', hostile, 700);
  await click('[data-canvas-fit]');
  const contentForTitle = (title) => `Array.from(document.querySelectorAll('[data-node-type="a3.diagram.mermaid"]')).find(n=>n.querySelector('.canvas-entity-header strong')?.textContent.startsWith(${JSON.stringify(title)}))?.querySelector('[data-content-renderer="mermaid-source"]')`;
  await waitFor(`${contentForTitle('Mermaid válido')}?.dataset.mermaidState==='rendered'`);
  await waitFor(`${contentForTitle('Recurso fuente existente')}?.dataset.mermaidState==='rendered'`);
  await waitFor(`${contentForTitle('Mermaid inválido')}?.dataset.mermaidState==='invalid'`);
  await waitFor(`${contentForTitle('Mermaid no ejecutable')}?.dataset.mermaidState==='rendered'`);
  const invalidNode = await js(`(() => { const n=${contentForTitle('Mermaid inválido')}; return {line:n?.dataset.mermaidLine, source:n?.querySelector('details pre')?.textContent}; })()`);
  assert.equal(invalidNode.line, '2'); assert.equal(invalidNode.source, invalid);
  const safeOutput = await js(`(() => {const n=${contentForTitle('Mermaid no ejecutable')};return {script:n.querySelector('script,foreignObject,iframe,object,embed,image'),events:[...n.querySelectorAll('*')].flatMap(e=>[...e.attributes].filter(a=>/^on/i.test(a.name)).map(a=>a.name)),href:[...n.querySelectorAll('*')].flatMap(e=>[...e.attributes].filter(a=>/^(?:xlink:)?href$/i.test(a.name)).map(a=>a.value)),executed:globalThis.__a3MermaidExecuted===true};})()`);
  assert.deepEqual(safeOutput, { script: null, events: [], href: [], executed: false });
  const goodNode = `[data-entity-id="${good.entity.id}"]`;
  await click(`${goodNode} [data-mermaid-import-preview]`);
  await waitFor(`Boolean(document.querySelector('${goodNode} [data-import-mode="new"]'))`);
  const importView = await js(`(() => { const n=document.querySelector('${goodNode} [data-import-mode="new"]'); return { rows:n.querySelectorAll('[role="row"]').length, ids:n.querySelectorAll('details code').length, issues:n.querySelector('.mermaid-import-issues')?.innerText ?? '', applyDisabled:n.querySelector('[data-mermaid-import-apply="a3-model"]')?.disabled }; })()`);
  assert.ok(importView.rows > 1); assert.ok(importView.ids > 0); assert.ok(importView.issues.includes('Línea')); assert.equal(importView.applyDisabled, false);
  await click(`${goodNode} [data-mermaid-import-apply="a3-model"]`);
  await waitFor(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}}).then(r=>r.ok&&r.value.entities.find(e=>e.id===${JSON.stringify(good.entity.id)})?.properties['a3.diagram.authority']==='a3-model')`);
  await waitFor(`document.querySelector('${goodNode} .mermaid-source-original pre')?.textContent===${JSON.stringify(valid)}`);
  await click(`${goodNode} [data-mermaid-import-preview]`);
  await waitFor(`Boolean(document.querySelector('${goodNode} [data-import-mode="update"]'))`);
  const updatePreview = await js(`(() => {const n=document.querySelector('${goodNode} [data-import-mode="update"]');return {actions:[...n.querySelectorAll('.mermaid-import-row:not(.mermaid-import-head) span:last-child')].map(e=>e.textContent),source:document.querySelector('${goodNode} .mermaid-source-original pre')?.textContent};})()`);
  assert.ok(updatePreview.actions.every((action) => action === 'unchanged')); assert.equal(updatePreview.source, valid);
  await click(`${goodNode} [data-mermaid-import-apply="source"]`);
  await waitFor(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}}).then(r=>r.ok&&r.value.entities.find(e=>e.id===${JSON.stringify(good.entity.id)})?.properties['a3.diagram.authority']==='source')`);
  const after = (await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`)).value;
  assert.equal(after.entities.find((item) => item.id === good.entity.id).properties['a3.diagram.authority'], 'source');
  assert.equal(after.entities.find((item) => item.id === bad.entity.id).contentResourceId, bad.entity.contentResourceId);
  assert.equal(after.entities.find((item) => item.id === reference.entity.id).contentResourceId, good.entity.contentResourceId);
  console.log('A3_MERMAID_SMOKE=' + JSON.stringify({ passed: true, checks: ['source authority and fixed Mermaid version', 'full source preserved byte-for-byte as UTF-8 text', 'valid and shared-resource sources rendered', 'invalid source reports line 2 and keeps full original', 'HTML/script/click payload is inert and SVG sanitized', 'preview exposes IDs and partial diagnostics before apply', 'explicit authority switch and source-preserving mapped update'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
