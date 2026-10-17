import { clipboard, dialog, Menu, session, shell, WebContentsView, type BrowserWindow, type Session, type WebContents, type DownloadItem } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { MANUAL_CHAT_HOME, MANUAL_CHAT_PARTITION, manualChatURL, manualChatOrigin, manualChatResourceAllowed, validManualChatRequest,
  type ChatBounds, type ManualChatRequest, type ManualChatResult, type ManualChatState } from '../shared/manual-chat';

interface Tab { id: string; context: string | null; view: WebContentsView; requestedURL: string; error: string; }
/** Host-owned manual UI. No project file service, agent transport, automatic paste or remote preload. */
export class ManualChatController {
  #tabs = new Map<string, Tab>();
  #active = new Map<string | null, string>();
  #initialized = new Set<string | null>();
  #context: string | null = null;
  #shown = false;
  #attached: Tab | undefined;
  #bounds: ChatBounds = { x: 0, y: 0, width: 0, height: 0 };
  #media = new Map<string, boolean>();
  #notice = '';
  #profile: Session | undefined;
  #clearing = false;
  #disposed = false;
  #prompting = new Set<string>();
  #downloads = new Set<DownloadItem>();
  #pending = false;
  #permissionEpoch = 0;
  #sessionUnsafe = false;
  constructor(private readonly window: () => BrowserWindow | null, private readonly currentSession: () => Promise<string | null>) {}

