const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, dialog, clipboard, shell } = require('electron');
const [entry, profile, root] = process.argv.slice(2), credential = 'github_pat_' + 'UIFIXTURE'.repeat(6);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
let allow = true, cleared = false, created = 0, opened = 0;
clipboard.readText = async () => credential; clipboard.clear = async () => { cleared = true; };
shell.openExternal = async (url) => { assert.equal(url, 'https://github.com/new'); opened++; };
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: allow ? 1 : 0 });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
// Fixture-only HTTP adapter, never a real account or network mutation.
global.fetch = async (url, options) => {
  assert.match(url, /^https:\/\/api\.github\.com\//); assert.equal(options.redirect, 'error');
  if (url.endsWith('/user')) return new Response(JSON.stringify({ id: 7001, login: 'a3-fixture' }));
  if (options.method === 'POST') { created++; assert.deepEqual(JSON.parse(options.body), { name: 'project', private: true, auto_init: false }); }
  return new Response(JSON.stringify({ id: 8001, full_name: 'a3-fixture/project', private: true, permissions: { push: true } }), { status: options.method === 'POST' ? 201 : 200 });
};
const createdWindow = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
async function run() {
  const win = await createdWindow; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source), clickText = (text) => js(`[...document.querySelectorAll('[data-github-panel] button')].find((item) => item.textContent === ${JSON.stringify(text)}).click(); undefined`);
  async function wait(expression) { for (let i = 0; i < 700; i++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 40)); } throw new Error(expression + '\n' + await js('document.body.innerText.slice(-4000)')); }
  async function set(label, value) { await js(`(() => { const input = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
  await wait("Boolean(document.querySelector('[data-open-project]'))"); await js("document.querySelector('[data-open-project]').click()");
  await wait("Boolean(document.querySelector('[data-active-project]'))"); const active = (await js("window.a3.projects({action:'list'})")).value.active;
  await js("document.querySelector('[data-section=github]').click()"); await wait("Boolean(document.querySelector('[data-github-panel]'))");
  assert.match(await js("document.querySelector('[data-github-panel]').textContent"), /No hay OAuth/);
  assert.equal((await js(`window.a3.github(${JSON.stringify({ action: 'status', sessionId: active.sessionId, token: credential })})`)).ok, false);
  await clickText('Consultar cuenta'); await wait("document.querySelector('[data-github-account]')?.textContent.includes('Sin autorización')");
  await wait("![...document.querySelectorAll('[data-github-panel] button')].find((item) => item.textContent === 'Conectar token desde portapapeles').disabled");
  await clickText('Conectar token desde portapapeles'); await wait("document.querySelector('[data-github-account]')?.textContent.includes('a3-fixture')"); assert.ok(cleared);
  const bytes = readFileSync(join(profile, 'github-authorization/credentials.bin')); assert.equal(bytes.includes(Buffer.from(credential)), false);
  await wait("!document.querySelector('[aria-label=\"URL GitHub HTTPS\"]').matches(':disabled')");
  await set('URL GitHub HTTPS', 'https://github.com/a3-fixture/project.git'); await clickText('Revisar push');
  await wait("document.querySelector('#github-review-title')?.textContent === 'Revisar push'");
  assert.match(await js("document.querySelector('[data-github-panel] .git-review').textContent"), /private/); assert.match(await js("document.querySelector('[data-github-panel] .git-review').textContent"), /\.a3\/local/);
  const denied = await js(`window.a3.github({action:'apply',sessionId:${JSON.stringify(active.sessionId)},token:document.querySelector('[data-github-panel] .git-review') ? '00000000-0000-4000-8000-000000000001' : '',confirmedUrl:'https://github.com/other/project.git'})`); assert.equal(denied.ok, false);
  await wait("!document.querySelector('[aria-label=\"Confirmar URL GitHub\"]').disabled");
  await set('Confirmar URL GitHub', 'https://github.com/other/project.git'); assert.equal(await js("document.querySelector('[data-github-apply]').disabled"), true);
  await clickText('Cancelar revisión o envío'); await wait("!document.querySelector('#github-review-title')"); assert.equal(created, 0);
  await clickText('Revisar creación de repositorio'); await wait("document.querySelector('#github-review-title')?.textContent === 'Revisar create'");
  await wait("!document.querySelector('[aria-label=\"Confirmar URL GitHub\"]').disabled"); await set('Confirmar URL GitHub', 'https://github.com/a3-fixture/project.git');
  allow = false; await js("document.querySelector('[data-github-apply]').click()"); await wait("document.querySelector('[data-github-error]')?.textContent.includes('cancelada')"); assert.equal(created, 0);
  allow = true; await clickText('Cancelar revisión o envío'); await wait("!document.querySelector('#github-review-title')");
  await clickText('Revisar creación de repositorio'); await wait("document.querySelector('#github-review-title')?.textContent === 'Revisar create'"); await wait("!document.querySelector('[aria-label=\"Confirmar URL GitHub\"]').disabled");
  await set('Confirmar URL GitHub', 'https://github.com/a3-fixture/project.git'); await js("document.querySelector('[data-github-apply]').click()"); await wait("document.querySelector('[data-github-notice]')?.textContent.includes('creado vacío')"); assert.equal(created, 1);
  await wait("![...document.querySelectorAll('[data-github-panel] button')].find((item) => item.textContent === 'Desconectar GitHub').disabled");
  await clickText('Desconectar GitHub'); await wait("document.querySelector('[data-github-notice]')?.textContent.includes('eliminada')"); assert.equal(existsSync(join(profile, 'github-authorization/credentials.bin')), false);
  await wait("![...document.querySelectorAll('[data-github-panel] button')].find((item) => item.textContent === 'Flujo externo manual').disabled"); await clickText('Flujo externo manual'); await wait('true');
  for (let i = 0; i < 30 && !opened; i++) await new Promise((accept) => setTimeout(accept, 40)); assert.equal(opened, 1);
  console.log('A3_GITHUB_SMOKE=' + JSON.stringify({ passed: true, checks: ['manual auth without OAuth', 'real DPAPI encrypted storage', 'host-only clipboard', 'account destination privacy branch exclusions', 'wrong destination blocked', 'cancel native confirmation', 'create separate from push', 'disconnect', 'external manual flow', 'no live network'] })); win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
