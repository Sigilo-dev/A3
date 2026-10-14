const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app, BaseWindow, WebContentsView, clipboard, ipcMain, session, shell } = require('electron');
const { pathToFileURL } = require('node:url');

const CHAT_URL = 'https://chatgpt.com/';
const TEST_MODE = process.argv.includes('--self-test');
const root = path.resolve(__dirname, '../../../..');
const UI_FILE = path.join(__dirname, 'ui.html');
const PROBE_FILE = path.join(__dirname, '..', 'fixtures', 'hostile.html');
const PROBE_SCRIPT = path.join(__dirname, '..', 'fixtures', 'probe.js');
const MAX_COPY_BYTES = 100_000;
let window;
let appView;
let chatView;
let chatSession;
let latestExternalURL = '';
let probeServer;
let probeURL = '';
const clipboardTrace = [];
const ephemeralUserData = process.env.A3_E0_B1_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'a3-e0-b1-'));
app.setPath('userData', ephemeralUserData);

function classifyTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'deny'; }
  if (url.protocol !== 'https:' || url.username || url.password) return 'deny';
  const host = url.hostname.toLowerCase();
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com')) {
    return 'inside';
  }
  return 'offer-external';
}

function isAppSender(event) {
  return Boolean(appView && event.sender === appView.webContents);
}

function reportStatus(status, detail = '') {
  if (appView && !appView.webContents.isDestroyed()) {
    appView.webContents.send('chat:status', { status, detail });
  }
}

function offerExternal(raw) {
  if (classifyTarget(raw) !== 'offer-external') {
    reportStatus('blocked', 'Solo se permiten enlaces HTTPS externos.');
    return;
  }
  latestExternalURL = raw;
  appView.webContents.send('chat:external-link', { url: raw });
}

function setRemoteNavigationGuards() {
  const allowProbe = (raw) => {
    if (!TEST_MODE || !probeURL) return false;
    try { return new URL(raw).origin === new URL(probeURL).origin; } catch { return false; }
  };
  chatView.webContents.on('will-navigate', (event, raw) => {
    const result = classifyTarget(raw);
    if (result === 'inside' || allowProbe(raw)) return;
    event.preventDefault();
    if (result === 'offer-external') offerExternal(raw);
    else reportStatus('blocked', 'Navegación no permitida.');
  });
  chatView.webContents.on('will-redirect', (event, raw) => {
    const result = classifyTarget(raw);
    if (result === 'inside' || allowProbe(raw)) return;
    event.preventDefault();
    if (result === 'offer-external') offerExternal(raw);
    else reportStatus('blocked', 'Redirección no permitida.');
  });
  chatView.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyTarget(url) === 'offer-external') offerExternal(url);
    else if (classifyTarget(url) === 'deny') reportStatus('blocked', 'Ventana emergente no permitida.');
    // Popups never receive a WebContents. External links need a person to approve the button.
    return { action: 'deny' };
  });
  chatView.webContents.on('will-attach-webview', (event) => event.preventDefault());
  chatView.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reportStatus('error', `Error de carga ${code}: ${description}`);
  });
  chatView.webContents.on('did-start-loading', () => reportStatus('loading'));
  chatView.webContents.on('did-finish-load', () => reportStatus('ready'));
  chatView.webContents.on('did-navigate', updateNavigationState);
  chatView.webContents.on('did-navigate-in-page', updateNavigationState);
  chatView.webContents.session.on('will-download', (_event, item) => item.cancel());
}

function updateNavigationState() {
  if (!chatView || !appView || appView.webContents.isDestroyed()) return;
  const history = chatView.webContents.navigationHistory;
  appView.webContents.send('chat:navigation', {
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  });
}

