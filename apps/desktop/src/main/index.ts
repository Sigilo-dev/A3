import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import { access } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { APP_INFO_CHANNEL, CANVAS_CHANNEL, CODE_CHANNEL, DROP_STAGE_CHANNEL, FILES_CHANNEL, GALLERY_CHANNEL, MARKDOWN_CHANNEL, PROJECTS_CHANNEL, type AppInfo, type ShellResult } from '../shared/desktop-api';
import { createProjectController } from './project-controller';
import { AV_CONVERSION_CHANNEL, IMAGE_CONVERSION_CHANNEL } from '../shared/desktop-api';
import { PLANTUML_ARTIFACT_FILE } from './plantuml-renderer';
import { WORKSPACE_SESSION_CHANNEL, NAVIGATION_CHANNEL } from '../shared/desktop-api';
import { VARIABLES_CHANNEL } from '../shared/desktop-api';
import { MEMORY_SEARCH_CHANNEL } from '../shared/memory-search';
import { PLANNING_CHANNEL } from '../shared/planning';
import { MANUAL_CHAT_CHANNEL } from '../shared/manual-chat';
import { ManualChatController } from './manual-chat';
import { CODEX_AUTH_CHANNEL } from '../shared/codex-auth';
import { CodexAuthorization } from './codex-authorization';
import { SystemCredentialVault } from './codex-credential-vault';
import { CodexAppServerProvider } from './codex-app-server';
import { CodexTurnHost } from './codex-turns';
import { digest as turnBindingHash } from './codex-turn-state';

const APP_URL = 'a3://desktop/index.html';
const editorStyleNonce = randomBytes(24).toString('base64');
const rendererRoot = join(__dirname, '../renderer');
const preloadPath = join(__dirname, '../preload/index.cjs');
let mainWindow: BrowserWindow | null = null;
let failed = false;
let quitting = false;
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let projects: ReturnType<typeof createProjectController> | undefined;
let closing = false;
let manualChat: ManualChatController | undefined;
let codexAuthorization: CodexAuthorization | undefined;
let codexTurns: CodexTurnHost | undefined;

async function finishQuit(): Promise<void> {
  if (closing || quitting) return;
  closing = true;
  try {
    // Ask the local renderer's unload guards before releasing the writer/session.
    // A cancelled exit must leave the open project usable for saving the draft.
    if (mainWindow && !mainWindow.webContents.isLoadingMainFrame()) {
      const hasDraft = await mainWindow.webContents.executeJavaScript("(async () => { const pending = []; window.dispatchEvent(new CustomEvent('a3:flush-session', { detail: pending })); await Promise.all(pending); return !window.dispatchEvent(new Event('beforeunload', { cancelable: true })); })()");
      if (hasDraft) {
        const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'A3 · Cambios sin guardar',
          message: 'Hay páginas o archivos con cambios sin guardar.', detail: 'Vuelve al editor para guardarlos o descártalos explícitamente antes de salir.',
          buttons: ['Volver al editor', 'Descartar y salir'], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response !== 1) return;
      }
    }
    if (manualChat && !await manualChat.confirmQuit()) return;
    await projects?.imageConversions.cancelAll();
    await projects?.avConversions.cancelAll();
    await codexTurns?.shutdown();
    await projects?.manager.shutdown();
    await codexAuthorization?.shutdown();
    manualChat?.dispose();
    quitting = true; clearTimeout(bootTimer); app.quit();
  } catch {
    dialog.showErrorBox('A3 · Proyecto abierto', 'No se cerró el proyecto. Revisa el estado de guardado o la recuperación pendiente antes de salir.');
  } finally { closing = false; }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'a3', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
app.enableSandbox();
app.setName('A3');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) { quitting = true; app.quit(); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

function fatalStartup(): void {
  if (failed || quitting) return;
  failed = true;
  clearTimeout(bootTimer);
  console.error('[a3] Desktop startup failed. Check the compiled renderer and preload.');
  dialog.showErrorBox('A3 no pudo iniciar',
    'La interfaz no pudo iniciarse de forma segura. Cierra A3 y vuelve a intentarlo. ' +
    'En desarrollo, ejecuta npm run build antes de npm start.');
  app.exit(1);
}

function rendererURL(): string {
  const candidate = !app.isPackaged && process.env.ELECTRON_RENDERER_URL;
  if (!candidate) return APP_URL;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Only the local development server is allowed.');
  }
  return url.href;
}

function isShellDocument(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate);
    const allowed = new URL(expected);
    return actual.protocol === allowed.protocol && actual.host === allowed.host &&
      actual.pathname === allowed.pathname && actual.search === allowed.search &&
      !actual.username && !actual.password;
  } catch { return false; }
}

