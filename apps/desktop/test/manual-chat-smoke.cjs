const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, webContents } = require('electron');
const [entry, profileDirectory, root, second] = process.argv.slice(2);
const partition = 'persist:a3-manual-chatgpt-v1', handlers = new Map(), external = [], permissionMessages = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
process.on('uncaughtExceptionMonitor', (error) => console.error('MANUAL_CHAT_UNCAUGHT', error.stack));
const copiedTexts = []; clipboard.writeText = (text) => { copiedTexts.push(text); };
ipcMain.handle = (channel, listener) => { handlers.set(channel, listener); originalHandle(channel, listener); };
app.setPath('userData', profileDirectory); app.commandLine.appendSwitch('use-fake-device-for-media-stream'); BrowserWindow.prototype.show = function () {};
let allowClose = true, allowMedia = false, allowExternal = true, allowPopup = false, folder = root, downloadOptions, allowDownload = false;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
dialog.showMessageBox = async (_window, options) => {
  if (options.title === 'A3 · Permiso del sitio') { permissionMessages.push(options.message); return { response: allowMedia ? 1 : 0 }; }
  if (options.message.startsWith('Abrir externamente')) return { response: allowExternal ? 1 : 0 };
  if (options.message.includes('solicita abrir')) return { response: allowPopup ? 1 : 0 };
  return { response: allowClose ? 1 : 0 };
};
dialog.showMessageBoxSync = () => 0;
dialog.showSaveDialogSync = (_window, options) => { downloadOptions = options; return allowDownload ? resolve(root, '../a3-fixture.txt') : undefined; };
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(3); };
shell.openExternal = async (url) => { external.push(url); };
const html = readFileSync(resolve(__dirname, '../../../fixtures/e5/manual-chat/provider.html'), 'utf8');
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
let remoteProfile, permissionRequest, permissionCheck;
const ready = app.whenReady().then(() => {
  remoteProfile = session.fromPartition(partition);
  const requestHandler = remoteProfile.setPermissionRequestHandler.bind(remoteProfile), checkHandler = remoteProfile.setPermissionCheckHandler.bind(remoteProfile);
  remoteProfile.setPermissionRequestHandler = (handler) => { permissionRequest = handler; requestHandler(handler); };
  remoteProfile.setPermissionCheckHandler = (handler) => { permissionCheck = handler; checkHandler(handler); };
  remoteProfile.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/fail-login') throw new Error('Synthetic provider failure');
    if (url.pathname === '/download') return new Response('synthetic download\n', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="a3-fixture.txt"' } });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
});
async function run() {
  const win = await created; await ready; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  async function waitFor(expression) { for (let i = 0; i < 500; i++) { if (await js(expression)) return; await new Promise((accept) => setTimeout(accept, 40)); } throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText.slice(-4500)')); }
  async function until(predicate, label) { for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise((accept) => setTimeout(accept, 40)); } throw new Error('Timed out: ' + label); }
  async function set(selector, value) { await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input',{bubbles:true})); })()`); }
  const request = (input) => js(`window.a3.manualChat(${JSON.stringify(input)})`);
  const remotes = () => webContents.getAllWebContents().filter((contents) => contents.session === remoteProfile && !contents.isDestroyed());
  await waitFor("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await waitFor("Boolean(document.querySelector('[data-active-project]'))");
  const active = (await js("window.a3.projects({action:'list'})")).value.active, sessionId = active.sessionId;
  await click('[data-section="prompts"]'); await waitFor("Boolean(document.querySelector('[aria-label=\"Ejemplo de plantilla\"]'))");
  await set('[aria-label="Ejemplo de plantilla"]', 'manual'); await waitFor("Boolean(document.querySelector('[aria-label=\"Plantilla Markdown\"]'))");
  await set('[aria-label="Plantilla Markdown"]', '# Prompt preparado por una persona'); await set('[aria-label="Variables obligatorias"]', '');
  await waitFor("!document.querySelector('button.primary').disabled"); await click('button.primary'); await waitFor("Boolean(document.querySelector('[aria-label=\"Vista previa exportable\"]'))");
  const compiled = await js("document.querySelector('[aria-label=\"Vista previa exportable\"]').value");
  await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='Copiar parte').click()"); await until(() => copiedTexts.length === 1, 'manual prompt copy'); assert.equal(copiedTexts[0], compiled);
  await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='Abrir ChatGPT manual').click()"); await waitFor("document.querySelectorAll('[data-chat-tab]').length===1");
  await until(() => remotes().length === 1 && !remotes()[0].isLoading() && remotes()[0].getURL() === 'https://chatgpt.com/', 'initial fixture');
  const first = remotes()[0], firstState = (await request({ action: 'state', sessionId })).value, tabId = firstState.activeTabId;
  await until(() => win.contentView.children.some((view) => view.webContents === first), 'view attached');
  const preferences = first.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.nodeIntegrationInWorker, false); assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true); assert.equal(preferences.webviewTag, false); assert.ok(!preferences.preload);
  assert.notEqual(first.getOSProcessId(), win.webContents.getOSProcessId());
  const probe = await first.executeJavaScript(`window.a3IsolationProbe(${JSON.stringify(pathToFileURL(join(root, 'pages/readme.md')).href)})`);
  assert.deepEqual(probe, { require: 'undefined', process: 'undefined', a3: 'undefined', ipcRenderer: 'undefined', bridge: false, fileReadable: false, shellReadable: false });
  // Invoke actual installed guards with the real untrusted sender/frame; no remote IPC is exposed to do this itself.
  for (const channel of ['a3.projects:command', 'a3.files:command', 'a3.markdown:document', 'a3.planning:command', 'a3.manual-chat:command']) {
    const response = await handlers.get(channel)({ sender: first, senderFrame: first.mainFrame }, { action: 'list', sessionId }); assert.equal(response.ok, false, channel); assert.equal(response.error.code, 'PERMISSION_DENIED');
    const spoofFrame = await handlers.get(channel)({ sender: win.webContents, senderFrame: first.mainFrame }, { action: 'list', sessionId }); assert.equal(spoofFrame.ok, false);
  }
  assert.equal((await request({ action: 'navigate', sessionId, tabId, url: pathToFileURL(join(root, 'a3.project.json')).href })).ok, false);
  assert.equal((await request({ action: 'navigate', sessionId, tabId, url: 'a3://desktop/index.html' })).ok, false);
  assert.equal((await request({ action: 'navigate', sessionId, tabId, url: 'http://127.0.0.1:1/' })).ok, false);
  assert.equal((await request({ action: 'state', sessionId, script: 'require("fs")' })).ok, false);
  assert.equal((await request({ action: 'copy-text', sessionId, text: 'Texto elegido para copiar' })).ok, true); assert.equal(copiedTexts.at(-1), 'Texto elegido para copiar');
  assert.equal(await first.executeJavaScript("document.querySelector('#prompt').value"), '', 'copy does not paste or send');
  await first.executeJavaScript("document.querySelector('#prompt').value='Texto manual sin memoria A3'; document.querySelector('#send').click()");
  assert.match(await first.executeJavaScript("document.querySelector('#response').textContent"), /Respuesta sintética/);
  await click('[data-section="memory"]'); await until(() => !win.contentView.children.some((view) => view.webContents === first), 'hidden remote view');
  await click('[data-section="chat"]'); await waitFor("document.querySelectorAll('[data-chat-tab]').length===1"); await until(() => win.contentView.children.some((view) => view.webContents === first), 'restored remote view');
  assert.equal(await first.executeJavaScript("document.querySelector('#prompt').value"), 'Texto manual sin memoria A3');
  await click('[aria-controls="activity"]'); await until(() => !win.contentView.children.some((view) => view.webContents === first), 'local overlay hides native web view');
  await click('[aria-controls="activity"]'); await until(() => win.contentView.children.some((view) => view.webContents === first), 'local overlay dismissed');
  assert.equal(await first.executeJavaScript("document.querySelector('#prompt').value"), 'Texto manual sin memoria A3');
  const bounds = win.contentView.children.find((view) => view.webContents === first).getBounds(); assert.ok(bounds.width > 50 && bounds.height > 20);
  win.setSize(1100, 740); await until(async () => { const next = win.contentView.children.find((view) => view.webContents === first)?.getBounds(); return !!next && next.width !== bounds.width; }, 'resize placement');
  await request({ action: 'navigate', sessionId, tabId, url: 'https://chatgpt.com/second' }); await until(() => !first.isLoading() && first.getURL().endsWith('/second'), 'second page');
  await waitFor("!document.querySelector('[data-chat-back]').disabled"); await click('[data-chat-back]'); await until(() => first.getURL() === 'https://chatgpt.com/', 'back');
  await waitFor("!document.querySelector('[data-chat-forward]').disabled"); await click('[data-chat-forward]'); await until(() => first.getURL().endsWith('/second'), 'forward');
  await click('[data-chat-reload]'); await until(() => !first.isLoading() && first.getURL().endsWith('/second'), 'reload');
  await remoteProfile.cookies.set({ url: 'https://chatgpt.com', name: 'a3-test-session', value: 'synthetic', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await win.webContents.session.cookies.get({ name: 'a3-test-session' })).length, 0);
  assert.ok(remoteProfile.getStoragePath().toLowerCase().startsWith(profileDirectory.toLowerCase())); assert.ok(!remoteProfile.getStoragePath().toLowerCase().startsWith(root.toLowerCase()));
  // Fake devices keep this test away from real microphones/cameras.
  assert.equal(await first.executeJavaScript("navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return true},()=>false)"), false);
  allowMedia = true;
  assert.equal(await first.executeJavaScript("navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return true},()=>false)"), true);
  assert.ok(permissionMessages.every((message) => message.startsWith('https://chatgpt.com')));
  assert.equal(permissionCheck(first, 'media', 'https://other.example', { isMainFrame: true, mediaType: 'audio' }), false);
  assert.equal(permissionCheck(first, 'fileSystem', 'https://chatgpt.com', { isMainFrame: true, filePath: root }), false);
  assert.equal(await new Promise((accept) => permissionRequest(first, 'media', accept, { isMainFrame: false, requestingUrl: 'https://other.example/', mediaTypes: ['audio'] })), false);
  await request({ action: 'revoke', sessionId, tabId }); await until(() => !first.isLoading(), 'revoke reload');
  assert.equal((await request({ action: 'state', sessionId })).value.tabs[0].permissions.audio, false);
  const count = remotes().length; await first.executeJavaScript("window.open('https://auth.example/login'); undefined"); await new Promise((accept) => setTimeout(accept, 80)); assert.equal(remotes().length, count);
  allowPopup = true; await first.executeJavaScript("window.open('https://auth.example/login'); undefined"); await until(() => remotes().length === 2, 'isolated popup');
  const login = remotes().find((contents) => contents !== first); await until(() => !login.isLoading(), 'popup fixture'); assert.ok(!login.getLastWebPreferences().preload);
  let state = (await request({ action: 'state', sessionId })).value; const loginId = state.activeTabId;
  allowClose = false; await request({ action: 'close', sessionId, tabId: loginId }); assert.equal(remotes().length, 2);
  allowClose = true; await request({ action: 'close', sessionId, tabId: loginId }); assert.equal(remotes().length, 1);
  await until(() => win.contentView.children.some((view) => view.webContents === first), 'first selected');
  await request({ action: 'navigate', sessionId, tabId, url: 'https://chatgpt.com/fail-login' }); await until(async () => (await request({ action: 'state', sessionId })).value.tabs[0].error.includes('cargar'), 'login failure');
  allowExternal = false; await request({ action: 'external', sessionId, tabId }); assert.equal(external.length, 0);
  allowExternal = true; await request({ action: 'external', sessionId, tabId }); assert.equal(external.at(-1), 'https://chatgpt.com/fail-login');
  await request({ action: 'navigate', sessionId, tabId, url: 'https://chatgpt.com/' }); await until(() => !first.isLoading() && first.getURL() === 'https://chatgpt.com/', 'return to provider');
  first.downloadURL('https://chatgpt.com/download'); await until(async () => (await request({ action: 'state', sessionId })).value.notice.includes('Descarga bloqueada'), 'ungestured download rejected'); assert.equal(downloadOptions, undefined);
  await first.executeJavaScript("document.querySelector('#download').click()", true); await until(() => !!downloadOptions, 'download destination cancelled'); assert.equal(existsSync(resolve(root, '../a3-fixture.txt')), false);
  allowDownload = true; await first.executeJavaScript("document.querySelector('#download').click()", true); await until(() => existsSync(resolve(root, '../a3-fixture.txt')) && downloadOptions?.title.includes('https://chatgpt.com'), 'controlled download');
  await until(async () => (await request({ action: 'state', sessionId })).value.notice.includes('descarga guardada'), 'download completion'); assert.equal(readFileSync(resolve(root, '../a3-fixture.txt'), 'utf8'), 'synthetic download\n');
  first.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] }); await waitFor("document.activeElement.getAttribute('aria-label')==='URL del chat web'");
  // Switching projects cannot take a web draft or tab ID along, even though account cookies are host-local.
  await click('[data-section="projects"]'); allowClose = false; await click('[data-close-project]'); await waitFor("document.querySelector('[data-project-error]')?.textContent.includes('CANCELLED')"); assert.equal(remotes().length, 1);
  allowClose = true; folder = second; await click('[data-open-project]'); await waitFor("(async()=>{const result=await window.a3.projects({action:'list'});return result.ok&&result.value.active?.projectId==='00000000-0000-4000-8000-000000009999'})()");
  const next = (await js("window.a3.projects({action:'list'})")).value.active; assert.notEqual(next.sessionId, sessionId);
  assert.equal((await request({ action: 'state', sessionId })).error.code, 'STALE_SESSION'); assert.equal(remotes().length, 0);
  await click('[data-section="chat"]'); await waitFor("document.querySelectorAll('[data-chat-tab]').length===1");
  assert.equal((await request({ action: 'select', sessionId: next.sessionId, tabId })).ok, false);
  const last = remotes()[0]; await until(() => last && !last.isLoading(), 'second context'); assert.equal(await last.executeJavaScript("document.querySelector('#prompt').value"), '');
  await last.executeJavaScript("localStorage.setItem('a3-test','synthetic')"); await click('[data-chat-logout]'); await waitFor("document.querySelector('[data-chat-notice]')?.textContent.includes('Datos de sesión web local eliminados')");
  assert.equal(remotes().length, 0); assert.equal((await remoteProfile.cookies.get({ name: 'a3-test-session' })).length, 0);
  await click('[data-chat-new]'); await until(() => remotes().length === 1 && !remotes()[0].isLoading(), 'after logout'); assert.equal(await remotes()[0].executeJavaScript("localStorage.getItem('a3-test')"), null);
  remotes()[0].close({ waitForBeforeUnload: false }); await until(async () => (await request({ action: 'state', sessionId: next.sessionId })).value.tabs.length === 0, 'destroyed remote tab released');
  await click('[data-chat-new]'); await until(() => remotes().length === 1 && !remotes()[0].isLoading(), 'replace destroyed remote');
  console.log('A3_MANUAL_CHAT_SMOKE=' + JSON.stringify({ passed: true, checks: ['real WebContentsView without Node/preload/bridge', 'file and a3 fetch denied', 'installed IPC sender/frame guards', 'URL protocol guards', 'prompt copy and open via local UI without auto paste', 'manual fixture input/response', 'hidden tab draft preserved', 'local overlays hide remote view', 'bounds after resize', 'back/forward/reload', 'provider cookies outside project and shell', 'media grant/revoke and origin isolation with fake devices', 'isolated popup denied/approved', 'close cancellation', 'login failure and external fallback', 'download destination and no project import', 'keyboard escape to trusted URL', 'project switch cancellation and isolation', 'local logout clears cookies/storage'] }));
  win.close();
}
void run().catch((error) => { console.error(error); app.exit(2); }); require(entry);