async function startProbeServer() {
  probeServer = http.createServer((request, response) => {
    if (request.url === '/hostile.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self' file:" });
      response.end(fs.readFileSync(PROBE_FILE));
    } else if (request.url === '/probe.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(fs.readFileSync(PROBE_SCRIPT));
    } else if (request.url === '/second.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Local navigation fixture</title>');
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  probeURL = `http://127.0.0.1:${probeServer.address().port}/hostile.html`;
}

function setIpcContract() {
  ipcMain.handle('app:copy-text', async (event, value) => {
    if (!isAppSender(event)) throw new Error('sender denied');
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_COPY_BYTES) {
      throw new TypeError('clipboard payload rejected');
    }
    await clipboard.writeText(value);
    if (TEST_MODE) clipboardTrace.push({ characters: value.length, matchesClipboard: await clipboard.readText() === value });
    return { copied: true, characters: value.length };
  });
  ipcMain.handle('chat:retry', (event) => {
    if (!isAppSender(event)) throw new Error('sender denied');
    reportStatus('loading');
    return chatView.webContents.loadURL(CHAT_URL).catch((error) => ({ error: error.message }));
  });
  ipcMain.handle('chat:history', (event, direction) => {
    if (!isAppSender(event)) throw new Error('sender denied');
    const history = chatView.webContents.navigationHistory;
    if (direction === 'back' && history.canGoBack()) history.goBack();
    if (direction === 'forward' && history.canGoForward()) history.goForward();
    return { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() };
  });
  ipcMain.handle('app:open-external', async (event) => {
    if (!isAppSender(event)) throw new Error('sender denied');
    const target = latestExternalURL;
    latestExternalURL = '';
    if (!target || classifyTarget(target) !== 'offer-external') throw new Error('external URL unavailable');
    await shell.openExternal(target);
    return { opened: true };
  });
}

function makeWindow() {
  window = new BaseWindow({ width: 1180, height: 820, title: 'E0-B1 · Chat web manual', show: !TEST_MODE });
  appView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'app-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });
  chatView = new WebContentsView({
    webPreferences: {
      session: chatSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.contentView.addChildView(appView);
  window.contentView.addChildView(chatView);
  const resize = () => {
    const { width, height } = window.getContentBounds();
    const toolbarHeight = 212;
    appView.setBounds({ x: 0, y: 0, width, height: toolbarHeight });
    chatView.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) });
  };
  window.on('resize', resize);
  window.on('closed', () => {
    for (const view of [appView, chatView]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    appView = undefined;
    chatView = undefined;
  });
  resize();
  setRemoteNavigationGuards();
  appView.webContents.loadFile(UI_FILE);
}

async function waitFor(eventName, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
    const onFinish = () => finish({ outcome: 'loaded' });
    const onFailure = (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) finish({ outcome: 'failed', code, description, origin: safeOrigin(url) });
    };
    const finish = (result) => {
      clearTimeout(timer);
      chatView.webContents.removeListener(eventName, onFinish);
      chatView.webContents.removeListener('did-fail-load', onFailure);
      resolve(result);
    };
    chatView.webContents.once(eventName, onFinish);
    chatView.webContents.on('did-fail-load', onFailure);
  });
}

function safeOrigin(raw) {
  try { return new URL(raw).origin; } catch { return 'unavailable'; }
}

