const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message); }));
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(expression) {
    for (let i = 0; i < 600; i++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 50)); }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-4500)'));
  }
  async function set(selector, value) { await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input',{bubbles:true})); })()`); }
  const text = (expression) => js(`document.querySelector(${JSON.stringify(expression)})?.textContent`);
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active, E1 = '00000000-0000-4000-8000-000000000002', W1 = '00000000-0000-4000-8000-000000000006', W2 = '00000000-0000-4000-8000-000000000007';
  const request = (payload) => js(`window.a3.variables(${JSON.stringify({ ...payload, sessionId: active.sessionId })})`);
  assert.equal(await js('typeof require'), 'undefined');
  await click('[data-section="variables"]'); await waitFor("Boolean(document.querySelector('.variables-form')) && !document.querySelector('.variables-form').disabled");
  await set('[data-variable-name-input]', 'demo.name'); await set('[data-variable-value]', 'project label'); await waitFor("!document.querySelector('[data-variable-save]').disabled"); await click('[data-variable-save]');
  await waitFor("document.querySelector('[data-variable-name=" + '"demo.name"' + "]')?.textContent.includes('project label')");
  await set('[data-variable-workspace]', W1); await waitFor("!document.querySelector('[data-variable-save]').disabled"); await set('[data-variable-edit-scope]', 'workspace');
  await set('[data-variable-value]', 'workspace label'); await click('[data-variable-save]');
  await waitFor("document.querySelector('[data-variable-effective]')?.textContent.includes('workspace label')");
  await set('[data-variable-entity]', E1); await waitFor("Boolean(document.querySelector('[data-variable-bind]'))"); await set('[data-variable-binding-name]', 'demo.name'); await click('[data-variable-bind]');
  await waitFor("document.querySelector('[data-variable-field] code')?.textContent.includes('demo.name')");
  for (const [workspaceId, expected] of [[W1, 'workspace label'], [W2, 'project label']]) {
    const result = await js(`window.a3.canvas(${JSON.stringify({ action: 'load', sessionId: active.sessionId, workspaceId })})`); assert.equal(result.ok, true); assert.equal(result.value.entities.find((e) => e.id === E1).displayTitle, expected);
  }
  await set('[data-variable-workspace]', ''); await waitFor("document.querySelector('[data-variable-effective]')?.textContent.includes('variable-context-required')");
  await set('[data-variable-reference-scope]', 'project'); await waitFor("document.querySelector('[data-variable-effective]')?.textContent.includes('project label') && !document.querySelector('[data-variable-effective]').textContent.includes('variable-context-required')");
  await set('[data-variable-reference-scope]', 'context'); await set('[data-variable-edit-scope]', 'execution'); await set('[data-variable-value]', 'temporary only'); await click('[data-variable-save]');
  await waitFor("document.querySelector('[data-variable-effective]')?.textContent.includes('temporary only')");
  const fresh = await request({ action: 'load', query: {} }); assert.equal(fresh.value.effective.find((e) => e.name === 'demo.name').result.value.value, 'project label');
  await set('[data-variable-name-input]', 'demo.bad'); await set('[data-variable-type]', 'number'); await set('[data-variable-value]', '"wrong type"'); await click('[data-variable-save]');
  await waitFor("Boolean(document.querySelector('[data-variable-error]'))"); assert.match(await text('[data-variable-error]'), /incompatible|Tipo|inválid/i);
  assert.equal((await request({ action: 'set', input: { scope: { kind: 'execution' }, variables: [], expectedRevision: null }, query: {} })).ok, false);
  await click('[data-section="prompts"]'); await waitFor("Boolean(document.querySelector('[aria-label=\"Ejemplo de plantilla\"]')) && document.querySelector('[aria-label=\"Contexto workspace\"]')?.options.length > 1");
  await set('[aria-label="Ejemplo de plantilla"]', 'a3.iot-proposal');
  await set('#prompt-input-goal', 'Medir temperatura en ambiente'); await set('#prompt-input-components', 'ESP32 DevKit\nSensor de temperatura con referencia exacta'); await set('#prompt-input-board', 'ESP32 DevKit exacta');
  await waitFor("Boolean(document.querySelector('[aria-label=\"Categoría de contexto para Visión\"]'))");
  await set('[aria-label="Categoría de contexto para Visión"]', 'requirement');
  await click('[aria-label="Relaciones semánticas seleccionables"] li input[type=checkbox]');
  await click('button.primary'); await waitFor("Boolean(document.querySelector('[aria-label=\"Vista previa exportable\"]'))");
  assert.match(await js("document.querySelector('[aria-label=\"Vista previa exportable\"]').value"), /Propuesta IoT \(no verificada\)/);
  assert.match(await text('[aria-label="Manifiesto de fuentes incluidas"]'), /Visión|pages\/readme\.md/);
  assert.match(await text('[aria-label="Manifiesto de fuentes incluidas"]'), /a3\.core\.references/);
  assert.match(await text('.prompt-result'), /VisualEdge incluidos: 0/); assert.match(await text('.prompt-result'), /Trazabilidad local: guardada/);
  assert.equal(await js("document.querySelector('[data-auto-send-allowed]').dataset.autoSendAllowed"), 'true');
  await set('[aria-label="Ejemplo de plantilla"]', 'manual'); await waitFor("Boolean(document.querySelector('[aria-label=\"Plantilla Markdown\"]'))");
  await set('[aria-label="Contexto workspace"]', W1); await set('[aria-label="Plantilla Markdown"]', 'Usa {{demo.name}} y revisa {{demo.absent}}.');
  await set('[aria-label="Variables obligatorias"]', 'demo.absent'); await new Promise((accept) => setTimeout(accept, 100)); await click('button.primary');
  await waitFor("Boolean(document.querySelector('[aria-label=\"Vista previa exportable\"]'))");
  const compiled = await js("document.querySelector('[aria-label=\"Vista previa exportable\"]').value");
  assert.match(compiled, /workspace label/); assert.match(compiled, /A3: variable sin resolver demo\.absent/);
  assert.match(await js("document.body.innerText"), /Abrir ChatGPT no lo pega ni lo envía y no inicia un turno de Codex/);
  assert.equal(await js("document.querySelector('[data-auto-send-allowed]').dataset.autoSendAllowed"), 'false');
  await click('[data-section="canvas"]'); await waitFor("Boolean([...document.querySelectorAll('.canvas-entity-header strong')].find((e)=>e.textContent.includes('workspace label')))");
  await click('[data-section="variables"]'); await waitFor("document.querySelector('[data-variable-effective]')?.textContent.includes('project label')");
  assert.equal((await text('[data-variable-effective]')).includes('temporary only'), false);
  await js("document.querySelector('[data-variable-name-input]').focus()"); assert.equal(await js("document.activeElement.hasAttribute('data-variable-name-input')"), true);
  console.log('A3_VARIABLES_SMOKE=' + JSON.stringify({ passed: true, checks: ['project variable UI', 'workspace override', 'bound label in two views', 'explicit scope inspector', 'safe built-in IoT template preview', 'explicit requirement and relation context', 'source manifest and local provenance trace', 'visual edges excluded from context', 'derived prompt preview with required-variable gate', 'temporary execution is not persisted', 'invalid type feedback', 'strict IPC/no execution writes', 'keyboard focus', 'renderer without Node'] })); win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
