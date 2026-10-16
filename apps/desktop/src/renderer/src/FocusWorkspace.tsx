import { createRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import type { FocusTab, LocalProjectSession, PageReference, PageViewState, CanvasViewState, WorkspaceSession, WorkspaceSessionAction } from '../../shared/desktop-api';
import type { MarkdownEditorTarget, MarkdownViewHandle } from './MarkdownEditor';
import type { CodeEditorTarget } from './CodeEditor';
const CanvasPanel = lazy(() => import('./CanvasPanel').then((m) => ({ default: m.CanvasPanel })));
const MarkdownEditor = lazy(() => import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditorDialog })));
export interface FocusWorkspaceHandle {
  openPage(target: MarkdownEditorTarget, anotherView?: boolean): Promise<void>;
  openCanvas(): Promise<void>; settle(reason: string): Promise<boolean>; flush(): Promise<void>;
}
interface Guard { ids: string[]; reason: string; resolve: (approved: boolean) => void; }

export function FocusWorkspace({ project, visible, onReveal, onOpenCode, controllerRef, contentVersion, onSaved }: {
  project: LocalProjectSession; visible: boolean; onReveal: () => void; onOpenCode: (target: CodeEditorTarget) => void;
  controllerRef: Ref<FocusWorkspaceHandle>; contentVersion: number; onSaved: () => void;
}): React.JSX.Element {
  const [session, setSession] = useState<WorkspaceSession | null>(null), sessionRef = useRef(session); sessionRef.current = session;
  const [error, setError] = useState<string | null>(null), [reference, setReference] = useState<PageReference | null>(null);
  const [guard, setGuard] = useState<Guard | null>(null), guardRef = useRef(guard); guardRef.current = guard;
  const [guardBusy, setGuardBusy] = useState(false), [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const views = useRef(new Map<string, RefObject<MarkdownViewHandle | null>>());
  const pendingViews = useRef(new Map<string, PageViewState | CanvasViewState>()), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tail = useRef<Promise<unknown>>(Promise.resolve()), live = useRef(true), tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const callbacks = useRef({ onReveal, onSaved }); callbacks.current = { onReveal, onSaved };
  const selected = session?.tabs.find((t) => t.id === session.selectedId);
  function accept(value: WorkspaceSession): void { sessionRef.current = value; if (live.current) setSession(value); }
  async function request(action: WorkspaceSessionAction): Promise<WorkspaceSession> {
    if (!window.a3) throw new Error('El host no está disponible.');
    const result = await window.a3.workspaceSession(action.action === 'load' ? { ...action, sessionId: project.sessionId } : { ...action, sessionId: project.sessionId, expectedRevision: sessionRef.current?.revision ?? 0 });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    if (!('tabs' in result.value)) throw new Error('El host devolvió una sesión inesperada.');
    accept(result.value); return result.value;
  }
  function run(action: WorkspaceSessionAction): Promise<WorkspaceSession> {
    const next = tail.current.then(() => request(action)); tail.current = next.catch(() => undefined); return next;
  }
  function report(cause: unknown): void { if (live.current) setError(cause instanceof Error ? cause.message : 'No se guardó la sesión local.'); }
  function restoreFocus(): void { requestAnimationFrame(() => { if (dialogOrigin.current?.isConnected && !dialogOrigin.current.matches(':disabled')) dialogOrigin.current.focus(); else tabButtons.current.get(sessionRef.current?.selectedId ?? '')?.focus(); }); }
  function dialogKey(event: React.KeyboardEvent<HTMLElement>, cancel: () => void): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key !== 'Tab') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const first = buttons[0], last = buttons.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  function stageView(tabId: string, value: PageViewState | CanvasViewState): void {
    pendingViews.current.set(tabId, value); clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(false).catch(report); }, 200);
  }
  async function flush(capture = true): Promise<void> {
    clearTimeout(timer.current);
    if (capture) for (const ref of views.current.values()) ref.current?.captureView();
    const pending = [...pendingViews.current]; pendingViews.current.clear();
    for (const [tabId, view] of pending) {
      if (!sessionRef.current?.tabs.some((t) => t.id === tabId)) continue;
      try { await run({ action: 'view', tabId, view }); } catch (cause) { pendingViews.current.set(tabId, view); throw cause; }
    }
    await tail.current;
  }
  function viewRef(id: string): RefObject<MarkdownViewHandle | null> {
    let ref = views.current.get(id); if (!ref) { ref = createRef<MarkdownViewHandle>(); views.current.set(id, ref); } return ref;
  }
  async function activate(tabId: string): Promise<void> { await flush(); await run({ action: 'activate', tabId }); callbacks.current.onReveal(); }
  async function settle(reason: string, ids = [...views.current.keys()]): Promise<boolean> {
    await flush(); const dirty = ids.filter((id) => views.current.get(id)?.current?.isDirty());
    if (!dirty.length) return true;
    if (guardRef.current) return false;
    dialogOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise<boolean>((resolve) => { const next = { ids: dirty, reason, resolve }; guardRef.current = next; setGuard(next); });
  }
  async function resolveGuard(choice: 'cancel' | 'discard' | 'save'): Promise<void> {
    if (!guard || guardBusy) return;
    setGuardBusy(true);
    try {
      if (choice === 'save') for (const id of guard.ids) {
        if (!await views.current.get(id)?.current?.save()) { await activate(id); guard.resolve(false); setGuard(null); guardRef.current = null; return; }
      }
      if (choice === 'discard') for (const id of guard.ids) views.current.get(id)?.current?.discard();
      guard.resolve(choice !== 'cancel'); setGuard(null); guardRef.current = null;
      if (choice === 'cancel') restoreFocus();
    } catch (cause) { report(cause); guard.resolve(false); setGuard(null); guardRef.current = null; }
    finally { setGuardBusy(false); }
  }
  async function close(tabId: string, alreadyApproved = false): Promise<void> {
    if (!alreadyApproved && !await settle('cerrar esta pestaña', [tabId])) return;
    await flush(); await run({ action: 'close', tabId }); views.current.delete(tabId); pendingViews.current.delete(tabId);
    tabButtons.current.get(sessionRef.current?.selectedId ?? '')?.focus();
  }
  useImperativeHandle(controllerRef, () => ({
    openPage: async (target, anotherView = false) => { if (target.sessionId !== project.sessionId) throw new Error('La página pertenece a otra sesión.'); await flush(); await run({ action: 'open-page', entityId: target.entityId, anotherView }); callbacks.current.onReveal(); },
    openCanvas: async () => {
      const workspace = sessionRef.current?.tabs.find((t) => t.kind === 'workspace');
      if (workspace) await activate(workspace.id);
      else if (project.workspaces[0]) { await flush(); await run({ action: 'open-workspace', workspaceId: project.workspaces[0].id }); callbacks.current.onReveal(); }
    }, settle: (reason) => settle(reason), flush
  }));
  useEffect(() => {
    live.current = true;
    void run({ action: 'load' }).then((value) => { if (value.revision > 0 && live.current) callbacks.current.onReveal(); }).catch(report);
    const flushOnClose = (event: Event): void => { (event as CustomEvent<Promise<void>[]>).detail.push(flush()); };
    window.addEventListener('a3:flush-session', flushOnClose);
    return () => { live.current = false; clearTimeout(timer.current); window.removeEventListener('a3:flush-session', flushOnClose); guardRef.current?.resolve(false); };
  // This component is keyed by the host session ID; no view/buffer is reused in another project.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function showReference(tabId: string): Promise<void> {
    const result = await window.a3?.workspaceSession({ action: 'reference', sessionId: project.sessionId, tabId });
    if (result?.ok && 'resourceId' in result.value) { dialogOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setReference(result.value); } else if (result && !result.ok) setError(result.error.message);
  }
  async function locate(tabId: string): Promise<boolean> {
    const result = await window.a3?.workspaceSession({ action: 'locate', sessionId: project.sessionId, tabId });
    if (result?.ok && 'located' in result.value) { if (result.value.located) callbacks.current.onSaved(); return result.value.located; }
    if (result && !result.ok) setError(`${result.error.code}: ${result.error.message}`); return false;
  }
  // The component is keyed by project session. Keep the canvas handler stable while view state is persisted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openPageFromCanvas = useCallback((target: MarkdownEditorTarget): void => {
    void flush().then(() => run({ action: 'open-page', entityId: target.entityId })).then(() => callbacks.current.onReveal()).catch(report);
  }, [project.sessionId]);
  return <>
    <section className="focus-workspace" hidden={!visible} data-focus-workspace aria-label="Pestañas del proyecto">
      {error && <p role="alert" className="markdown-error" data-session-error>{error}</p>}
      {!session ? error ? <button onClick={() => void run({ action: 'load' }).then(() => setError(null)).catch(report)}>Reintentar sesión local</button> : <p role="status">Restaurando pestañas locales…</p> : <>
        <div className="focus-tab-bar"><div role="tablist" aria-label="Vistas del proyecto" className="focus-tab-list">
          {session.tabs.map((tab, index) => <div key={tab.id} className="focus-tab-item">
            <button role="tab" id={`tab-${tab.id}`} data-focus-tab={tab.id} data-tab-kind={tab.kind} data-tab-entity={tab.kind === 'page' ? tab.entityId : undefined}
              aria-selected={session.selectedId === tab.id} aria-controls={`panel-${tab.id}`} tabIndex={session.selectedId === tab.id ? 0 : -1}
              ref={(element) => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id); }}
              onClick={() => void activate(tab.id).catch(report)} onKeyDown={(event) => {
                let at: number | undefined;
                if (event.key === 'ArrowRight') at = (index + 1) % session.tabs.length;
                if (event.key === 'ArrowLeft') at = (index - 1 + session.tabs.length) % session.tabs.length;
                if (event.key === 'Home') at = 0; if (event.key === 'End') at = session.tabs.length - 1;
                if (at !== undefined) { event.preventDefault(); tabButtons.current.get(session.tabs[at]!.id)?.focus(); }
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void activate(tab.id).catch(report); }
                if (event.key === 'Delete' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); void close(tab.id).catch(report); }
              }}>{tab.kind === 'workspace' ? '▦ ' : '▤ '}{tab.title}{dirtyIds.has(tab.id) ? ' ●' : ''}</button>
            <button className="focus-tab-close" data-close-tab={tab.id} aria-label={`Cerrar ${tab.title}`} tabIndex={session.selectedId === tab.id ? 0 : -1} onClick={() => void close(tab.id).catch(report)}>×</button>
          </div>)}
        </div></div>
        <div className="focus-tab-tools" role="toolbar" aria-label="Acciones de pestaña">
          {selected?.kind === 'page' && <button className="quiet" data-open-another-view onClick={() => void flush().then(() => run({ action: 'open-page', entityId: selected.entityId, anotherView: true })).catch(report)}>Abrir otra vista</button>}
          {selected && [-1, 1].map((offset) => <button key={offset} className="quiet" aria-label={`Mover pestaña a la ${offset < 0 ? 'izquierda' : 'derecha'}`} disabled={session.tabs.findIndex((t) => t.id === selected.id) + offset < 0 || session.tabs.findIndex((t) => t.id === selected.id) + offset >= session.tabs.length} onClick={() => {
            const ids = session.tabs.map((t) => t.id), at = ids.indexOf(selected.id); [ids[at], ids[at + offset]] = [ids[at + offset]!, ids[at]!];
            void flush().then(() => run({ action: 'reorder', tabIds: ids })).catch(report);
          }}>{offset < 0 ? '←' : '→'}</button>)}
        </div>
        {selected?.kind === 'workspace' && <div className="focus-panel" role="tabpanel" id={`panel-${selected.id}`} aria-labelledby={`tab-${selected.id}`} tabIndex={-1}>
          {visible && <Suspense fallback={<p role="status">Abriendo lienzo…</p>}><CanvasPanel active={project} workspaceId={selected.workspaceId} initialViewport={selected.view}
            onViewportChange={(value) => stageView(selected.id, value)} onWorkspaceSelect={(workspaceId) => { void flush().then(() => run({ action: 'open-workspace', workspaceId })).catch(report); }}
            onOpenMarkdown={openPageFromCanvas} onOpenCode={onOpenCode} contentVersion={contentVersion} /></Suspense>}
        </div>}
        {!selected && <p>No hay vistas abiertas. <button onClick={() => void run({ action: 'open-workspace', workspaceId: project.workspaces[0]!.id }).catch(report)} disabled={!project.workspaces.length}>Abrir workspace</button></p>}
      </>}
      {session?.tabs.filter((t): t is Extract<FocusTab, { kind: 'page' }> => t.kind === 'page').map((tab) => <div key={tab.id} className="focus-panel" role="tabpanel" hidden={!visible || tab.id !== session.selectedId} id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`}><Suspense fallback={visible && tab.id === session.selectedId ? <p role="status">Preparando página…</p> : null}>
        <MarkdownEditor target={{ sessionId: project.sessionId, entityId: tab.entityId, resourceId: tab.resourceId, title: tab.title }} activeSessionId={project.sessionId}
          embedded active={visible && tab.id === session.selectedId} initialView={tab.view} controllerRef={viewRef(tab.id)} contentVersion={contentVersion}
          onViewChange={(value) => stageView(tab.id, value)} onSaved={onSaved} onClose={() => void close(tab.id).catch(report)}
          onDirtyChange={(dirty) => setDirtyIds((old) => { if (old.has(tab.id) === dirty) return old; const next = new Set(old); if (dirty) next.add(tab.id); else next.delete(tab.id); return next; })}
          onLocate={() => locate(tab.id)} onReference={() => void showReference(tab.id)} />
      </Suspense></div>)}
    </section>
    {guard && <div className="markdown-confirm-backdrop focus-guard"><section className="markdown-confirm" role="alertdialog" aria-modal="true" aria-labelledby="focus-guard-title" data-focus-guard onKeyDown={(event) => dialogKey(event, () => { if (!guardBusy) void resolveGuard('cancel'); })}>
      <h3 id="focus-guard-title">Guardar antes de {guard.reason}</h3><p>{guard.ids.length} vista(s) tienen cambios. Cancelar conserva el proyecto y los borradores abiertos.</p>
      <button data-focus-guard-cancel disabled={guardBusy} autoFocus onClick={() => void resolveGuard('cancel')}>Cancelar</button><button data-focus-guard-discard disabled={guardBusy} onClick={() => void resolveGuard('discard')}>Descartar borradores</button>
      <button data-focus-guard-save disabled={guardBusy} onClick={() => void resolveGuard('save')}>Guardar y continuar</button>
    </section></div>}
    {reference && <div className="markdown-confirm-backdrop focus-guard"><section className="markdown-confirm" role="dialog" aria-modal="true" aria-labelledby="focus-reference-title" data-focus-reference-details onKeyDown={(event) => dialogKey(event, () => { setReference(null); restoreFocus(); })}><h3 id="focus-reference-title">Referencia conservada</h3>
      <dl><dt>Entidad</dt><dd>{reference.entityId}</dd><dt>Recurso</dt><dd>{reference.resourceId}</dd><dt>Tipo</dt><dd>{reference.kind}</dd><dt>Ruta relativa</dt><dd>{reference.relativePath ?? 'Descriptor no disponible'}</dd></dl>
      <button autoFocus onClick={() => { setReference(null); restoreFocus(); }}>Cerrar referencia</button></section></div>}
  </>;
}
