import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session } from 'electron';
import { access } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_INFO_CHANNEL, type AppInfo, type ShellResult } from '../shared/desktop-api';

const APP_URL = 'a3://desktop/index.html';
const rendererRoot = join(__dirname, '../renderer');
const preloadPath = join(__dirname, '../preload/index.cjs');
let mainWindow: BrowserWindow | null = null;
let failed = false;
let quitting = false;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

protocol.registerSchemesAsPrivileged([
  { scheme: 'a3', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
app.enableSandbox();
app.setName('A3');

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
    `style-src 'self'${development ? " 'unsafe-inline'" : ''}; ` +
    `connect-src ${development ? "'self' ws://127.0.0.1:* ws://localhost:*" : "'none'"}; ` +
    "img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
}

async function startDesktop(): Promise<void> {
  const url = rendererURL();
  const development = url !== APP_URL;
  await access(preloadPath);
  if (!development) await access(join(rendererRoot, 'index.html'));

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
      return await net.fetch(pathToFileURL(asset).href);
    } catch { return new Response('Recurso de interfaz no disponible', { status: 404 }); }
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
    win.webContents.on('preload-error', fatalStartup);
    win.webContents.on('render-process-gone', fatalStartup);
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fatalStartup();
    });
    win.once('ready-to-show', () => win.show());
    win.once('closed', () => { clearTimeout(bootTimer); mainWindow = null; });
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

app.on('before-quit', () => { quitting = true; clearTimeout(bootTimer); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => ipcMain.removeHandler(APP_INFO_CHANNEL));
process.on('uncaughtException', fatalStartup);
process.on('unhandledRejection', fatalStartup);
void app.whenReady().then(startDesktop).catch(fatalStartup);
