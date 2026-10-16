import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import { basicSetup, EditorView } from 'codemirror';
import type { CodeDocument, CodeOpenTarget } from '../../shared/desktop-api';
import { CODE_LANGUAGES, codeLanguageFor, loadCodeLanguage, type CodeLanguage } from './code-languages';
import { editorStyleNonce } from './editor-style';

export interface CodeEditorTarget { sessionId: string; target: CodeOpenTarget; title: string; }
export interface CodeEditorHandle { save(): Promise<boolean>; }
interface CodeBuffer { read(): string; find(): void; }

function CodeSurface({ initial, lineEnding, editable, language, controller, onChange, onError }: {
  initial: string; lineEnding: CodeDocument['lineEnding']; editable: boolean; language: CodeLanguage;
  controller: React.MutableRefObject<CodeBuffer | null>; onChange: (content: string) => void; onError: (message: string) => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const permissions = useRef(new Compartment()), syntax = useRef(new Compartment());
  const callbacks = useRef({ onChange, onError }); callbacks.current = { onChange, onError };
  useEffect(() => {
    if (!host.current) return;
    const separator = lineEnding === 'crlf' ? '\r\n' : '\n';
    const read = (state: EditorState): string => state.doc.toString().replace(/\n/g, separator);
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial,
      extensions: [basicSetup, EditorView.cspNonce.of(editorStyleNonce()), indentUnit.of('  '), EditorState.lineSeparator.of(separator), syntax.current.of([]),
        permissions.current.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
        EditorView.contentAttributes.of({ 'aria-label': 'Código fuente del archivo', spellcheck: 'false', tabindex: '0' }),
        EditorView.updateListener.of((update) => { if (update.docChanged) callbacks.current.onChange(read(update.state)); })]
    }) });
    view.current = editor; controller.current = { read: () => read(editor.state), find: () => { openSearchPanel(editor); } };
    editor.focus();
    return () => { controller.current = null; view.current = null; editor.destroy(); };
  // A new key remounts this view only when the user explicitly selects a saved version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: permissions.current.reconfigure([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]) });
  }, [editable]);
  useEffect(() => {
    let live = true;
    void loadCodeLanguage(language).then((extension) => { if (live) view.current?.dispatch({ effects: syntax.current.reconfigure(extension) }); })
      .catch(() => { if (live) callbacks.current.onError('El resaltado no se pudo cargar; el contenido permanece disponible como texto.'); });
    return () => { live = false; };
  }, [language]);
  return <div ref={host} className="markdown-source-editor code-source-editor" data-code-editor data-code-language={language} />;
}

