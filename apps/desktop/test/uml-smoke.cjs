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
    for (let i = 0; i < 500; i++) { if (await js(condition)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + condition + '\n' + await js('document.body.innerText.slice(-2000)'));
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const input = (selector, value, select = false) => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}));})()`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  const loadExpression = `window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`;
  const load = async () => (await js(loadExpression)).value;
  const waitState = (expression) => waitFor(`(async()=>{const r=await ${loadExpression};return r.ok&&(${expression})})()`);
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  const initialVisualEdges = (await load()).visualEdges.map((e) => e.id), initialConceptualRelations = (await load()).conceptualRelations.map((e) => e.id);
  await js("document.querySelector('[data-uml-inspector]').open=true; undefined");
  async function create(kind, title, parentId = '') {
    const form = '[data-uml-create-element]'; await input(`${form} select[name="kind"]`, kind, true); await input(`${form} input[name="title"]`, title);
    await input(`${form} select[name="parentId"]`, parentId, true); await click(`${form} button`);
    await waitState(`r.value.uml.elements.some(e=>e.title===${JSON.stringify(title)})`);
    await waitFor(`document.querySelector('[data-uml-element-editor] h4')?.textContent.startsWith(${JSON.stringify(title)})`);
    return (await load()).uml.elements.find((e) => e.title === title);
  }
  const pack = await create('package', 'Paquete UI'), contract = await create('interface', 'Contrato UI', pack.id), status = await create('enum', 'Estado UI', pack.id);
  await input('[data-uml-add-literal] input[name="name"]', 'ACTIVO'); await input('[data-uml-add-literal] input[name="value"]', '1'); await click('[data-uml-add-literal] button');
  await waitState(`r.value.uml.elements.find(e=>e.id===${JSON.stringify(status.id)}).data.literals.length===1`);
  const model = await create('class', 'Modelo UI', pack.id);
  await input('[data-uml-add-attribute] input[name="name"]', 'estado'); await input('[data-uml-add-attribute] input[name="typeName"]', 'Estado UI');
  await input('[data-uml-add-attribute] select[name="typeEntityId"]', status.id, true); await input('[data-uml-add-attribute] select[name="visibility"]', 'private', true); await click('[data-uml-add-attribute] button');
  await waitState(`r.value.uml.elements.find(e=>e.id===${JSON.stringify(model.id)}).data.attributes.length===1`);
  await waitFor("Boolean(document.querySelector('[data-uml-attribute]'))");
  await input('[data-uml-add-method] input[name="name"]', 'cambiar'); await click('[data-uml-add-method] button');
  await waitState(`r.value.uml.elements.find(e=>e.id===${JSON.stringify(model.id)}).data.methods.length===1`);
  await waitFor("Boolean(document.querySelector('[data-uml-add-parameter]'))");
  await input('[data-uml-add-parameter] input[name="name"]', 'nuevo'); await input('[data-uml-add-parameter] select[name="typeEntityId"]', status.id, true); await click('[data-uml-add-parameter] button');
  await waitState(`r.value.uml.elements.find(e=>e.id===${JSON.stringify(model.id)}).data.methods[0].parameters.length===1`);
  let canvas = await load(); const source = canvas.placements.find((p) => p.entityId === model.id), target = canvas.placements.find((p) => p.entityId === contract.id);
  const form = '[data-uml-create-relationship]'; await input(`${form} select[name="kind"]`, 'realization', true);
  await input(`${form} select[name="source"]`, source.id, true); await input(`${form} select[name="target"]`, target.id, true);
  await input(`${form} input[name="label"]`, 'implementa'); await click(`${form} button`); await waitState("r.value.uml.relationViews.length===1");
  await waitFor("document.querySelectorAll('[data-uml-relationship]').length===1");
  await input('[data-uml-relationship] input[name="targetRole"]', 'contrato'); await click('[data-uml-relationship] button');
  await waitState("r.value.uml.relationViews[0].data.target.role==='contrato'");
  // Fit brings every native compartment and semantic edge into the culled viewport.
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Ajustar contenido')).click(); undefined");
  await waitFor("Boolean(document.querySelector('[data-uml-relation-kind=realization]'))");
  await waitFor("document.querySelectorAll('[data-uml-kind]').length===4");
  const rendered = await js("Array.from(document.querySelectorAll('[data-uml-kind=class]')).map(n=>n.textContent).join(' ')");
  assert.ok(rendered.includes('- estado: Estado UI')); assert.ok(rendered.includes('cambiar(in nuevo: Estado UI): void'));
  canvas = await load(); assert.equal(canvas.uml.elements.find((e) => e.id === model.id).data.parentId, pack.id);
  assert.equal(canvas.uml.elements.find((e) => e.id === model.id).data.methods[0].parameters[0].type.entityId, status.id);
  assert.equal(canvas.uml.relationViews[0].sourceEntityId, model.id); assert.equal(canvas.uml.relationViews[0].targetEntityId, contract.id);
  assert.deepEqual(canvas.visualEdges.map((e) => e.id), initialVisualEdges); assert.deepEqual(canvas.conceptualRelations.map((e) => e.id), initialConceptualRelations);
  console.log('A3_UML_SMOKE=' + JSON.stringify({ passed: true, checks: ['four UML types and package ownership', 'attribute type reference and visibility', 'method parameters', 'enum literals', 'semantic realization and role editing', 'native compartments and edge rendering'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
