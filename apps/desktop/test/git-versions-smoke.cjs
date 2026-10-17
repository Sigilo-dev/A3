const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const [entry, profile, root, binary] = process.argv.slice(2);
app.setPath('userData', profile); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
const git = (...args) => execFileSync(binary, args, { cwd: root, windowsHide: true, encoding: 'utf8' });
async function run() {
  const win = await created; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(expression) { for (let i = 0; i < 700; i++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 40)); } throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-5000)')); }
  async function set(selector, value) { await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active;
  await click('[data-section="github"]'); await waitFor("document.querySelector('[data-git-state]')?.textContent === 'ready'");
  assert.equal(await js('typeof require'), 'undefined'); assert.equal(await js("document.querySelector('[data-git-root]').textContent"), root);
  assert.equal((await js(`window.a3.git(${JSON.stringify({ action: 'load', sessionId: active.sessionId, root: 'C:/other' })})`)).ok, false);
  await click('[aria-label="Seleccionar notes.md"]');
  await js("window.__gitDraft = (event) => event.preventDefault(); window.addEventListener('beforeunload', window.__gitDraft)"); await click('[data-git-stage]');
  await waitFor("document.querySelector('[data-git-error]')?.textContent.includes('sin guardar')");
  assert.equal(await js("Boolean(document.querySelector('.git-review'))"), false);
  await js("window.removeEventListener('beforeunload', window.__gitDraft); delete window.__gitDraft");
  await click('[data-git-stage]'); await waitFor("Boolean(document.querySelector('.git-review'))");
  assert.match(await js("document.querySelector('.git-review').textContent"), /changed notes/); assert.equal(git('diff', '--cached', '--name-only'), '');
  await click('[data-git-apply]'); await waitFor("!document.querySelector('.git-review') && document.querySelector('[data-git-notice]')?.textContent.includes('stage')");
  assert.equal(git('diff', '--cached', '--name-only'), 'notes.md\n');
  await waitFor("!document.querySelector('[data-git-commit]').matches(':disabled')");
  await set('[aria-label="Nombre del autor"]', 'A3 Fixture'); await set('[aria-label="Email del autor"]', 'fixture@example.invalid'); await set('[aria-label="Mensaje del commit"]', 'feat(notes): reviewed ui commit');
  const oldHead = git('rev-parse', 'HEAD'); await click('[data-git-commit]'); await waitFor("document.querySelector('#git-review-title')?.textContent === 'Revisar commit'");
  assert.equal(git('rev-parse', 'HEAD'), oldHead); await click('[data-git-apply]'); await waitFor("!document.querySelector('.git-review') && document.querySelector('[data-git-notice]')?.textContent.includes('commit')");
  await waitFor("Boolean(document.querySelector('[aria-label=\"Seleccionar other.md\"]')) && !document.querySelector('[aria-label=\"Seleccionar other.md\"]').matches(':disabled')"); await click('[aria-label="Seleccionar other.md"]');
  await waitFor("!document.querySelector('[data-git-restore]').matches(':disabled')"); await click('[data-git-restore]');
  await waitFor("document.querySelector('#git-review-title')?.textContent === 'Revisar restore'"); await click('[data-git-apply]'); await waitFor("Boolean(document.querySelector('[data-git-snapshot]')) && !document.querySelector('.git-review')");
  assert.equal(readFileSync(join(root, 'other.md'), 'utf8'), 'original other\n');
  await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent === 'Revisar retorno' && !button.matches(':disabled'))");
  await js("[...document.querySelectorAll('button')].find((button) => button.textContent === 'Revisar retorno').click()"); await waitFor("document.querySelector('#git-review-title')?.textContent === 'Revisar undo-restore'");
  await click('[data-git-apply]'); await waitFor("!document.querySelector('.git-review') && document.querySelector('[data-git-notice]')?.textContent.includes('undo-restore')");
  assert.equal(readFileSync(join(root, 'other.md'), 'utf8'), 'changed other\n');
  await waitFor("!document.querySelector('[aria-label=\"Nombre del autor\"]').matches(':disabled')");
  await js("document.querySelector('[aria-label=\"Nombre del autor\"]').focus()"); assert.equal(await js("document.activeElement.getAttribute('aria-label')"), 'Nombre del autor');
  assert.equal((await js(`window.a3.git(${JSON.stringify({ action: 'load', sessionId: '00000000-0000-4000-8000-000000000099' })})`)).ok, false);
  console.log('A3_GIT_SMOKE=' + JSON.stringify({ passed: true, checks: ['root and diff review', 'explicit partial selection', 'reviewed commit', 'restore and return snapshot', 'host draft veto', 'strict IPC and stale session', 'keyboard focus', 'renderer without Node'] })); win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