  #owned(contents: WebContents | null): Tab | undefined { return contents ? [...this.#tabs.values()].find((tab) => tab.view.webContents === contents && !contents.isDestroyed()) : undefined; }
  #profileSession(): Session {
    if (this.#profile) return this.#profile;
    const profile = session.fromPartition(MANUAL_CHAT_PARTITION); this.#profile = profile;
    // Electron sessions are independent: the a3:// protocol handler belongs only to the shell session.
    profile.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !manualChatResourceAllowed(details.url, details.resourceType) }));
    profile.setDevicePermissionHandler(() => false);
    profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    profile.setPermissionCheckHandler((contents, permission, origin, details) => {
      const tab = this.#owned(contents), current = tab && manualChatOrigin(tab.view.webContents.getURL());
      return !!tab && tab === this.#attached && this.#shown && permission === 'media' && details.isMainFrame && current === manualChatOrigin(origin) &&
        (details.mediaType === 'audio' || details.mediaType === 'video') && this.#media.get(current + ':' + details.mediaType) === true;
    });
    profile.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tab = this.#owned(contents), origin = manualChatOrigin(details.requestingUrl), current = tab && manualChatOrigin(contents.getURL());
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
      if (!tab || tab !== this.#attached || !this.#shown || permission !== 'media' || !details.isMainFrame || !origin || origin !== current || !types?.length || types.some((type) => !['audio', 'video'].includes(type))) { callback(false); return; }
      const key = origin + ':media';
      if (this.#prompting.has(key)) { callback(false); return; }
      this.#prompting.add(key);
      const epoch = this.#permissionEpoch;
      void (async () => {
        const parent = this.window(); if (!parent) return false;
        if (types.every((type) => this.#media.get(origin + ':' + type) === true)) return true;
        const result = await dialog.showMessageBox(parent, { type: 'question', title: 'A3 · Permiso del sitio', message: origin + ' solicita ' + types.map((type) => type === 'audio' ? 'micrófono' : 'cámara').join(' y '),
          detail: 'Solo para este origen durante esta sesión de A3. No concede acceso al proyecto. Puedes revocarlo desde Chat web.', buttons: ['Denegar', 'Permitir'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1 || epoch !== this.#permissionEpoch || this.#disposed || tab !== this.#attached || !this.#shown || contents.isDestroyed() || manualChatOrigin(contents.getURL()) !== origin) return false;
        for (const type of types) this.#media.set(origin + ':' + type, true);
        return true;
      })().then(callback).catch(() => callback(false)).finally(() => this.#prompting.delete(key));
    });
    profile.on('will-download', (event, item, contents) => {
      const tab = this.#owned(contents), origin = typeof item.getInitiatorOrigin === 'function' ? manualChatOrigin(item.getInitiatorOrigin()) : null, parent = this.window();
      if (!tab || tab !== this.#attached || !this.#shown || !origin || origin !== manualChatOrigin(contents.getURL()) || !item.hasUserGesture() || !manualChatURL(item.getURL()) || this.#clearing || !parent) {
        event.preventDefault();
        if (tab?.context === this.#context) this.#notice = 'Descarga bloqueada: requiere una acción manual del origen visible y una URL HTTPS pública. Usa el navegador externo para otros flujos.';
        return;
      }
      // Choose synchronously within will-download, before Electron can resolve an automatic destination.
      const chosen = dialog.showSaveDialogSync(parent, { title: 'Descarga: ' + origin + ' desde ' + manualChatOrigin(item.getURL()), defaultPath: basename(item.getFilename()).slice(0, 200) || 'a3-download',
        buttonLabel: 'Guardar descarga (sin importar en A3)', properties: ['showOverwriteConfirmation', 'dontAddToRecent'] });
      if (!chosen) { event.preventDefault(); this.#notice = origin + ': descarga cancelada antes de elegir destino.'; return; }
      item.setSavePath(chosen);
      this.#downloads.add(item);
      item.once('done', (_event, state) => { this.#downloads.delete(item); if (!this.#disposed && tab.context === this.#context) this.#notice = origin + ': descarga ' + (state === 'completed' ? 'guardada por elección del usuario. No se añadió a A3.' : 'cancelada o incompleta.'); });
    });
    return profile;
  }

  #detach(): void {
    const tab = this.#attached; this.#attached = undefined;
    if (tab) { const win = this.window(); if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view); tab.view.setVisible(false); }
  }
  #layout(): void {
    this.#detach();
    const tab = this.#tabs.get(this.#active.get(this.#context) ?? ''), win = this.window();
    if (!this.#shown || !tab || !win || win.isDestroyed() || this.#bounds.width < 1 || this.#bounds.height < 1) return;
    const [width = 0, height = 0] = win.getContentSize(), { x, y } = this.#bounds;
    const bounds = { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.min(Math.round(this.#bounds.width), width - Math.round(x))), height: Math.max(0, Math.min(Math.round(this.#bounds.height), height - Math.round(y))) };
    if (!bounds.width || !bounds.height) return;
    tab.view.setBounds(bounds); tab.view.setVisible(true); win.contentView.addChildView(tab.view); this.#attached = tab;
  }
  resize(): void { this.#layout(); }
  hide(): void { this.#shown = false; this.#detach(); this.#bounds = { x: 0, y: 0, width: 0, height: 0 }; }
  #close(tab: Tab): void {
    if (this.#attached === tab) this.#detach();
    this.#tabs.delete(tab.id);
    // Electron clears WebContentsView.webContents during its destroyed event despite its static type.
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (this.#active.get(tab.context) === tab.id) {
      const next = [...this.#tabs.values()].find((candidate) => candidate.context === tab.context);
      if (next) this.#active.set(tab.context, next.id); else this.#active.delete(tab.context);
    }
  }
  #new(url = MANUAL_CHAT_HOME): Tab {
    if (this.#tabs.size >= 8 || this.#clearing || this.#sessionUnsafe) throw new Error('Cierra una pestaña antes de abrir otra (máximo 8) o reintenta el cierre de sesión pendiente.');
    const view = new WebContentsView({ webPreferences: { session: this.#profileSession(), nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, safeDialogs: true, navigateOnDragDrop: false } });
    const tab: Tab = { id: randomUUID(), context: this.#context, view, requestedURL: url, error: '' };
    this.#tabs.set(tab.id, tab); this.#active.set(this.#context, tab.id);
    const contents = view.webContents;
    contents.once('destroyed', () => { if (this.#tabs.has(tab.id)) { this.#close(tab); this.#layout(); } });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => { if (!manualChatURL(event.url)) { event.preventDefault(); tab.error = 'Navegación bloqueada: solo HTTPS público; archivos y protocolos A3 no están disponibles.'; } });
    contents.on('will-redirect', (event, target) => { if (!manualChatURL(target)) { event.preventDefault(); tab.error = 'Redirección no permitida. Usa el navegador externo para un login incompatible.'; } });
    contents.setWindowOpenHandler(({ url: target }) => {
      if (manualChatURL(target)) void this.#popup(tab, target).catch(() => { tab.error = 'No se abrió la ventana solicitada.'; });
      else tab.error = 'Ventana bloqueada: protocolo no permitido.';
      return { action: 'deny' };
    });
    contents.on('did-fail-load', (_event, code, _description, failedURL, main) => { if (main && code !== -3) {
      if (manualChatURL(failedURL)) tab.requestedURL = failedURL;
      tab.error = 'No se pudo cargar el sitio (' + code + '). Si falla el login, usa Abrir externamente; no se ha iniciado un agente.';
    } });
    contents.on('render-process-gone', () => { tab.error = 'La pestaña web se detuvo. Recarga o abre externamente.'; });
    contents.on('will-prevent-unload', (event) => {
      const parent = this.window(); if (parent && dialog.showMessageBoxSync(parent, { type: 'warning', message: 'El sitio indica cambios sin guardar.', detail: 'Continuar puede descartar el texto de esta pestaña web.', buttons: ['Conservar pestaña', 'Continuar'], defaultId: 0, cancelId: 0 }) === 1) event.preventDefault();
    });
    contents.on('context-menu', (_event, params) => Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }
    ]).popup({ window: this.window() ?? undefined }));
    // Ctrl+L/Escape return focus to trusted controls, without reading the remote document.
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'Escape' || input.control && input.key.toLowerCase() === 'l')) { event.preventDefault(); this.window()?.webContents.focus(); this.window()?.webContents.send('a3.manual-chat:focus-url'); }
    });
    this.#navigate(tab, url); this.#layout(); return tab;
  }
  #navigate(tab: Tab, url: string): void {
    const target = manualChatURL(url); if (!target) throw new Error('URL no permitida: utiliza HTTPS público sin credenciales.');
    tab.requestedURL = target; tab.error = '';
    void tab.view.webContents.loadURL(target).catch(() => { if (this.#tabs.has(tab.id) && !tab.error) tab.error = 'Sitio no disponible. Puedes abrirlo en el navegador externo.'; });
  }
  async #confirm(message: string, detail: string): Promise<boolean> {
    const parent = this.window(); if (!parent || this.#disposed) return false;
    return (await dialog.showMessageBox(parent, { type: 'warning', title: 'A3 · Chat web manual', message, detail, buttons: ['Cancelar', 'Continuar'], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
  }
  async #popup(tab: Tab, target: string): Promise<void> {
    if (tab !== this.#attached || this.#prompting.has('popup')) return;
    this.#prompting.add('popup');
    try {
      if (await this.#confirm((manualChatOrigin(tab.view.webContents.getURL()) ?? 'El sitio') + ' solicita abrir ' + manualChatOrigin(target), 'Se abrirá otra pestaña aislada sin puente A3. Si el login necesita ventanas compatibles, usa el navegador externo.') && this.#tabs.has(tab.id) && tab.context === this.#context && tab === this.#attached) this.#new(target);
    } finally { this.#prompting.delete('popup'); }
  }
  async confirmProjectSwitch(): Promise<boolean> {
    if (this.#pending) return false;
    if (!this.#tabs.size && !this.#downloads.size) return true;
    if (!await this.#confirm('Cerrar las pestañas web antes de cambiar de proyecto', 'Copia o guarda el texto pendiente primero. Se cancelarán descargas pendientes. Las conversaciones no se importan como memoria del proyecto. Las cookies de cuenta permanecen en el perfil local.')) return false;
    for (const item of this.#downloads) item.cancel();
    for (const tab of [...this.#tabs.values()]) this.#close(tab);
    this.#notice = ''; this.#initialized.clear(); this.hide(); return true;
  }
  async confirmQuit(): Promise<boolean> {
    if (this.#pending) return false;
    return !this.#tabs.size && !this.#downloads.size || this.#confirm('Cerrar las pestañas web y salir de A3', 'El texto web no enviado puede perderse y se cancelarán descargas pendientes. No se guardan conversaciones ni navegación en el proyecto.');
  }
  #state(): ManualChatState {
    return { sessionId: this.#context, activeTabId: this.#active.get(this.#context) ?? null, visible: this.#shown, notice: this.#notice,
      tabs: [...this.#tabs.values()].filter((tab) => tab.context === this.#context).map((tab) => {
        const contents = tab.view.webContents, alive = !contents.isDestroyed(), url = alive && manualChatURL(contents.getURL()) || tab.requestedURL, origin = manualChatOrigin(url) ?? '';
        return { id: tab.id, url, origin, title: alive ? contents.getTitle().slice(0, 200) || 'Chat web' : 'Pestaña cerrada', loading: alive && contents.isLoading(),
          canGoBack: alive && contents.navigationHistory.canGoBack(), canGoForward: alive && contents.navigationHistory.canGoForward(), error: tab.error,
          permissions: { audio: this.#media.get(origin + ':audio') === true, video: this.#media.get(origin + ':video') === true } };
      }) };
  }
  async handle(input: unknown): Promise<ManualChatResult> {
    if (!validManualChatRequest(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de chat manual inválida.' } };
    const mutation = !['state', 'layout', 'hide'].includes(input.action);
    if (mutation && this.#pending) return { ok: false, error: { code: 'BUSY', message: 'Termina la operación web pendiente.' } };
    if (mutation) this.#pending = true;
    try {
      if (this.#disposed) throw new Error('El navegador se está cerrando.');
      const context = await this.currentSession();
      if (input.sessionId !== context) return { ok: false, error: { code: 'STALE_SESSION', message: 'La pestaña pertenece a otra sesión de proyecto.' } };
      if (context !== this.#context) { this.hide(); this.#notice = ''; this.#context = context; }
      await this.#command(input);
      return { ok: true, value: this.#state() };
    } catch (cause) { return { ok: false, error: { code: 'MANUAL_CHAT_FAILED', message: cause instanceof Error ? cause.message : 'No se completó la operación web.' } }; }
    finally { if (mutation) this.#pending = false; }
  }
  async #command(input: ManualChatRequest): Promise<void> {
    if (input.action === 'copy-text') {
      if (Buffer.byteLength(input.text, 'utf8') > 1024 * 1024) throw new Error('El texto supera 1 MiB UTF-8. Copia una parte del contexto.');
      clipboard.writeText(input.text); this.#notice = 'Texto copiado por tu acción. Pégalo y envíalo manualmente en el sitio; no es un turno de agente.'; return;
    }
    if (input.action === 'state') return;
    if (input.action === 'hide') { this.hide(); return; }
    if (input.action === 'show') { this.#shown = true; if (!this.#initialized.has(this.#context)) { this.#initialized.add(this.#context); this.#new(); } this.#layout(); return; }
    if (input.action === 'layout') { this.#bounds = input.bounds; this.#layout(); return; }
    if (input.action === 'new-tab') { this.#new(); return; }
    if (input.action === 'logout') {
      if (this.#clearing || !await this.#confirm('Cerrar sesión web local', 'Se cerrarán todas las pestañas de este proveedor y se borrarán sus cookies, almacenamiento y caché del perfil A3. Guarda primero el texto pendiente. No cierra la sesión del navegador externo ni revoca OAuth del agente.')) return;
      this.#clearing = true;
      this.#permissionEpoch++; this.#sessionUnsafe = true; this.#notice = '';
      try {
        for (const item of this.#downloads) item.cancel();
        for (const tab of [...this.#tabs.values()]) this.#close(tab);
        this.#media.clear();
        const profile = this.#profileSession(); await profile.closeAllConnections(); await profile.clearData(); await profile.clearAuthCache();
        this.#sessionUnsafe = false;
        this.#notice = 'Datos de sesión web local eliminados. El navegador externo y el agente son independientes.';
      } finally { this.#clearing = false; }
      return;
    }
    if (!('tabId' in input)) return;
    const tab = this.#tabs.get(input.tabId);
    if (!tab || tab.context !== this.#context || tab.view.webContents.isDestroyed()) throw new Error('Pestaña ausente en esta sesión.');
    const contents = tab.view.webContents;
    switch (input.action) {
      case 'select': this.#active.set(this.#context, tab.id); this.#layout(); break;
      case 'focus': if (tab === this.#attached) contents.focus(); break;
      case 'navigate': this.#navigate(tab, input.url); break;
      case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case 'reload': tab.error = ''; contents.reload(); break;
      case 'close': if (await this.#confirm('Cerrar esta pestaña web', 'El texto web pendiente puede perderse. Cerrar no importa ni elimina archivos del proyecto.') && this.#tabs.has(tab.id)) { this.#close(tab); this.#layout(); } break;
      case 'external': {
        const target = tab.error && manualChatURL(tab.requestedURL) || manualChatURL(contents.getURL()) || manualChatURL(tab.requestedURL);
        if (!target) throw new Error('No hay una URL HTTPS válida.');
        if (await this.#confirm('Abrir externamente ' + manualChatOrigin(target), 'Se abrirá esta URL en el navegador del sistema. Sus cookies son independientes. No se envía contexto A3 ni se inicia un turno de agente.')) {
          await shell.openExternal(target); this.#notice = 'Se solicitó abrir el navegador externo. El acceso/login integrado no queda verificado.';
        }
        break;
      }
      case 'revoke': {
        const origin = manualChatOrigin(contents.getURL()); if (!origin) return;
        if (await this.#confirm('Revocar cámara y micrófono de ' + origin, 'Se recargarán las pestañas de este origen para detener capturas existentes. Guarda primero el texto web.')) {
          this.#permissionEpoch++;
          this.#media.delete(origin + ':audio'); this.#media.delete(origin + ':video');
          for (const candidate of this.#tabs.values()) if (manualChatOrigin(candidate.view.webContents.getURL()) === origin) candidate.view.webContents.reload();
        }
      }
    }
  }
  dispose(): void {
    this.#disposed = true; this.#permissionEpoch++; this.hide();
    for (const item of this.#downloads) item.cancel();
    for (const tab of [...this.#tabs.values()]) this.#close(tab);
    this.#media.clear();
  }
}