export function CodeEditorDialog({ target, activeSessionId, onDirtyChange, onSaved, onClose, controllerRef }: {
  target: CodeEditorTarget; activeSessionId: string | null; onDirtyChange: (dirty: boolean) => void; onSaved: () => void; onClose: () => void;
  controllerRef?: Ref<CodeEditorHandle>;
}): React.JSX.Element {
  const [document, setDocument] = useState<CodeDocument | null>(null), [draft, setDraft] = useState('');
  const draftRef = useRef(''), controller = useRef<CodeBuffer | null>(null);
  const [language, setLanguage] = useState<CodeLanguage>('text'), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null), [status, setStatus] = useState('Leyendo archivo…');
  const [confirmClose, setConfirmClose] = useState(false), [latest, setLatest] = useState<CodeDocument | null>(null), [compare, setCompare] = useState(false), [epoch, setEpoch] = useState(0);
  const sessionCurrent = activeSessionId === target.sessionId, dirty = document?.content !== null && !!document && draft !== document.content;
  useImperativeHandle(controllerRef, () => ({ save }));
  const updateDraft = (value: string): void => { draftRef.current = value; setDraft(value); };
  const accept = (value: CodeDocument): void => { setDocument(value); updateDraft(value.content ?? ''); setStatus(value.canWrite ? 'Guardado' : 'Solo lectura'); };
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  useEffect(() => {
    let live = true;
    void window.a3?.code({ action: 'open', sessionId: target.sessionId, target: target.target }).then((result) => {
      if (!live) return;
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      accept(result.value); setLanguage(codeLanguageFor(result.value.relativePath, result.value.languageHint));
    }).catch((cause: unknown) => { if (live) { setError(cause instanceof Error ? cause.message : 'No se pudo abrir el archivo.'); setStatus('Error de lectura'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // App keys the editor by session and target identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function refreshComparison(): Promise<void> {
    if (!document || !window.a3) return;
    const result = await window.a3.code({ action: 'reload', sessionId: target.sessionId, documentId: document.documentId });
    if (result.ok) { setLatest(result.value); setCompare(true); }
    else setError(`${result.error.code}: ${result.error.message} El borrador local sigue disponible.`);
  }
  async function save(base = document): Promise<boolean> {
    if (!base || !window.a3 || saving || !sessionCurrent || !base.canWrite) return false;
    const content = controller.current?.read() ?? draftRef.current; updateDraft(content);
    if (content === base.content) { accept(base); setLatest(null); setCompare(false); return true; }
    setSaving(true); setError(null); setStatus('Guardando…');
    try {
      const result = await window.a3.code({ action: 'save', sessionId: target.sessionId, documentId: base.documentId, expectedRevision: base.revision, expectedHash: base.hash, content });
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      accept(result.value); onSaved(); setLatest(null); setCompare(false); return true;
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'IO_FAILED';
      setError(`${code}: ${cause instanceof Error ? cause.message : 'El archivo no se guardó.'}`); setStatus('Sin guardar');
      if (code === 'REVISION_CONFLICT') await refreshComparison();
      return false;
    } finally { setSaving(false); }
  }
  const close = (): void => { if (dirty) setConfirmClose(true); else onClose(); };
  return <div className="markdown-backdrop"><section className="markdown-dialog code-dialog" role="dialog" aria-modal="true" aria-labelledby="code-title" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    if (event.key === 'Escape' && !compare) { event.preventDefault(); close(); }
  }}>
    <header className="markdown-header"><div><p className="eyebrow">Archivo · código fuente</p><h2 id="code-title">{document?.name ?? target.title}</h2><small>{document?.relativePath ?? 'Lectura por identidad del host'}</small></div>
      <button className="quiet" data-code-close onClick={close}>Cerrar</button></header>
    <div className="markdown-toolbar"><label className="code-language-label">Lenguaje <select data-code-language-select value={language} onChange={(event) => setLanguage(event.target.value as CodeLanguage)} disabled={loading || document?.content === null}>
      {CODE_LANGUAGES.map((name) => <option key={name} value={name}>{name === 'cpp' ? 'C / C++' : name === 'text' ? 'Texto' : name}</option>)}</select></label>
      <button data-code-find disabled={!document || document.content === null} onClick={() => controller.current?.find()}>Buscar / reemplazar</button>
      <span role="status" data-code-status>{status}</span><button className="secondary" data-code-save disabled={!dirty || !document?.canWrite || !sessionCurrent || saving} onClick={() => void save()}>Guardar</button></div>
    {!sessionCurrent && <p className="markdown-warning">La sesión cambió; copia el borrador antes de cerrar. Esta vista no puede escribir en el proyecto nuevo.</p>}
    {document?.readOnlyReason && <p className="markdown-warning" data-code-readonly>{document.readOnlyReason}</p>}
    {error && <p className="markdown-error" role="alert" data-code-error>{error}</p>}
    {loading ? <p role="status">Leyendo bytes originales…</p> : !document ? <p>No se abrió el archivo. Los bytes no se modificaron.</p> : document.content === null
      ? <div className="markdown-source-fallback" data-code-state={document.state}><p>{document.readOnlyReason}</p><p>{document.size} bytes · sin interpretación como texto</p></div>
      : <CodeSurface key={`${document.documentId}:${epoch}`} initial={draft} editable={document.canWrite && sessionCurrent && !saving} lineEnding={document.lineEnding} language={language} controller={controller}
        onChange={(value) => { updateDraft(value); setStatus('Sin guardar'); }} onError={setError} />}
    <footer className="markdown-footer"><span>{document ? `${document.encoding ?? 'Codificación no reconocida'} · ${document.lineEnding.toUpperCase()} · revisión ${document.revision ?? 'sin registrar'}` : 'Fuente original'}</span>
      {document && <button className="quiet" data-code-compare onClick={() => void refreshComparison()}>Comparar con archivo guardado</button>}<span>Ctrl+S · Ctrl+F · plegado en el margen</span></footer>
    {confirmClose && <div className="markdown-confirm-backdrop"><section className="markdown-confirm" role="alertdialog" aria-modal="true" aria-labelledby="code-close-title"><h3 id="code-close-title">Cambios sin guardar</h3><p>Conserva el borrador abierto, guárdalo o descártalo explícitamente.</p>
      <button onClick={() => setConfirmClose(false)}>Seguir editando</button><button data-code-discard onClick={onClose}>Descartar</button><button disabled={saving || !document?.canWrite || !sessionCurrent} onClick={() => void save().then((ok) => { if (ok) onClose(); })}>Guardar y cerrar</button></section></div>}
    {compare && latest && <div className="markdown-confirm-backdrop markdown-conflict-backdrop"><section className="markdown-conflict" data-code-conflict role="alertdialog" aria-modal="true" aria-labelledby="code-conflict-title"><h3 id="code-conflict-title">Comparar archivo y borrador</h3>
      <div className="markdown-conflict-versions"><section><h4>Borrador local</h4><pre>{draftRef.current}</pre></section><section><h4>Archivo guardado</h4><pre>{latest.content ?? latest.readOnlyReason}</pre></section></div>
      <div className="markdown-conflict-actions"><button data-code-compare-close onClick={() => setCompare(false)}>Seguir editando</button><button data-code-use-saved onClick={() => {
        if (!window.confirm('¿Descartar el borrador y usar la versión guardada comparada?')) return; accept(latest); setEpoch((n) => n + 1); setCompare(false); setLatest(null); setError(null);
      }}>Usar guardada</button><button data-code-keep-draft disabled={!latest.canWrite || !sessionCurrent || saving} onClick={() => {
        if (window.confirm('¿Guardar el borrador completo sobre la revisión comparada? El host volverá a validar sus hashes y permisos.')) void save(latest);
      }}>Conservar borrador sobre guardada</button><button onClick={() => void refreshComparison()}>Actualizar comparación</button></div>
      {!latest.canWrite && <p>{latest.readOnlyReason}</p>}
    </section></div>}
  </section></div>;
}
