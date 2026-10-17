const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(expression) { for (let i = 0; i < 600; i++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 50)); } throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-4500)')); }
  async function set(selector, value) { await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active;
  const request = (payload) => js(`window.a3.memorySearch(${JSON.stringify({ ...payload, sessionId: active.sessionId })})`);
  await click('[data-section="memory"]'); await waitFor("Boolean(document.querySelector('[data-memory-initialize]'))"); await click('[data-memory-initialize]');
  await waitFor("document.querySelectorAll('[data-memory-document]').length===3");
  let state = (await request({ action: 'memory' })).value; const overview = state.documents.find((item) => item.role === 'overview');
  const opened = await js(`window.a3.markdown(${JSON.stringify({ action: 'open', sessionId: active.sessionId, entityId: overview.entityId, resourceId: overview.resourceId })})`);
  assert.match(opened.value.content, /Memoriaandina original/);
  // The memory view opens the accepted focus/Markdown editor, sharing its resource identity.
  await click('[data-memory-document="overview"] [data-memory-edit]'); await waitFor("Boolean(document.querySelector('[data-markdown-source-mode]'))");
  const source = opened.value.content + 'memoriaeditada\r\n';
  const saved = await js(`window.a3.markdown(${JSON.stringify({ action: 'save', sessionId: active.sessionId, entityId: overview.entityId, resourceId: overview.resourceId, entityRevision: opened.value.entityRevision, expectedRevision: opened.value.revision, expectedHash: opened.value.hash, content: source })})`); assert.equal(saved.ok, true);
  await click('[data-section="memory"]'); await waitFor("document.querySelectorAll('[data-memory-document]').length===3");
  await js("[...document.querySelectorAll('summary')].find((element)=>element.textContent==='Guardar resumen explícito').click()");
  await set('[aria-label="Título del resumen"]', 'Resumen revisado'); await set('[aria-label="Markdown del resumen"]', '# Resumen\n\nContexto explícito memoriaandina.\n');
  await click('[aria-label="Fuente Visión general"]'); await click('[data-memory-summary]');
  await waitFor("Boolean(document.querySelector('[data-memory-document=\"summary\"] [aria-label=\"Procedencia del resumen\"]'))");
  assert.match(await js("document.querySelector('[aria-label=\"Procedencia del resumen\"]').textContent"), /SHA-256|Registrado|memory\/overview.md/);
  await click('[data-section="search"]'); await waitFor("Boolean(document.querySelector('[data-search-stats]')) && !document.querySelector('[data-search-submit]').matches(':disabled')");
  await set('[aria-label="Consulta de búsqueda"]', 'memoriaeditada'); await click('[data-search-submit]'); await waitFor("document.querySelectorAll('[data-search-hit]').length===1 && !document.querySelector('[data-search-submit]').matches(':disabled')");
  const first = (await request({ action: 'search', query: 'memoriaeditada', rebuild: false })).value;
  await click('[data-search-rebuild]'); await waitFor("!document.querySelector('[data-search-submit]').matches(':disabled')");
  const rebuilt = (await request({ action: 'search', query: 'memoriaeditada', rebuild: true })).value; assert.deepEqual(rebuilt.results, first.results);
  await set('[aria-label="Consulta de búsqueda"]', 'codigounico'); await click('[data-search-submit]'); await waitFor("document.querySelector('[data-search-hit] code')?.textContent==='src/main.ts' && !document.querySelector('[data-search-submit]').matches(':disabled')");
  await set('[aria-label="Consulta de búsqueda"]', 'secretovirtual'); await click('[data-search-submit]'); await waitFor("document.querySelectorAll('[data-search-hit]').length===0 && !document.querySelector('[data-search-submit]').matches(':disabled')");
  assert.equal((await request({ action: 'memory', path: root })).ok, false);
  await js("document.querySelector('[aria-label=\"Consulta de búsqueda\"]').focus()"); assert.equal(await js("document.activeElement.getAttribute('aria-label')"), 'Consulta de búsqueda'); assert.equal(await js('typeof require'), 'undefined');
  console.log('A3_MEMORY_SMOKE=' + JSON.stringify({ passed: true, checks: ['explicit memory initialization preserves existing source', 'Markdown focus by canonical IDs', 'explicit edit persisted', 'summary source/hash/date', 'local text and code search', 'rebuild equivalence', 'virtualenv exclusion', 'strict IPC', 'keyboard focus', 'renderer without Node'] })); win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
