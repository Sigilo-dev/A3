import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { extendListItemSchemaForTask, gfm } from '@milkdown/preset-gfm';
import { $nodeSchema, $remark, $view } from '@milkdown/utils';
import type { MarkdownDocument } from '../../shared/desktop-api';
import { findA3Wikilinks, inspectMarkdownSource } from '@a3/domain/markdown';
import type { MarkdownParseDiagnostic, MarkdownSourceController } from './MarkdownSourceEditor';

const MarkdownSourceEditor = lazy(() => import('./MarkdownSourceEditor').then((module) => ({ default: module.MarkdownSourceEditor })));

export interface MarkdownEditorTarget { sessionId: string; entityId: string; resourceId: string; title: string; }

interface MdastNode {
  type: string; value?: string; target?: string; label?: string | null; children?: MdastNode[];
  [key: string]: unknown;
}

function addWikilinkNodes(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const node = value as { children?: unknown[] };
  if (!Array.isArray(node.children)) return;
  const next: MdastNode[] = [];
  for (const value of node.children) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const child = value as MdastNode;
    if (child.type !== 'text' || typeof child.value !== 'string') { addWikilinkNodes(child); next.push(child); continue; }
    const tokens = findA3Wikilinks(child.value);
    if (!tokens.length) { next.push(child); continue; }
    let offset = 0;
    for (const token of tokens) {
      if (token.start > offset) next.push({ type: 'text', value: child.value.slice(offset, token.start) });
      next.push({ type: 'a3Wikilink', target: token.target, label: token.label });
      offset = token.end;
    }
    if (offset < child.value.length) next.push({ type: 'text', value: child.value.slice(offset) });
  }
  node.children = next;
}

const a3WikilinkSchema = $nodeSchema('a3Wikilink', () => ({
  inline: true, group: 'inline', atom: true, selectable: true,
  attrs: { target: { default: '' }, label: { default: null } },
  parseDOM: [{ tag: 'span[data-a3-wikilink]', getAttrs: (dom) => ({ target: (dom as HTMLElement).dataset.a3Wikilink ?? '', label: dom.textContent }) }],
  toDOM: (node) => ['span', { class: 'a3-wikilink', 'data-a3-wikilink': node.attrs.target }, node.attrs.label || node.attrs.target],
  parseMarkdown: {
    match: (node) => node.type === 'a3Wikilink',
    runner: (state, node, type) => state.addNode(type, { target: node.target, label: node.label })
  },
  toMarkdown: {
    match: (node) => node.type.name === 'a3Wikilink',
    runner: (state, node) => state.addNode('a3Wikilink', undefined, undefined, { target: node.attrs.target, label: node.attrs.label })
  }
}));

const a3WikilinkRemark = $remark('a3WikilinkRemark', () => function a3WikilinkRemarkPlugin(this: { data(key: string): unknown; data(key: string, value: unknown): unknown }) {
  const existing = this.data('toMarkdownExtensions');
  const extensions = Array.isArray(existing) ? existing : [];
  extensions.push({ handlers: { a3Wikilink: (node: MdastNode) => `[[${node.target ?? ''}${node.label == null ? '' : `|${node.label}`}]]` } });
  this.data('toMarkdownExtensions', extensions);
  return (tree: unknown): void => addWikilinkNodes(tree);
});

