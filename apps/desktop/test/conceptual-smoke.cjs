const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));

async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(`RENDERER_CONSOLE[${level}]=${message}`); });
  win.webContents.on('render-process-gone', (_event, details) => console.error('RENDERER_GONE=' + JSON.stringify(details)));
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error('Renderer check: ' + source.slice(0, 200), { cause: error }); });
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(condition) {
    for (let i = 0; i < 240; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + condition + '\n' + await js("document.body.innerText.slice(-2200)"));
  }
  async function setInput(selector, value) {
    await js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  async function setSelect(selector, value) {
    await js(`(() => { const select=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(value)}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active;
  const load = async () => (await js(`window.a3.canvas({action:'load',sessionId:${JSON.stringify(project.sessionId)},workspaceId:${JSON.stringify(project.workspaces[0].id)}})`)).value;
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  const initialCanvas = await load(), initialVisualEdges = initialCanvas.visualEdges.map((edge) => edge.id);
  const createNode = async (kind, title) => {
    await js("document.querySelector('[data-conceptual-create]').open=true; undefined"); await setSelect('[data-conceptual-create] select[name="kind"]', kind);
    await setInput('[data-conceptual-create] input[name="title"]', title); await click('[data-conceptual-create-node]');
    await waitFor(`(async()=>{const s=await window.a3.canvas({action:'load',sessionId:${JSON.stringify(project.sessionId)},workspaceId:${JSON.stringify(project.workspaces[0].id)}});return s.ok&&s.value.entities.some(e=>e.title===${JSON.stringify(title)}&&e.type==='a3.conceptual.${kind}')})()`);
    const state = await load(), entity = state.entities.find((item) => item.title === title), placement = state.placements.find((item) => item.entityId === entity.id);
    assert.ok(entity && placement); assert.equal(entity.typeAvailable, true);
    await waitFor(`Boolean(document.querySelector('[data-entity-id="${entity.id}"][data-node-type="a3.conceptual.${kind}"]'))`);
    return { entity, placement };
  };
  const a = await createNode('concept', 'Idea A'), b = await createNode('idea', 'Idea B');
  const selectNode = async (entityId) => {
    await js(`document.querySelector('[data-entity-id="${entityId}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0})); undefined`);
    await waitFor(`document.querySelector('[data-conceptual-node-inspector] h3')?.textContent.includes(${JSON.stringify(entityId === a.entity.id ? 'Idea A' : 'Idea B')})`);
  };
  const createRelation = async (source, target, label, kind) => {
    await selectNode(source.entity.id);
    await setSelect('[data-conceptual-relation-create] select[name="target"]', target.placement.id);
    await setInput('[data-conceptual-relation-create] input[name="label"]', label);
    await setSelect('[data-conceptual-relation-create] select[name="kind"]', kind ?? '');
    await click('[data-conceptual-relation-create] button[type="submit"]');
    await waitFor(`(async()=>{const s=await window.a3.canvas({action:'load',sessionId:${JSON.stringify(project.sessionId)},workspaceId:${JSON.stringify(project.workspaces[0].id)}});return s.ok&&s.value.conceptualRelations.some(r=>r.label===${JSON.stringify(label)})})()`);
  };
  console.log('CONCEPTUAL_PHASE=inspector');
  await createRelation(b, a, 'provoca', 'cause'); await createRelation(a, b, 'devuelve', 'association');
  let canvas = await load();
  assert.equal(canvas.conceptualRelations.length, 2, 'the inspector accepts a directed cycle');
  assert.equal(canvas.visualEdges.some((edge) => canvas.conceptualRelations.some((relation) => relation.id === edge.id)), false,
    'semantic relations stay out of VisualEdge');
  await waitFor("document.querySelectorAll('[data-semantic-relation-id]').length===2");
  await selectNode(b.entity.id);
  await setInput(`[data-conceptual-relation="${canvas.conceptualRelations.find((item) => item.label === 'provoca').relationId}"] input[name="label"]`, 'conduce a');
  const relationForm = `[data-conceptual-relation="${canvas.conceptualRelations.find((item) => item.label === 'provoca').relationId}"]`;
  await click(`${relationForm} button[type="submit"]`);
  await waitFor(`(async()=>{const s=await window.a3.canvas({action:'load',sessionId:${JSON.stringify(project.sessionId)},workspaceId:${JSON.stringify(project.workspaces[0].id)}});return s.ok&&s.value.conceptualRelations.some(r=>r.label==='conduce a')})()`);
  const decisionForm = '[data-conceptual-node-inspector] > form';
  await setInput(`${decisionForm} input[name="title"]`, 'Decisión B'); await setSelect(`${decisionForm} select[name="kind"]`, 'decision');
  await click(`${decisionForm} button[type="submit"]`);
  await waitFor(`(async()=>{const s=await window.a3.canvas({action:'load',sessionId:${JSON.stringify(project.sessionId)},workspaceId:${JSON.stringify(project.workspaces[0].id)}});const e=s.value.entities.find(x=>x.id===${JSON.stringify(b.entity.id)});return e?.title==='Decisión B'&&e.type==='a3.conceptual.decision'})()`);
  canvas = await load(); assert.equal(canvas.conceptualRelations.length, 2); assert.deepEqual(canvas.visualEdges.map((edge) => edge.id), initialVisualEdges);
  console.log('A3_CONCEPTUAL_SMOKE=' + JSON.stringify({ passed: true, checks: ['typed concept and idea nodes through inspector', 'labelled categorized semantic links', 'cycle accepted', 'semantic edges render as RelationViews and remain distinct from VisualEdge', 'inspector edits node kind and relationship label'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
