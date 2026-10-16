const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
const created = new Promise((resolve) => app.once('browser-window-created', (_event, win) => resolve(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const js = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(condition) {
    for (let i = 0; i < 300; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + condition + '\n' + await js('document.body.innerText.slice(-2400)'));
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const input = (selector, value, select = false) => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}));})()`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active; const sessionId = project.sessionId; let ws = project.workspaces[0].id;
  const loadExpression = (workspaceId = ws) => `window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`;
  const load = async () => (await js(loadExpression())).value;
  const waitState = (expression) => waitFor(`(async()=>{const r=await ${loadExpression()};return r.ok&&(${expression})})()`);
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  const openInspector = () => js("document.querySelector('[data-c4-inspector]').open=true; undefined");
  await openInspector();
  async function create(category, title, parentId) {
    const form = '[data-c4-create-element]'; await input(`${form} select[name="type"]`, `a3.c4.${category}@1.0.0`, true);
    await waitFor(`document.querySelector('${form} select[name="type"]')?.value==='a3.c4.${category}@1.0.0'`);
    await input(`${form} input[name="title"]`, title); if (parentId) await input(`${form} select[name="parentId"]`, parentId, true);
    await click(`${form} button`); await waitState(`r.value.c4.elements.some(e=>e.title===${JSON.stringify(title)})`);
    return (await load()).c4.elements.find((e) => e.title === title);
  }
  const system = await create('software-system', 'Sistema UI'), person = await create('person', 'Persona UI');
  const container = await create('container', 'Contenedor UI', system.id);
  assert.equal(container.data.parentId, system.id);
  async function newView(kind, title) {
    const form = '[data-c4-view-form]'; await input(`${form} select[name="kind"]`, kind, true); await input(`${form} input[name="title"]`, title);
    await input(`${form} select[name="scope"]`, system.id, true); await click(`${form} button`);
    await waitState(`r.value.c4.views.some(v=>v.title===${JSON.stringify(title)})`);
    const view = (await load()).c4.views.find((v) => v.title === title);
    await js(`Array.from(document.querySelectorAll('[data-c4-inspector] nav button')).find(b=>b.textContent.startsWith(${JSON.stringify(title)})).click(); undefined`);
    ws = view.workspaceId; await waitFor(`document.querySelector('[data-c4-inspector] summary')?.textContent.includes(${JSON.stringify(title)})`); await openInspector(); return view;
  }
  const contextView = await newView('context', 'Contexto UI');
  async function reuse(entityId) {
    const form = '[data-c4-reuse-element]'; await input(`${form} select[name="entityId"]`, entityId, true); await click(`${form} button`);
    await waitState(`r.value.placements.some(p=>p.entityId===${JSON.stringify(entityId)})`);
  }
  await reuse(system.id); await reuse(person.id);
  let canvas = await load(), source = canvas.placements.find((p) => p.entityId === person.id), target = canvas.placements.find((p) => p.entityId === system.id);
  const form = '[data-c4-create-relationship]'; await input(`${form} select[name="source"]`, source.id, true); await input(`${form} select[name="target"]`, target.id, true);
  await input(`${form} input[name="description"]`, 'Usa el sistema'); await input(`${form} input[name="protocol"]`, 'HTTPS'); await click(`${form} button`);
  await waitState("r.value.c4.relationViews.some(v=>v.description==='Usa el sistema')"); await waitFor("document.querySelectorAll('[data-c4-relation-id]').length===1");
  canvas = await load(); const relationship = canvas.c4.relationViews[0];
  await newView('dynamic', 'Dinámica UI'); await reuse(person.id); await reuse(system.id); canvas = await load();
  source = canvas.placements.find((p) => p.entityId === person.id); target = canvas.placements.find((p) => p.entityId === system.id);
  const reuseForm = '[data-c4-reuse-relationship]'; await input(`${reuseForm} select[name="relationId"]`, relationship.relationId, true);
  await input(`${reuseForm} select[name="source"]`, source.id, true); await input(`${reuseForm} select[name="target"]`, target.id, true); await click(`${reuseForm} button`);
  await waitState('r.value.c4.relationViews.length===1');
  await click('[data-c4-add-step] button'); await waitState('r.value.c4.current.data.steps.length===1');
  await click('[data-c4-add-step] button'); await waitState('r.value.c4.current.data.steps.length===2');
  await waitFor("document.querySelectorAll('[data-c4-step-order]').length===2");
  const before = (await load()).c4.current.data.steps; await click('[data-c4-step] button[aria-label="Bajar paso 1"]');
  await waitState(`r.value.c4.current.data.steps[0].id===${JSON.stringify(before[1].id)}`);
  canvas = await load(); assert.equal(canvas.visualEdges.length, 0); assert.equal(canvas.c4.current.data.steps[0].order, 1);
  assert.equal(canvas.c4.elements.find((e) => e.id === container.id).data.parentId, system.id);
  const originalView = (await js(loadExpression(contextView.workspaceId))).value;
  assert.ok(originalView.placements.some((p) => p.entityId === system.id)); assert.equal(originalView.c4.relationViews[0].relationId, relationship.relationId);
  console.log('A3_C4_SMOKE=' + JSON.stringify({ passed: true, checks: ['typed C4 properties and containment', 'create and navigate context/dynamic views', 'reuse canonical element and relationship IDs', 'C4 edges distinct from VisualEdge', 'ordered repeated dynamic steps and reorder'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