const a3TaskListItemView = $view(extendListItemSchemaForTask.node, () => (initialNode, view, getPos) => {
  let node = initialNode;
  const dom = window.document.createElement('li');
  dom.className = 'markdown-list-item';
  const checkbox = window.document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.className = 'markdown-task-checkbox'; checkbox.setAttribute('aria-label', 'Marcar tarea Markdown');
  checkbox.addEventListener('mousedown', (event) => event.stopPropagation());
  checkbox.addEventListener('change', () => {
    if (!view.editable || node.attrs.checked === null) { checkbox.checked = node.attrs.checked === true; return; }
    try {
      const position = getPos();
      if (typeof position !== 'number') return;
      const current = view.state.doc.nodeAt(position);
      if (!current || current.attrs.checked === null) return;
      view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, checked: checkbox.checked }));
    } catch { checkbox.checked = node.attrs.checked === true; }
  });
  const contentDOM = window.document.createElement('div'); contentDOM.className = 'markdown-list-item-content';
  dom.append(checkbox, contentDOM);
  const update = (next: typeof initialNode): boolean => {
    if (next.type !== node.type) return false;
    node = next;
    const task = node.attrs.checked !== null;
    dom.dataset.itemType = task ? 'task' : node.attrs.listType;
    dom.dataset.label = String(node.attrs.label ?? ''); dom.dataset.listType = String(node.attrs.listType ?? 'bullet');
    dom.dataset.spread = String(node.attrs.spread ?? true);
    if (task) dom.dataset.checked = String(node.attrs.checked); else delete dom.dataset.checked;
    checkbox.hidden = !task; checkbox.checked = node.attrs.checked === true; checkbox.disabled = !view.editable || !task;
    return true;
  };
  update(node);
  return { dom, contentDOM, update };
});

const editorPlugins = [...commonmark, ...gfm, a3WikilinkSchema[0], a3WikilinkSchema[1], a3WikilinkRemark[0], a3WikilinkRemark[1], a3TaskListItemView, listener];

