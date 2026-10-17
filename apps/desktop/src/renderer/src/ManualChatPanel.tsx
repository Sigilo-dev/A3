import { useEffect, useRef, useState } from 'react';
import { MANUAL_CHAT_HOME, type ManualChatAction, type ManualChatState } from '../../shared/manual-chat';

export function ManualChatPanel({ sessionId, obstructed }: { sessionId: string | null; obstructed: boolean }): React.JSX.Element {
  const [state, setState] = useState<ManualChatState | null>(null), [error, setError] = useState(''), [url, setURL] = useState(MANUAL_CHAT_HOME), [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), address = useRef<HTMLInputElement>(null);
  const tab = state?.tabs.find((item) => item.id === state.activeTabId);
  async function send(request: ManualChatAction): Promise<void> {
    if (!window.a3) throw new Error('Puente no disponible.');
    const result = await window.a3.manualChat({ ...request, sessionId });
    if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
    setState(result.value);
  }
  async function act(request: ManualChatAction): Promise<void> { setBusy(true); setError(''); try { await send(request); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  useEffect(() => { setURL(tab?.url ?? MANUAL_CHAT_HOME); }, [tab?.id, tab?.url]);
  useEffect(() => {
    let live = true, polling = false;
    const invoke = async (request: ManualChatAction): Promise<void> => {
      const result = await window.a3?.manualChat({ ...request, sessionId });
      if (!live || !result) return;
      if (result.ok) setState(result.value); else setError(result.error.code + ': ' + result.error.message);
    };
    void invoke({ action: obstructed ? 'hide' : 'show' }).catch((cause) => { if (live) setError(String(cause)); });
    const layout = (): void => {
      const rect = viewport.current?.getBoundingClientRect();
      if (rect && !obstructed) void invoke({ action: 'layout', bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height } }).catch(() => undefined);
    };
    const observer = new ResizeObserver(layout); if (viewport.current) observer.observe(viewport.current);
    window.addEventListener('resize', layout); window.addEventListener('scroll', layout, true); layout();
    const timer = setInterval(() => { if (polling) return; polling = true; void invoke({ action: 'state' }).catch((cause) => { if (live) setError(String(cause)); }).finally(() => { polling = false; }); }, 750);
    const unsubscribe = window.a3?.onManualChatFocus(() => { address.current?.focus(); address.current?.select(); });
    return () => { live = false; clearInterval(timer); observer.disconnect(); unsubscribe?.(); window.removeEventListener('resize', layout); window.removeEventListener('scroll', layout, true); void window.a3?.manualChat({ action: 'hide', sessionId }).catch(() => undefined); };
  }, [sessionId, obstructed]);
  return <section className="manual-chat-panel" aria-labelledby="manual-chat-title" data-manual-chat>
    <div className="manual-chat-heading"><h1 id="manual-chat-title">Chat web manual</h1><button type="button" data-chat-logout disabled={busy} onClick={() => void act({ action: 'logout' })}>Cerrar sesión web local</button></div>
    <p className="manual-chat-help">Copia un prompt en A3 y pégalo tú en el sitio. Pegar y enviar no inicia un turno de agente ni completa tareas. Las cookies pertenecen al perfil local, fuera del proyecto.</p>
    <div className="manual-chat-tabs" role="tablist" aria-label="Pestañas web">{state?.tabs.map((item, index) => <div key={item.id}>
      <button type="button" role="tab" data-chat-tab={item.id} aria-selected={item.id === state.activeTabId} tabIndex={item.id === state.activeTabId ? 0 : -1} onClick={() => void act({ action: 'select', tabId: item.id })}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = state.tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + state.tabs.length) % state.tabs.length]; if (next) void act({ action: 'select', tabId: next.id }).then(() => document.querySelector<HTMLButtonElement>('[data-chat-tab="' + next.id + '"]')?.focus()); } }}>{item.title}</button>
      <button type="button" aria-label={'Cerrar ' + item.title} data-chat-close={item.id} disabled={busy} onClick={() => void act({ action: 'close', tabId: item.id })}>×</button>
    </div>)}<button type="button" data-chat-new disabled={busy || (state?.tabs.length ?? 0) >= 8} onClick={() => void act({ action: 'new-tab' })}>Nueva pestaña</button></div>
    <form className="manual-chat-address" onSubmit={(event) => { event.preventDefault(); if (tab) void act({ action: 'navigate', tabId: tab.id, url }); }}>
      <button type="button" data-chat-back disabled={busy || !tab?.canGoBack} onClick={() => tab && void act({ action: 'back', tabId: tab.id })}>Atrás</button>
      <button type="button" data-chat-forward disabled={busy || !tab?.canGoForward} onClick={() => tab && void act({ action: 'forward', tabId: tab.id })}>Adelante</button>
      <button type="button" data-chat-reload disabled={busy || !tab} onClick={() => tab && void act({ action: 'reload', tabId: tab.id })}>Recargar</button>
      <label>URL<input ref={address} type="url" aria-label="URL del chat web" maxLength={8192} value={url} disabled={!tab || busy} onChange={(event) => setURL(event.target.value)} /></label><button type="submit" disabled={!tab || busy}>Ir</button>
    </form>
    <div className="manual-chat-origin"><strong data-chat-origin>{tab?.origin ?? 'Sin pestaña'}</strong>
      <button type="button" data-chat-external disabled={!tab || busy} onClick={() => tab && void act({ action: 'external', tabId: tab.id })}>Abrir externamente</button>
      <button type="button" data-chat-focus disabled={!tab || busy} onClick={() => tab && void act({ action: 'focus', tabId: tab.id })}>Entrar al sitio</button>
      <span>Micrófono: {tab?.permissions.audio ? 'permitido' : 'sin concesión'} · Cámara: {tab?.permissions.video ? 'permitida' : 'sin concesión'}</span>
      <button type="button" disabled={!tab || busy || !tab.permissions.audio && !tab.permissions.video} onClick={() => tab && void act({ action: 'revoke', tabId: tab.id })}>Revocar permisos de este origen</button>
    </div>
    <p className="manual-chat-help">Si el login no funciona aquí, usa «Abrir externamente». Esa alternativa tiene otra sesión y no verifica el acceso integrado. Esc o Ctrl+L vuelve a la URL de A3.</p>
    {(error || tab?.error) && <p role="alert" data-chat-error>{error || tab?.error}</p>}{state?.notice && <p role="status" data-chat-notice>{state.notice}</p>}
    <div ref={viewport} className="manual-chat-viewport" aria-label="Sitio remoto aislado" data-chat-viewport>{!tab && <p>No hay pestañas abiertas. Abre una nueva para acceder manualmente.</p>}</div>
    <p role="status" className="manual-chat-help">{tab?.loading ? 'Cargando sitio…' : tab ? 'Vista web aislada · interacción manual' : 'Sesión web sin pestañas'}</p>
  </section>;
}
