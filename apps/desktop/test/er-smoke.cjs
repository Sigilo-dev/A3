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
  const check = (selector) => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});node.checked=true;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const project = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = project.sessionId, workspaceId = project.workspaces[0].id;
  const loadExpression = `window.a3.canvas({action:'load',sessionId:${JSON.stringify(sessionId)},workspaceId:${JSON.stringify(workspaceId)}})`;
  const load = async () => (await js(loadExpression)).value;
  const waitState = (expression) => waitFor(`(async()=>{const r=await ${loadExpression};return r.ok&&(${expression})})()`);
  await click('[data-section="canvas"]'); await waitFor("document.querySelector('[data-canvas-ready]')?.dataset.canvasReady==='true'");
  await js("document.querySelector('[data-er-inspector]').open=true; undefined");
  async function createTable(title) {
    await input('[data-er-create-table] input[name="title"]', title); await click('[data-er-create-table] button');
    await waitState(`r.value.er.elements.some(e=>e.title===${JSON.stringify(title)})`);
    await waitFor(`document.querySelector('[data-er-table-editor] h4')?.textContent.startsWith(${JSON.stringify(title)})`);
    return (await load()).er.elements.find((entry) => entry.title === title);
  }
  async function addField(name, type, configure) {
    const form = '[data-er-field="new"]'; await input(`${form} input[name="name"]`, name); await input(`${form} input[name="type"]`, type);
    if (configure) await configure(form); await click(`${form} button`);
  }
  const customer = await createTable('Customer UI');
  await addField('id', 'INTEGER', (form) => check(`${form} input[name="primaryKey"]`));
  await waitState(`r.value.er.elements.find(e=>e.id===${JSON.stringify(customer.id)}).data.fields.length===1`);
  const customerAfter = (await load()).er.elements.find((entry) => entry.id === customer.id), customerKey = customerAfter.data.fields[0];
  const order = await createTable('Order UI');
  await addField('id', 'INTEGER', (form) => check(`${form} input[name="primaryKey"]`));
  await waitState(`r.value.er.elements.find(e=>e.id===${JSON.stringify(order.id)}).data.fields.length===1`);
  await addField('customer_id', 'INTEGER', (form) => input(`${form} select[name="foreignKey"]`, `${customer.id}~${customerKey.id}`, true));
  await waitState(`r.value.er.elements.find(e=>e.id===${JSON.stringify(order.id)}).data.fields.length===2`);
  const canvas = await load(), source = canvas.placements.find((placement) => placement.entityId === customer.id), target = canvas.placements.find((placement) => placement.entityId === order.id);
  const relationForm = '[data-er-create-relationship]'; await input(`${relationForm} select[name="source"]`, source.id, true); await input(`${relationForm} select[name="target"]`, target.id, true);
  await input(`${relationForm} input[name="label"]`, 'places'); await input(`${relationForm} select[name="targetCardinality"]`, 'zero-or-many', true); await click(`${relationForm} button`);
  await waitState('r.value.er.relationViews.length===1');
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Ajustar contenido')).click(); undefined");
  await waitFor("Boolean(document.querySelector('[data-er-table-id] [data-er-field-id]'))");
  await waitFor("Boolean(document.querySelector('[data-er-relation-id]'))");
  const visible = await js("Array.from(document.querySelectorAll('[data-er-table-id]')).map(n=>n.innerText).join(' | ')");
  assert.ok(visible.includes('customer_id')); assert.ok(visible.includes('Customer UI.id'));
  const exported = await js("document.querySelector('[data-er-export] textarea')?.value || ''");
  assert.match(exported, /erDiagram/); assert.match(exported, /INTEGER id PK/); assert.match(exported, /INTEGER customer_id FK/); assert.match(exported, /\|\|\.\.o\{/);
  const reopened = (await js(loadExpression)).value; assert.equal(reopened.er.relationViews[0].data.targetCardinality, 'zero-or-many');
  assert.equal(reopened.er.elements.find((entry) => entry.id === order.id).data.fields[1].foreignKey.fieldId, customerKey.id);
  console.log('A3_ER_SMOKE=' + JSON.stringify({ passed: true, checks: ['table/field UI editing', 'primary and foreign keys by stable IDs', 'cardinality and native ER edge', 'Mermaid ER export', 'host-loaded persisted model'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); });
require(entry);
