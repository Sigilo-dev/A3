import { useEffect, useState } from 'react';
import type { LocalProjectsState, ProjectsRequest } from '../../shared/desktop-api';

export function ProjectsPanel({ state, onChange }: { state: LocalProjectsState | null; onChange: (value: LocalProjectsState) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [rename, setRename] = useState(state?.active?.draftName ?? state?.active?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = state?.active;
  useEffect(() => { setRename(active?.draftName ?? active?.name ?? ''); }, [active?.name, active?.sessionId]);
  useEffect(() => { setName(''); setError(null); }, [active?.sessionId]);
  async function run(request: ProjectsRequest): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (!window.a3) throw new Error('El puente de escritorio no está disponible. Reabre A3.');
      const result = await window.a3.projects(request);
      if (result.ok) onChange(result.value);
      else {
        const current = await window.a3.projects({ action: 'list' }); if (current.ok) onChange(current.value);
        setError(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
      }
    } catch { setError('No se pudo comunicar con el host. Reintenta o reabre A3 para revisar la recuperación.'); }
    finally { setBusy(false); }
  }
  return <section className="projects" aria-busy={busy}>
    <p className="eyebrow">Tu trabajo empieza aquí</p>
    <h1 id="section-title">Proyectos locales.</h1>
    <p className="lead">Una carpeta con tus documentos, referencias y espacios de trabajo. Disponible sin conexión.</p>
    {error && <div className="error" role="alert" data-project-error>{error}</div>}
    {active && <section className="project-card" data-active-project aria-label="Proyecto abierto">
      <div className="project-heading"><div><p className="eyebrow">Proyecto abierto</p><h2>{active.name}</h2></div><span className="badge">{active.externalConflict ? 'Conflicto externo' : active.mode !== 'writer' ? 'Solo lectura' : rename !== active.name ? 'Sin guardar' : 'Guardado'}</span></div>
      <p className="path">{active.root}</p>
      <p>Formato {active.format} · {active.workspaces.length} espacio(s)</p>
      <ul className="workspace-list">{active.workspaces.map((workspace) => <li key={workspace.id}>{workspace.name}</li>)}</ul>
      {active.diagnostics.length > 0 && <details><summary>Problemas del proyecto ({active.diagnostics.length})</summary><ul>{active.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul></details>}
      <form onSubmit={(event) => { event.preventDefault(); void run({ action: 'rename', sessionId: active.sessionId, name: rename }); }}>
        <label htmlFor="rename-project">Nombre del proyecto</label><div className="input-row"><input id="rename-project" value={rename} maxLength={120} onChange={(event) => {
          const value = event.target.value; setRename(value);
          void window.a3?.projects({ action: 'draft-name', sessionId: active.sessionId, name: value }).then((result) => { if (result.ok) onChange(result.value); else setError(result.error.message); }).catch(() => setError('No se pudo conservar el borrador del nombre. Guarda antes de cambiar de proyecto.'));
        }} disabled={busy || active.mode !== 'writer'} />
          <button className="secondary" type="submit" disabled={busy || active.mode !== 'writer' || !rename.trim() || rename === active.name}>Guardar nombre</button></div>
      </form>
      {rename !== active.name && <button className="quiet" disabled={busy} onClick={() => { setRename(active.name); void run({ action: 'draft-name', sessionId: active.sessionId, name: active.name }); }}>Descartar cambio de nombre</button>}
      <button className="quiet" disabled={busy} data-close-project onClick={() => void run({ action: 'close', sessionId: active.sessionId })}>Cerrar proyecto</button>
      <p className="muted">Git es opcional. Este proyecto funciona sin Git ni GitHub.</p>
    </section>}
    <div className="project-actions">
      <form className="project-card" onSubmit={(event) => { event.preventDefault(); void run({ action: 'create', name }); }}>
        <h2>Crear proyecto</h2><label htmlFor="project-name">Nombre y carpeta nueva</label>
        <input id="project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Mi próximo proyecto" disabled={busy} />
        <button className="primary" type="submit" data-create-project disabled={busy || !name.trim()}>Elegir ubicación y previsualizar</button>
      </form>
      <section className="project-card"><h2>Abrir una carpeta</h2><p>Abre un proyecto A3 o incorpora una carpeta existente después de revisar los metadatos que se añadirán.</p>
        <button className="secondary" data-open-project disabled={busy} onClick={() => void run({ action: 'open' })}>Elegir carpeta</button></section>
    </div>
    {state?.preview && <section className="project-card preview" data-project-preview aria-label="Vista previa de metadatos">
      <p className="eyebrow">{state.preview.kind === 'create' ? 'Nuevo proyecto' : 'Incorporar carpeta existente'}</p><h2>{state.preview.name}</h2><p className="path">{state.preview.root}</p>
      <p>Se añadirán estos archivos y el espacio «Principal». Los archivos existentes conservan sus bytes y ubicación.</p>
      <ul>{state.preview.files.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      <details><summary>Carpetas que se crearán o reutilizarán ({state.preview.directories.length})</summary><ul>{state.preview.directories.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>
      {state.preview.existingEntries.length > 0 && <p className="muted">Contenido previo: {state.preview.existingEntries.join(', ')}</p>}
      <div className="input-row"><button className="primary" data-confirm-project disabled={busy} onClick={() => void run({ action: 'confirm', token: state.preview!.token })}>Confirmar metadatos</button>
        <button className="quiet" data-cancel-project disabled={busy} onClick={() => void run({ action: 'cancel', token: state.preview!.token })}>Cancelar</button></div>
    </section>}
    <section className="recents"><div className="project-heading"><h2>Proyectos recientes</h2><button className="quiet" disabled={busy} onClick={() => void run({ action: 'list' })}>Actualizar</button></div>
      {!state?.recents.length ? <p className="muted">Tus proyectos aparecerán aquí al abrirlos.</p> : <ul>{state.recents.map((recent) => <li key={recent.id} className="recent-row">
        <div><strong>{recent.name}</strong><p className="path">{recent.root}</p>{!recent.available && <span className="unavailable">Carpeta ausente · Puedes localizarla</span>}</div>
        <div className="recent-buttons"><button className="secondary" data-open-recent disabled={busy} onClick={() => void run({ action: 'recent', id: recent.id })}>Abrir</button>
          <button className="quiet" data-relocate-project disabled={busy} onClick={() => void run({ action: 'relocate', id: recent.id })}>Localizar</button></div>
      </li>)}</ul>}
    </section>
    <p role="status" className="muted">{busy ? 'Procesando… Espera la confirmación del guardado.' : 'Los proyectos y sus archivos permanecen en tu dispositivo.'}</p>
  </section>;
}