async function runSelfTest() {
  const result = { electron: process.versions.electron, checks: {} };
  await new Promise((resolve) => appView.webContents.once('did-finish-load', resolve));
  if (TEST_MODE) console.log('E0_B1_STEP=app-ui-ready');
  const localPreferences = appView.webContents.getLastWebPreferences();
  const remotePreferences = chatView.webContents.getLastWebPreferences();
  result.checks = {
    appRendererSandboxed: localPreferences.sandbox === true,
    appNodeDisabled: localPreferences.nodeIntegration === false,
    appContextIsolated: localPreferences.contextIsolation === true,
    remoteRendererSandboxed: remotePreferences.sandbox === true,
    remoteNodeDisabled: remotePreferences.nodeIntegration === false,
    remoteContextIsolated: remotePreferences.contextIsolation === true,
    remoteWebSecurityEnabled: remotePreferences.webSecurity === true,
    remoteHasNoPreload: !remotePreferences.preload,
    chatSessionIsEphemeral: !chatView.webContents.session.getStoragePath(),
  };

  await chatView.webContents.loadURL(probeURL);
  console.log('E0_B1_STEP=hostile-local-page-loaded');
  const projectFileURL = pathToFileURL(path.join(root, 'fixtures/e0/project/a3.project.json')).href;
  const probe = await chatView.webContents.executeJavaScript(`({
    node: typeof process !== 'undefined' || typeof require !== 'undefined',
    electron: typeof window.electron !== 'undefined' || typeof window.ipcRenderer !== 'undefined' || typeof window.require !== 'undefined',
    a3Bridge: typeof window.a3 !== 'undefined' || typeof window.a3Demo !== 'undefined',
  })`);
  result.checks.remoteFixtureCannotSeeNodeElectronOrA3 = !probe.node && !probe.electron && !probe.a3Bridge;
  result.checks.remoteCannotFetchProjectFile = await chatView.webContents.executeJavaScript(
    `window.tryProjectFile(${JSON.stringify(projectFileURL)})`,
  ).then((canRead) => canRead === false);
  console.log('E0_B1_STEP=project-file-probe-finished');
  result.fixtureProbe = probe;

  await chatView.webContents.loadURL(`${new URL(probeURL).origin}/second.html`);
  console.log('E0_B1_STEP=second-navigation-loaded');
  const history = chatView.webContents.navigationHistory;
  result.navigation = {
    canGoBack: history.canGoBack(),
    canGoForwardAfterBack: false,
    trustedChat: classifyTarget(CHAT_URL) === 'inside',
    trustedOpenAIAuth: classifyTarget('https://auth.openai.com/') === 'inside',
    externalHttpsOffered: classifyTarget('https://example.org/article') === 'offer-external',
    insecureSchemeDenied: classifyTarget('javascript:alert(1)') === 'deny',
    credentialsInURLDenied: classifyTarget('https://user:pass@chatgpt.com/') === 'deny',
  };
  const back = waitFor('did-finish-load', 5_000);
  history.goBack();
  result.navigation.canGoForwardAfterBack = (await back).outcome === 'loaded' && history.canGoForward();
  console.log('E0_B1_STEP=history-back-finished');
  await new Promise((resolve) => probeServer.close(resolve));

  const rendererFlow = await appView.webContents.executeJavaScript(`(async () => {
    const selected = document.querySelector('#selected-context');
    selected.value = 'contexto seleccionado desde A3';
    selected.focus(); selected.setSelectionRange(0, selected.value.length);
    document.querySelector('#copy-selection').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const selectionMessage = document.querySelector('#copy-result').textContent;
    document.querySelector('#prompt').value = 'Prompt manual de prueba';
    document.querySelector('#copy-prompt').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { selectionMessage, promptMessage: document.querySelector('#copy-result').textContent };
  })()`);
  result.copyFlow = {
    ...rendererFlow,
    selectedTextOnSystemClipboard: clipboardTrace[0]?.matchesClipboard === true,
    promptOnSystemClipboard: clipboardTrace[1]?.matchesClipboard === true,
    clipboardPayloadLengths: clipboardTrace.map(({ characters }) => characters),
  };
  appView.webContents.send('chat:status', { status: 'error', detail: 'Error de carga simulado' });
  result.checks.errorStateRendered = await appView.webContents.executeJavaScript(
    `new Promise((resolve) => setTimeout(() => resolve(document.querySelector('#chat-status').textContent.includes('Error de carga simulado')), 20))`,
  );
  reportStatus('loading');
  const publicLoad = waitFor('did-finish-load');
  try { await chatView.webContents.loadURL(CHAT_URL); }
  catch (error) { result.publicChat = { outcome: 'failed', description: error.message }; }
  if (!result.publicChat) result.publicChat = await publicLoad;
  result.publicChat.finalOrigin = safeOrigin(chatView.webContents.getURL());
  result.publicChat.finalURLRedacted = result.publicChat.finalOrigin;
  delete result.publicChat.origin;
  delete result.publicChat.finalOrigin;
  result.publicChat.userVisibleError = result.publicChat.outcome === 'failed' || result.publicChat.outcome === 'timeout';

  const expected = [
    'appRendererSandboxed','appNodeDisabled','appContextIsolated','remoteRendererSandboxed',
    'remoteNodeDisabled','remoteContextIsolated','remoteWebSecurityEnabled','remoteHasNoPreload','chatSessionIsEphemeral',
    'remoteFixtureCannotSeeNodeElectronOrA3','remoteCannotFetchProjectFile','errorStateRendered',
  ];
  const flowOK = result.copyFlow.selectedTextOnSystemClipboard
    && result.copyFlow.promptOnSystemClipboard
    && result.copyFlow.selectionMessage.toLowerCase().includes('copiado')
    && result.copyFlow.promptMessage.toLowerCase().includes('copiado');
  const navigationOK = Object.values(result.navigation).every(Boolean);
  result.pass = expected.every((key) => result.checks[key]) && flowOK && navigationOK;
  console.log(`E0_B1_RESULT=${JSON.stringify(result)}`);
  process.exitCode = result.pass ? 0 : 1;
  app.quit();
}

app.enableSandbox();
app.whenReady().then(async () => {
  chatSession = session.fromPartition('a3-e0-b1-memory-only');
  chatSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  chatSession.setPermissionCheckHandler(() => false);
  setIpcContract();
  if (TEST_MODE) await startProbeServer();
  makeWindow();
  if (TEST_MODE) runSelfTest().catch((error) => {
    console.error('E0_B1_FAILURE', error);
    process.exitCode = 1;
    app.quit();
  });
  else {
    reportStatus('loading');
    chatView.webContents.loadURL(CHAT_URL).catch((error) => reportStatus('error', error.message));
  }
});

app.on('window-all-closed', () => app.quit());

module.exports = { classifyTarget };