export function MarkdownEditorDialog({ target, activeSessionId, onDirtyChange, onClose }: {
  target: MarkdownEditorTarget; activeSessionId: string | null; onDirtyChange: (dirty: boolean) => void; onClose: () => void;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const sourceEditor = useRef<MarkdownSourceController | null>(null);
  const armed = useRef(false);
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [mode, setMode] = useState<'visual' | 'source' | 'preview'>('visual');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Abriendo documento…');
  const [confirmClose, setConfirmClose] = useState(false);
  const [parseError, setParseError] = useState<MarkdownParseDiagnostic | null>(null);
  const [conflictDocument, setConflictDocument] = useState<MarkdownDocument | null>(null);
  const [showConflict, setShowConflict] = useState(false);
  const [visualGeneration, setVisualGeneration] = useState(0);
  const updateDraft = (value: string): void => { draftRef.current = value; setDraft(value); };
  const inspection = useMemo(() => inspectMarkdownSource(draft), [draft]);
  const dirty = !!document && draft !== document.content;
  const sessionCurrent = activeSessionId === target.sessionId;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let live = true;
    setLoading(true); setDocument(null); updateDraft(''); setError(null); setParseError(null); setStatus('Abriendo documento…');
    void window.a3?.markdown({ action: 'open', sessionId: target.sessionId, entityId: target.entityId, resourceId: target.resourceId })
      .then((result) => {
        if (!live) return;
        if (!result.ok || !('content' in result.value)) throw new Error(result.ok ? 'El host devolvió un recurso inesperado.' : `${result.error.code}: ${result.error.message}`);
        setDocument(result.value); updateDraft(result.value.content); setMode(inspectMarkdownSource(result.value.content).editable ? 'visual' : 'source');
        setStatus(result.value.canWrite ? 'Guardado' : 'Solo lectura');
      }).catch((cause: unknown) => { if (live) { setError(cause instanceof Error ? cause.message : 'No se pudo abrir el documento.'); setStatus('Error al abrir'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target.sessionId, target.entityId, target.resourceId]);

  useEffect(() => {
    if (document && !inspection.editable && mode !== 'source') setMode('source');
  }, [document, inspection.editable, mode]);

  useEffect(() => {
    const element = root.current;
    if (!element || !document || !inspection.editable || loading || mode === 'source') return;
    let disposed = false;
    let imageObserver: MutationObserver | undefined;
    const imageUrls = new Map<string, Promise<string | null>>();
    const createdImageUrls: string[] = [];
    let previewBytes = 0;
    armed.current = false;
    const instance = Editor.make().config((ctx) => {
      ctx.set(rootCtx, element);
      ctx.set(defaultValueCtx, draftRef.current);
      ctx.get(listenerCtx).markdownUpdated((_context, markdown) => {
        if (armed.current) { updateDraft(markdown); setStatus('Cambios sin guardar'); setError(null); setParseError(null); }
      });
    }).use(editorPlugins);
    void instance.create().then(() => {
      if (disposed) { void instance.destroy(); return; }
      editor.current = instance;
      armed.current = true;
      instance.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => mode === 'visual' && document.canWrite && sessionCurrent }));
      element.querySelectorAll<HTMLInputElement>('.markdown-task-checkbox').forEach((input) => {
        input.disabled = mode !== 'visual' || !document.canWrite || !sessionCurrent;
      });
      if (mode === 'visual' && document.canWrite && sessionCurrent) instance.action((ctx) => ctx.get(editorViewCtx).focus());
      const resolveImage = async (image: HTMLImageElement): Promise<void> => {
        const reference = image.getAttribute('src') ?? '';
        if (!reference || reference.startsWith('blob:') || image.dataset.a3Reference === reference) return;
        image.dataset.a3Reference = reference;
        let pending = imageUrls.get(reference);
        if (!pending) {
          pending = (async (): Promise<string | null> => {
            if (imageUrls.size >= 64 || previewBytes >= 16 * 1024 * 1024 || !window.a3) return null;
            const result = await window.a3.markdown({ action: 'asset', sessionId: target.sessionId, entityId: target.entityId,
              resourceId: target.resourceId, reference });
            if (!result.ok || !('bytes' in result.value) || result.value.bytes.byteLength > 4 * 1024 * 1024 ||
                previewBytes + result.value.bytes.byteLength > 16 * 1024 * 1024 || disposed) return null;
            previewBytes += result.value.bytes.byteLength;
            const url = URL.createObjectURL(new Blob([result.value.bytes.slice().buffer as ArrayBuffer], { type: result.value.mediaType }));
            createdImageUrls.push(url);
            return url;
          })().catch(() => null);
          imageUrls.set(reference, pending);
        }
        const url = await pending;
        if (disposed || !image.isConnected) return;
        if (url) { image.dataset.a3Asset = 'ready'; image.src = url; }
        else {
          image.dataset.a3Asset = 'unavailable'; image.removeAttribute('src');
          image.alt ||= 'Imagen local no disponible'; image.title = 'La referencia no se pudo resolver con permisos del proyecto.';
        }
      };
      element.querySelectorAll<HTMLImageElement>('img').forEach((image) => { void resolveImage(image); });
      imageObserver = new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'attributes' && change.target instanceof HTMLImageElement) void resolveImage(change.target);
          for (const added of change.addedNodes) {
            if (added instanceof HTMLImageElement) void resolveImage(added);
            else if (added instanceof Element) added.querySelectorAll<HTMLImageElement>('img').forEach((image) => { void resolveImage(image); });
          }
        }
      });
      imageObserver.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }).catch((cause: unknown) => {
      if (!disposed) { setError(cause instanceof Error ? `Milkdown no pudo interpretar el documento; la fuente original sigue intacta. ${cause.message}` : 'Milkdown no pudo interpretar el documento; la fuente original sigue intacta.'); setStatus('Editor visual no disponible'); }
    });
    return () => {
      disposed = true; armed.current = false; editor.current = null;
      imageObserver?.disconnect(); createdImageUrls.forEach((url) => URL.revokeObjectURL(url));
      void instance.destroy();
    };
  // Initial content defines this editor instance; subsequent keystrokes update only the draft state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.content, document?.canWrite, inspection.editable, loading, mode === 'source', visualGeneration, target.entityId, target.resourceId, sessionCurrent]);

  useEffect(() => {
    editor.current?.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => mode === 'visual' && !!document?.canWrite && sessionCurrent }));
    root.current?.querySelectorAll<HTMLInputElement>('.markdown-task-checkbox').forEach((input) => { input.disabled = mode !== 'visual' || !document?.canWrite || !sessionCurrent; });
  }, [mode, document?.canWrite, sessionCurrent]);

  async function save(): Promise<boolean> {
    const source = mode === 'source' ? sourceEditor.current?.read() : undefined;
    const content = source?.content ?? draftRef.current;
    updateDraft(content);
    const diagnostic = mode === 'source' && source ? source.diagnostic : parseError;
    setParseError(diagnostic);
    if (diagnostic) { setError(`Error de sintaxis Markdown en línea ${diagnostic.line}, columna ${diagnostic.column}: ${diagnostic.message} Se conserva el original hasta corregirlo.`); return false; }
    if (!document || content === document.content || !document.canWrite || !sessionCurrent || saving || !window.a3) return false;
    setSaving(true); setError(null); setStatus('Guardando…');
    try {
      const result = await window.a3.markdown({ action: 'save', sessionId: target.sessionId, entityId: document.entityId, resourceId: document.resourceId,
        entityRevision: document.entityRevision, expectedRevision: document.revision, expectedHash: document.hash, content });
      if (!result.ok || !('content' in result.value)) throw Object.assign(new Error(result.ok ? 'El host devolvió un recurso inesperado.' : result.error.message), { code: result.ok ? 'INVALID_RESPONSE' : result.error.code });
      setDocument(result.value); updateDraft(result.value.content); setStatus('Guardado'); setConflictDocument(null); setShowConflict(false);
      return true;
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      setError(cause instanceof Error ? `${code ? `${code}: ` : ''}${cause.message}` : 'No se pudo guardar el documento.');
      setStatus(code === 'REVISION_CONFLICT' ? 'Conflicto de revisión' : 'Guardado fallido');
      if (code === 'REVISION_CONFLICT' && window.a3) {
        const latest = await window.a3.markdown({ action: 'open', sessionId: target.sessionId, entityId: target.entityId, resourceId: target.resourceId });
        if (latest.ok && 'content' in latest.value) { setConflictDocument(latest.value); setShowConflict(true); }
      }
      return false;
    } finally { setSaving(false); }
  }

  function changeMode(next: 'visual' | 'source' | 'preview'): void {
    const source = mode === 'source' ? sourceEditor.current?.read() : undefined;
    const content = source?.content ?? draftRef.current;
    updateDraft(content);
    if (mode === 'source') {
      const diagnostic = source?.diagnostic ?? null;
      setParseError(diagnostic);
      if (diagnostic && next !== 'source') {
        setError(`Error de sintaxis Markdown en línea ${diagnostic.line}, columna ${diagnostic.column}: ${diagnostic.message}`);
        return;
      }
    }
    if (next !== 'source') {
      const nextInspection = inspectMarkdownSource(content);
      if (!nextInspection.editable) {
        setError(`La vista visual no puede preservar esta sintaxis (${nextInspection.reasons.join(', ')}); el borrador sigue disponible en modo fuente.`);
        return;
      }
      setVisualGeneration((value) => value + 1);
      setParseError(null);
    }
    setError(null); setMode(next);
  }

  function close(): void {
    if (dirty) { setConfirmClose(true); return; }
    onClose();
  }
  function useSavedConflict(): void {
    if (!conflictDocument || !window.confirm('Descartar el borrador local y usar la versión guardada que acabas de comparar. ¿Continuar?')) return;
    setDocument(conflictDocument); updateDraft(conflictDocument.content); setMode(inspectMarkdownSource(conflictDocument.content).editable ? 'visual' : 'source');
    setVisualGeneration((value) => value + 1); setConflictDocument(null); setShowConflict(false); setError(null); setStatus('Versión guardada seleccionada');
  }

  async function keepDraftConflict(): Promise<void> {
    if (!document || !conflictDocument || !conflictDocument.canWrite || !sessionCurrent || !window.a3) return;
    const source = mode === 'source' ? sourceEditor.current?.read() : undefined;
    const content = source?.content ?? draftRef.current;
    const diagnostic = mode === 'source' && source ? source.diagnostic : parseError;
    setParseError(diagnostic);
    if (diagnostic) { setError(`Error de sintaxis Markdown en línea ${diagnostic.line}, columna ${diagnostic.column}: ${diagnostic.message}`); return; }
    if (!window.confirm('Se guardará tu borrador completo sobre la revisión guardada que acabas de comparar. ¿Continuar?')) return;
    updateDraft(content);
    setSaving(true); setError(null); setStatus('Resolviendo conflicto…');
    try {
      const result = await window.a3.markdown({ action: 'save', sessionId: target.sessionId, entityId: conflictDocument.entityId,
        resourceId: conflictDocument.resourceId, entityRevision: conflictDocument.entityRevision, expectedRevision: conflictDocument.revision,
        expectedHash: conflictDocument.hash, content });
      if (!result.ok || !('content' in result.value)) throw Object.assign(new Error(result.ok ? 'Respuesta del host inválida.' : result.error.message), { code: result.ok ? 'INVALID_RESPONSE' : result.error.code });
      setDocument(result.value); updateDraft(result.value.content); setConflictDocument(null); setShowConflict(false); setError(null); setStatus('Conflicto resuelto · borrador guardado');
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      setError(`${code ? `${code}: ` : ''}${cause instanceof Error ? cause.message : 'No se pudo resolver el conflicto.'}`);
      setStatus('Conflicto sin resolver');
    } finally { setSaving(false); }
  }

  return <div className="markdown-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="markdown-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-title" aria-describedby="markdown-status"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      }}>
      <header className="markdown-header"><div><p className="eyebrow">Página · Markdown</p><h2 id="markdown-title">{target.title}</h2>
        <small>Entidad {target.entityId} · recurso y revisión compartidos entre workspaces</small></div>
        <button className="quiet" data-markdown-close onClick={close} aria-label="Cerrar editor Markdown">Cerrar</button></header>
      <div className="markdown-toolbar" role="toolbar" aria-label="Editor Markdown">
        <button data-markdown-visual aria-pressed={mode === 'visual'} onClick={() => changeMode('visual')} disabled={loading || !inspection.editable}>Visual</button>
        <button data-markdown-source-mode aria-pressed={mode === 'source'} onClick={() => changeMode('source')} disabled={loading}>Fuente</button>
        <button data-markdown-preview aria-pressed={mode === 'preview'} onClick={() => changeMode('preview')} disabled={loading || !inspection.editable}>Vista previa</button>
        <span id="markdown-status" role="status">{saving ? 'Guardando…' : status}</span>
        <button className="secondary" data-markdown-save onClick={() => void save()} disabled={!dirty || !document?.canWrite || !sessionCurrent || saving}>Guardar</button>
      </div>
      {!sessionCurrent && <p className="markdown-warning" role="alert">El proyecto activo cambió. El borrador sigue aquí, pero la sesión anterior ya no acepta escrituras; copia el texto antes de cerrar.</p>}
      {document?.readOnlyReason && <p className="markdown-warning" role="status">{document.readOnlyReason}</p>}
      {!inspection.editable && <p className="markdown-warning" role="status">Solo modo fuente: la vista visual no representa sin pérdida {inspection.reasons.join(', ')}. El contenido permanece editable aquí y no se interpreta como HTML.</p>}
      {parseError && <p className="markdown-error" role="alert" data-markdown-diagnostic>Error Markdown en línea {parseError.line}, columna {parseError.column}: {parseError.message} El archivo guardado permanece intacto hasta corregirlo.</p>}
      {error && <p className="markdown-error" role="alert">{error}</p>}
      {loading ? <p role="status">Leyendo Markdown UTF-8…</p> : !document ? <div className="markdown-source-fallback"><p>El recurso no se abrió; no se modificó.</p><button onClick={() => onClose()}>Cerrar</button></div> :
        <>
        {mode === 'source' && <Suspense fallback={<p role="status">Cargando editor de fuente…</p>}><MarkdownSourceEditor value={draft}
          editable={document.canWrite && sessionCurrent} controllerRef={sourceEditor}
          onChange={(value) => { updateDraft(value); setStatus('Cambios sin guardar'); setError(null); }} onDiagnostic={setParseError} /></Suspense>}
        {inspection.editable && <div hidden={mode === 'source'} className={`markdown-surface${mode === 'preview' ? ' is-preview' : ''}`} ref={root} data-markdown-editor={mode} onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        }} onPasteCapture={(event) => {
          const pasted = event.clipboardData.getData('text/plain');
          const checked = inspectMarkdownSource(pasted);
          if (pasted && !checked.editable) { event.preventDefault(); setError(`Pegado cancelado: sintaxis no compatible (${checked.reasons.join(', ')}). La fuente original se conserva.`); }
        }} />}
        </>}
      <footer className="markdown-footer"><span>{document ? `Revisión del recurso ${document.revision} · UTF-8` : 'Fuente Markdown original'}</span>
        {error?.includes('REVISION_CONFLICT') && conflictDocument && <button className="quiet" onClick={() => setShowConflict(true)}>Comparar y resolver</button>}
        <span className="markdown-footer-help">Tab para controles · Ctrl+S guarda desde el editor</span></footer>
      {confirmClose && <div className="markdown-confirm-backdrop"><section className="markdown-confirm" role="alertdialog" aria-modal="true" aria-labelledby="markdown-confirm-title">
        <h3 id="markdown-confirm-title">Hay cambios sin guardar</h3><p>Guarda el mismo recurso Markdown, descarta el borrador o sigue editando.</p>
        <div><button onClick={() => setConfirmClose(false)}>Seguir editando</button><button onClick={() => { setConfirmClose(false); onClose(); }}>Descartar borrador</button>
          <button className="secondary" disabled={!document?.canWrite || !sessionCurrent || saving} onClick={() => void save().then((saved) => { if (saved) { setConfirmClose(false); onClose(); } })}>Guardar y cerrar</button></div>
      </section></div>}
      {showConflict && conflictDocument && <div className="markdown-confirm-backdrop markdown-conflict-backdrop"><section className="markdown-conflict" data-markdown-conflict role="alertdialog" aria-modal="true" aria-labelledby="markdown-conflict-title">
        <h3 id="markdown-conflict-title">Comparar revisiones</h3><p>El archivo cambió después de abrirlo. Ambas fuentes se muestran como texto; ninguna se reemplaza hasta que elijas una resolución.</p>
        <div className="markdown-conflict-versions"><section><h4>Tu borrador local</h4><pre>{draftRef.current}</pre></section><section><h4>Versión guardada · rev. {conflictDocument.revision}</h4><pre>{conflictDocument.content}</pre></section></div>
        {error?.includes('REVISION_CONFLICT') && <p className="markdown-error" role="alert">La escritura quedó detenida por conflicto. Si el archivo cambió otra vez, vuelve a comparar.</p>}
        <div className="markdown-conflict-actions"><button data-markdown-conflict-cancel onClick={() => setShowConflict(false)}>Seguir editando borrador</button>
          <button data-markdown-conflict-use-saved onClick={useSavedConflict}>Descartar borrador y usar guardada</button>
          <button className="secondary" data-markdown-conflict-keep-draft disabled={!conflictDocument.canWrite || !sessionCurrent || saving} onClick={() => void keepDraftConflict()}>Conservar borrador sobre guardada</button></div>
      </section></div>}
    </section>
  </div>;
}