function csp(development: boolean): string {
  return "default-src 'self'; " +
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}; ` +
    `style-src 'self'${development ? " 'unsafe-inline'" : ` 'nonce-${editorStyleNonce}'`}; ` +
    `connect-src ${development ? "'self' ws://127.0.0.1:* ws://localhost:*" : "'none'"}; ` +
    "img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
}

async function startDesktop(): Promise<void> {
  const url = rendererURL();
  const development = url !== APP_URL;
  await access(preloadPath);
  if (!development) await access(join(rendererRoot, 'index.html'));
  const plantumlArtifactPath = app.isPackaged
    ? join(process.resourcesPath, 'plantuml', PLANTUML_ARTIFACT_FILE)
    : join(app.getAppPath(), 'resources', 'plantuml', PLANTUML_ARTIFACT_FILE);
  projects = createProjectController(app.getPath('userData'), () => mainWindow, plantumlArtifactPath);
  manualChat = new ManualChatController(() => mainWindow, async () => (await projects?.manager.getState())?.active?.sessionId ?? null);
  codexAuthorization = new CodexAuthorization({ vault: new SystemCredentialVault(app.getPath('userData'), safeStorage), openBrowser: (url) => shell.openExternal(url) });
  // The app-server adapter is host-only and starts only after an explicit provider action.
  // No CLI is bundled or auto-discovered until A3 approves a version, hash and distribution license.
  codexTurns = new CodexTurnHost(app.getPath('userData'), (binding) => new CodexAppServerProvider({
    userDataDirectory: join(app.getPath('userData'), 'codex-profiles', turnBindingHash(binding)), clientVersion: app.getVersion()
  }));

  const shellSession = session.fromPartition('persist:a3-shell');
  shellSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  shellSession.setPermissionCheckHandler(() => false);
  shellSession.on('will-download', (event) => event.preventDefault());
  shellSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [csp(development)];
    callback({ responseHeaders: headers });
  });
  shellSession.protocol.handle('a3', async (request) => {
    const assetURL = new URL(request.url);
    if (assetURL.host !== 'desktop' || request.method !== 'GET') return new Response(null, { status: 403 });
    try {
      const pathname = decodeURIComponent(assetURL.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return new Response(null, { status: 403 });
      const asset = join(rendererRoot, pathname);
      const withinRoot = relative(rendererRoot, asset);
      if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) return new Response(null, { status: 403 });
      const response = await net.fetch(pathToFileURL(asset).href);
      if (asset === join(rendererRoot, 'index.html')) return new Response((await response.text()).replace('<head>', `<head><meta name="a3-editor-style-nonce" content="${editorStyleNonce}">`), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return response;
    } catch { return new Response('Recurso de interfaz no disponible', { status: 404 }); }
  });

  ipcMain.handle(CODEX_AUTH_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !codexAuthorization || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Autorización disponible solo en la interfaz local.' } };
    }
    return codexAuthorization.handle(args[0]);
  });
  ipcMain.handle(MANUAL_CHAT_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !manualChat || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'El chat remoto no puede invocar el puente A3.' } };
    }
    return manualChat.handle(args[0]);
  });
  ipcMain.handle(APP_INFO_CHANNEL, (event, ...args: unknown[]): ShellResult<AppInfo> => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 0) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud no autorizada.', recovery: 'Reabre A3.' } };
    }
    clearTimeout(bootTimer);
    return { ok: true, value: {
      name: app.getName(), version: app.getVersion(), platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node
    } };
  });
  ipcMain.handle(NAVIGATION_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de navegación no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.handleNavigation(args[0]);
  });
  ipcMain.handle(WORKSPACE_SESSION_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || quitting || closing && (args[0] as { action?: string })?.action !== 'view') {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de sesión no autorizada.', recovery: 'Reabre el proyecto.' } };
    }
    return projects.handleWorkspaceSession(args[0]);
  });
  ipcMain.handle(PROJECTS_CHANNEL, async (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud no autorizada.', recovery: 'Reabre A3.' } };
    }
    const action = args[0] && typeof args[0] === 'object' && 'action' in args[0] ? (args[0] as { action: unknown }).action : null;
    if (['open', 'create', 'recent', 'relocate', 'confirm', 'close'].includes(String(action)) && manualChat && !await manualChat.confirmProjectSwitch()) {
      return { ok: false, error: { code: 'CANCELLED', message: 'Se conservan las pestañas web y el proyecto actual.', recovery: 'Guarda o copia el texto web antes de cambiar de proyecto.' } };
    }
    return projects.handle(args[0]);
  });
  ipcMain.handle(FILES_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.handleFiles(args[0]);
  });
  ipcMain.handle(GALLERY_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de galería no autorizada.', recovery: 'Reabre el proyecto.' } };
    }
    return projects.handleGallery(args[0]);
  });
  ipcMain.handle(IMAGE_CONVERSION_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Conversión de imagen no autorizada.', recovery: 'Reabre el proyecto.' } };
    }
    return projects.imageConversions.handle(args[0]);
  });
  ipcMain.handle(AV_CONVERSION_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Conversión multimedia no autorizada.', recovery: 'Reabre el proyecto.' } };
    }
    return projects.handleAvConversion(args[0]);
  });
  ipcMain.handle(PLANNING_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Planificación no autorizada.', recovery: 'Reabre el proyecto.' } };
    return projects.handlePlanning(args[0]);
  });
  ipcMain.handle(MEMORY_SEARCH_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Memoria/búsqueda no autorizada.', recovery: 'Reabre el proyecto.' } };
    return projects.handleMemorySearch(args[0]);
  });
  ipcMain.handle(VARIABLES_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Variables no autorizadas.', recovery: 'Reabre el proyecto.' } };
    return projects.handleVariables(args[0]);
  });
  ipcMain.handle(CANVAS_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.handleCanvas(args[0]);
  });
  ipcMain.handle(CODE_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de código no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.handleCode(args[0]);
  });
  ipcMain.handle(MARKDOWN_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de documento no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.handleMarkdown(args[0]);
  });
  ipcMain.handle(DROP_STAGE_CHANNEL, (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !isShellDocument(event.senderFrame.url, url) || args.length !== 1 || !projects || closing || quitting) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de drop no autorizada.', recovery: 'Reabre A3.' } };
    }
    return projects.stageDrop(args[0]);
  });

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      title: 'A3', width: 1280, height: 800, minWidth: 900, minHeight: 600,
      backgroundColor: '#10151b', show: false,
      webPreferences: {
        preload: preloadPath, session: shellSession,
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        webviewTag: false, webSecurity: true, allowRunningInsecureContent: false
      }
    });
    const win = mainWindow;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, target) => {
      if (!isShellDocument(target, url)) event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, target) => {
      if (!isShellDocument(target, url)) event.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('did-start-loading', () => manualChat?.hide());
    win.on('resize', () => manualChat?.resize());
    win.webContents.on('preload-error', fatalStartup);
    win.webContents.on('will-prevent-unload', (event) => { if (quitting) event.preventDefault(); });
    win.webContents.on('render-process-gone', fatalStartup);
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fatalStartup();
    });
    win.once('ready-to-show', () => win.show());
    win.once('closed', () => { clearTimeout(bootTimer); mainWindow = null; });
    win.on('close', (event) => { if (!quitting) { event.preventDefault(); void finishQuit(); } });
    bootTimer = setTimeout(fatalStartup, 15_000);
    void win.loadURL(url).catch(fatalStartup);
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Archivo', submenu: [{ label: 'Salir', role: 'quit', accelerator: 'Alt+F4' }] },
    { label: 'Ver', submenu: [
      { label: 'Recargar interfaz', role: 'reload' },
      ...(app.isPackaged ? [] : [{ label: 'Herramientas de desarrollo', role: 'toggleDevTools' as const }]),
      { label: 'Pantalla completa', role: 'togglefullscreen' }
    ] }
  ]));
  createWindow();
  app.on('activate', () => { if (!mainWindow && !quitting) createWindow(); });
}

app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); void finishQuit(); } });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { codexAuthorization?.dispose(); ipcMain.removeHandler(CODEX_AUTH_CHANNEL); manualChat?.dispose(); ipcMain.removeHandler(MANUAL_CHAT_CHANNEL); ipcMain.removeHandler(APP_INFO_CHANNEL); ipcMain.removeHandler(PROJECTS_CHANNEL); ipcMain.removeHandler(FILES_CHANNEL); ipcMain.removeHandler(GALLERY_CHANNEL); ipcMain.removeHandler(IMAGE_CONVERSION_CHANNEL); ipcMain.removeHandler(AV_CONVERSION_CHANNEL); ipcMain.removeHandler(VARIABLES_CHANNEL); ipcMain.removeHandler(CANVAS_CHANNEL); ipcMain.removeHandler(MARKDOWN_CHANNEL); ipcMain.removeHandler(CODE_CHANNEL); ipcMain.removeHandler(DROP_STAGE_CHANNEL); ipcMain.removeHandler(WORKSPACE_SESSION_CHANNEL); ipcMain.removeHandler(NAVIGATION_CHANNEL); });
process.on('uncaughtException', fatalStartup);
process.on('unhandledRejection', fatalStartup);
void app.whenReady().then(() => { if (primaryInstance) return startDesktop(); }).catch(fatalStartup);
