import { useEffect, useRef, useState } from 'react';
import type { FilesRequest, LocalExplorerDeletePreview, LocalExplorerEntry, LocalExplorerListing, LocalExplorerOpen, LocalProjectSession } from '../../shared/desktop-api';
import type { CodeEditorTarget } from './CodeEditor';

type Crumb = { id: string; name: string };
export function FileExplorerPanel({ active, onOpenCode, contentVersion }: { active: LocalProjectSession | null | undefined; onOpenCode: (target: CodeEditorTarget) => void; contentVersion: number }): React.JSX.Element {
  const [stack, setStack] = useState<Crumb[]>([{ id: 'project-root', name: 'Proyecto' }]);
  const [listing, setListing] = useState<LocalExplorerListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<LocalExplorerOpen | null>(null);
  const [deleting, setDeleting] = useState<LocalExplorerDeletePreview | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const current = stack.at(-1)!;
  const writable = active?.mode === 'writer';

  async function load(directoryId: string, replace = true, cursor?: string): Promise<void> {
    const api = window.a3; if (!active || !api) return;
    setBusy(true); setError(null);
    try {
      const result = await api.files({ action: 'list', sessionId: active.sessionId, directoryId, ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      if (!('entries' in result.value)) throw new Error('El host devolvió una respuesta de explorador inválida.');
      const page = result.value as LocalExplorerListing;
      setListing((previous) => replace || !previous ? page : { ...page, entries: [...previous.entries, ...page.entries] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo leer esta carpeta.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    setStack([{ id: 'project-root', name: 'Proyecto' }]); setListing(null); setSelected(null); setOpened(null); setDeleting(null);
    if (active) void load('project-root');
  }, [active?.sessionId]);
  const lastContentVersion = useRef(contentVersion);
  useEffect(() => {
    if (lastContentVersion.current === contentVersion) return;
    lastContentVersion.current = contentVersion;
    setSelected(null); setOpened(null);
    if (active) void load(current.id);
  }, [contentVersion]);

  async function mutate(request: FilesRequest, returnTo = current.id): Promise<void> {
    const api = window.a3; if (busy || !active || !api) return;
    setBusy(true); setError(null);
    try {
      const result = await api.files(request);
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
      if ('changed' in result.value) { setOpened(null); setDeleting(null); setSelected(null); await load(returnTo); }
      else if ('cancelled' in result.value) setDeleting(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'La operación no se completó.'); }
    finally { setBusy(false); }
  }
  const selectedEntry = listing?.entries.find((entry) => entry.id === selected);
  async function openEntry(entry: LocalExplorerEntry): Promise<void> {
    setSelected(entry.id);
    if (entry.kind === 'directory') { setStack((items) => [...items, { id: entry.id, name: entry.name }]); setOpened(null); await load(entry.id); return; }
    const api = window.a3; if (entry.kind !== 'file' || !active || !api) return;
    const result = await api.files({ action: 'open', sessionId: active.sessionId, itemId: entry.id });
    if (result.ok && 'text' in result.value) setOpened(result.value); else if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
  }
  async function startDelete(entry = selectedEntry): Promise<void> {
    const api = window.a3; if (!entry || !active || !api || entry.kind === 'blocked-link' || !writable) return;
    const result = await api.files({ action: 'preview-delete', sessionId: active.sessionId, itemId: entry.id });
    if (result.ok && 'token' in result.value) setDeleting(result.value);
    else if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
  }
  function onTreeKey(event: React.KeyboardEvent<HTMLButtonElement>, entry: LocalExplorerEntry, index: number): void {
    const rows = listing?.entries ?? [];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]; if (next) rowRefs.current.get(next.id)?.focus();
    } else if (event.key === 'ArrowRight' && entry.kind === 'directory') { event.preventDefault(); void openEntry(entry); }
    else if (event.key === 'ArrowLeft' && stack.length > 1) { event.preventDefault(); setStack((items) => items.slice(0, -1)); void load(stack.at(-2)!.id); }
    else if (event.key === 'Enter') { event.preventDefault(); void openEntry(entry); }
    else if (event.key === 'F2' && writable && entry.kind !== 'blocked-link') {
      event.preventDefault(); const next = window.prompt('Nuevo nombre', entry.name); if (next && active) void mutate({ action: 'rename', sessionId: active.sessionId, itemId: entry.id, name: next });
    } else if (event.ctrlKey && event.key.toLowerCase() === 'd' && writable && entry.kind !== 'blocked-link') {
      event.preventDefault(); if (active) void mutate({ action: 'duplicate', sessionId: active.sessionId, itemId: entry.id });
    } else if (event.key === 'Delete' && writable) { event.preventDefault(); setSelected(entry.id); void startDelete(entry); }
  }

  if (!active) return <section className="files-panel"><p className="eyebrow">Explorador</p><h1 id="section-title">Archivos.</h1><p className="lead">Abre un proyecto local desde Inicio para ver sus archivos.</p></section>;
  return <section className="files-panel" aria-busy={busy}>
    <div className="project-heading"><div><p className="eyebrow">Proyecto local · {active.mode === 'writer' ? 'lectura y escritura según permisos' : 'solo lectura'}</p><h1 id="section-title">Archivos.</h1></div>
      <button className="quiet" onClick={() => void load(current.id)} disabled={busy}>Actualizar</button></div>
    <p className="lead">{active.name} <span className="path">· {current.name === 'Proyecto' ? 'raíz' : current.name}</span></p>
    {error && <div className="error" role="alert" data-file-error>{error}</div>}
    <div className="file-toolbar" aria-label="Acciones de carpeta">
      {stack.length > 1 && <button className="secondary" onClick={() => { setStack((items) => items.slice(0, -1)); void load(stack.at(-2)!.id); }} disabled={busy}>← Subir carpeta</button>}
      <form onSubmit={(event) => { event.preventDefault(); if (active && name.trim()) void mutate({ action: 'create-file', sessionId: active.sessionId, parentId: current.id, name: name.trim() }); }}>
        <input id="new-file-name" aria-label="Nombre del archivo nuevo" value={name} onChange={(event) => setName(event.target.value)} placeholder="nota.md" disabled={!writable || busy} />
        <button className="secondary" type="submit" data-create-file disabled={!writable || busy || !name.trim()}>Crear archivo</button>
      </form>
      <button className="secondary" data-create-folder disabled={!writable || busy || !name.trim()} onClick={() => active && void mutate({ action: 'create-folder', sessionId: active.sessionId, parentId: current.id, name: name.trim() })}>Crear carpeta</button>
    </div>
    <div className="file-layout">
      <div className="file-list-column">
        <div className="file-crumbs" aria-label="Ruta del explorador">{stack.map((crumb, index) => <button key={crumb.id} className="quiet" aria-current={index === stack.length - 1 ? 'location' : undefined}
          onClick={() => { setStack((items) => items.slice(0, index + 1)); void load(crumb.id); }}>{crumb.name}</button>)}</div>
        <div role="tree" aria-label="Archivos del proyecto" className="file-tree">
          {!listing?.entries.length && !busy && <p className="muted">Esta carpeta está vacía.</p>}
          {listing?.entries.map((entry, index) => <button role="treeitem" aria-selected={selected === entry.id} key={entry.id} data-file-entry data-file-item-id={entry.id} data-resource-id={entry.resourceId}
            ref={(element) => { if (element) rowRefs.current.set(entry.id, element); else rowRefs.current.delete(entry.id); }}
            onClick={() => setSelected(entry.id)} onDoubleClick={() => void openEntry(entry)} onKeyDown={(event) => onTreeKey(event, entry, index)} className="file-row">
            <span className="file-kind" aria-hidden="true">{entry.kind === 'directory' ? '▰' : entry.kind === 'blocked-link' ? '↗' : '▧'}</span>
            <span className="file-name">{entry.name}</span><span className="file-state">{entry.kind === 'blocked-link' ? 'enlace bloqueado' : entry.readOnly ? 'solo lectura' : entry.resourceId ? 'recurso' : ''}</span>
          </button>)}
        </div>
        {listing?.nextCursor && <button className="quiet" disabled={busy} onClick={() => void load(current.id, false, listing.nextCursor!)}>Cargar más…</button>}
        {selectedEntry && <div className="file-actions" aria-label={`Acciones para ${selectedEntry.name}`}>
          <button className="secondary" data-file-open onClick={() => void openEntry(selectedEntry)} disabled={busy || selectedEntry.kind === 'blocked-link'}>Abrir</button>
          {selectedEntry.kind === 'file' && <button className="secondary" data-file-edit onClick={() => onOpenCode({ sessionId: active.sessionId, title: selectedEntry.name, target: { itemId: selectedEntry.id } })} disabled={busy}>Abrir editor de código</button>}
          <button className="secondary" data-file-rename disabled={!writable || busy || selectedEntry.kind === 'blocked-link'} onClick={() => {
            const next = window.prompt('Nuevo nombre', selectedEntry.name); if (next && active) void mutate({ action: 'rename', sessionId: active.sessionId, itemId: selectedEntry.id, name: next });
          }}>Renombrar</button>
          <button className="secondary" data-file-duplicate disabled={!writable || busy || selectedEntry.kind === 'blocked-link'} onClick={() => active && void mutate({ action: 'duplicate', sessionId: active.sessionId, itemId: selectedEntry.id })}>Duplicar</button>
          <button className="quiet" disabled={busy || selectedEntry.kind === 'blocked-link'} onClick={() => active && void mutate({ action: 'copy-path', sessionId: active.sessionId, itemId: selectedEntry.id, kind: 'absolute' })}>Copiar ruta absoluta</button>
          <button className="quiet" disabled={busy || selectedEntry.kind === 'blocked-link'} onClick={() => active && void mutate({ action: 'copy-path', sessionId: active.sessionId, itemId: selectedEntry.id, kind: 'relative' })}>Copiar ruta relativa</button>
          <button className="quiet danger" data-file-delete disabled={!writable || busy || selectedEntry.kind === 'blocked-link'} onClick={() => void startDelete()}>Enviar a papelera</button>
        </div>}
      </div>
      <aside className="file-side">
        <section aria-labelledby="mounts-title"><p className="eyebrow">Referencias externas</p><h2 id="mounts-title">Montajes</h2>
          {!listing?.mounts.length && <p className="muted">Este proyecto no tiene recursos montados.</p>}
          {listing?.mounts.map((mount) => <div className="mount-row" key={mount.id} data-mount-status={mount.status}>
            <strong>{mount.name}</strong><span>{mount.status === 'available' ? 'Disponible · solo lectura' : mount.status === 'missing' ? 'Archivo o carpeta ausente' : mount.status === 'changed' ? 'La ruta cambió o no se puede validar' : 'Requiere aprobación local'}</span>
            <button className="quiet" disabled={busy || mount.status !== 'available'} onClick={async () => {
              const api = window.a3; if (!api) return;
              const result = await api.files({ action: 'open-mount', sessionId: active.sessionId, resourceId: mount.id });
              if (result.ok && 'text' in result.value) setOpened(result.value); else if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
            }}>Abrir referencia</button>
            <button className="quiet" data-edit-mounted-code disabled={busy || mount.status !== 'available'} onClick={() => onOpenCode({ sessionId: active.sessionId, title: mount.name, target: { resourceId: mount.id } })}>Ver código · solo lectura</button>
            <button className="quiet" disabled={busy || mount.status !== 'available'} onClick={() => void mutate({ action: 'copy-mount-path', sessionId: active.sessionId, resourceId: mount.id, kind: 'absolute' })}>Copiar ruta absoluta</button>
            <button className="quiet" disabled={busy || mount.status !== 'available'} onClick={() => void mutate({ action: 'copy-mount-path', sessionId: active.sessionId, resourceId: mount.id, kind: 'relative' })}>Copiar ruta relativa</button>
          </div>)}
        </section>
        {opened && <section className="file-preview" aria-label="Vista previa del archivo"><div className="project-heading"><h2>{opened.name}</h2><button className="quiet" data-cancel-file-preview onClick={() => setOpened(null)}>Cerrar</button></div>
          <p className="path">{opened.relativePath} · {opened.size.toLocaleString()} bytes</p>
          {opened.text === null ? <p className="muted">Vista previa de texto no disponible para este archivo binario.</p> : <pre tabIndex={0}>{opened.text}</pre>}
        </section>}
      </aside>
    </div>
    {deleting && <div className="modal-backdrop"><section className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
      <p className="eyebrow">Confirmar eliminación</p><h2 id="delete-title">Enviar «{deleting.name}» a la papelera</h2>
      <p id="delete-description">Los bytes se moverán a la papelera local recuperable del proyecto. No se borrarán definitivamente.</p>
      {deleting.uses.length > 0 && <><p>Este recurso está siendo utilizado por:</p><ul>{deleting.uses.map((use) => <li key={use.entityId}>{use.title} <code>{use.entityId}</code></li>)}</ul><p className="muted">Quita primero esas referencias; el recurso se conserva.</p></>}
      {deleting.reason && deleting.uses.length === 0 && <p className="muted">{deleting.reason}</p>}
      <div className="input-row"><button className="primary" data-confirm-file-delete disabled={!deleting.deletable || !writable || busy} onClick={() => active && void mutate({ action: 'confirm-delete', sessionId: active.sessionId, token: deleting.token })}>Enviar a papelera</button>
        <button className="secondary" data-cancel-file-delete disabled={busy} onClick={() => active && void mutate({ action: 'cancel-delete', sessionId: active.sessionId, token: deleting.token })}>Cancelar</button></div>
    </section></div>}
  </section>;
}
