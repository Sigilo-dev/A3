import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, LocalProjectsState } from '../../shared/desktop-api';
import { ProjectsPanel } from './ProjectsPanel';
import { FileExplorerPanel } from './FileExplorerPanel';
import { MediaGalleryPanel } from './MediaGalleryPanel';
import { ShortcutPreferences } from './shortcuts';
import { DiagramStylePreferences } from './DiagramStylePreferences';
import type { CodeEditorTarget, CodeEditorHandle } from './CodeEditor';
import type { FocusWorkspaceHandle } from './FocusWorkspace';
const FocusWorkspace = lazy(() => import('./FocusWorkspace').then((module) => ({ default: module.FocusWorkspace })));
const CodeEditorDialog = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditorDialog })));
const VariablesPanel = lazy(() => import('./VariablesPanel').then((module) => ({ default: module.VariablesPanel })));
const PromptCompilerPanel = lazy(() => import('./PromptCompilerPanel').then((module) => ({ default: module.PromptCompilerPanel })));
const PlanningPanel = lazy(() => import('./PlanningPanel').then((module) => ({ default: module.PlanningPanel })));

const sections = [
  ['projects', 'Proyectos', 'Inicio y selección de proyectos locales.'],
  ['canvas', 'Lienzo', 'Workspaces y navegación por el lienzo.'],
  ['files', 'Archivos', 'Explorador de archivos y carpetas referenciadas.'],
  ['search', 'Buscar', 'Búsqueda dentro del proyecto.'],
  ['gallery', 'Galería', 'Imágenes y videos del proyecto.'],
  ['tasks', 'Tareas', 'Checklist y trazabilidad del trabajo.'],
  ['prompts', 'Prompts', 'Plantillas y preparación de contexto.'],
  ['variables', 'Variables', 'Valores reutilizables del proyecto.'],
  ['memory', 'Memoria', 'Documentación y memoria del repositorio.'],
  ['nodes', 'Nodos y paquetes', 'Catálogo de nodos y extensiones.'],
  ['chat', 'Chat web', 'Consultas manuales con tu cuenta.'],
  ['agent', 'Agente', 'Asistencia y comandos bajo permisos del proyecto.'],
  ['github', 'GitHub', 'Conexión opcional de repositorios.'],
  ['history', 'Historial', 'Versiones y cambios del proyecto.'],
  ['preferences', 'Preferencias', 'Personalización y configuración.']
] as const;
type SectionId = typeof sections[number][0];

export function App(): React.JSX.Element {
  const [active, setActive] = useState<SectionId>('projects');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [projects, setProjects] = useState<LocalProjectsState | null>(null);
  const focus = useRef<FocusWorkspaceHandle | null>(null), codeController = useRef<CodeEditorHandle | null>(null);
  const [codeTarget, setCodeTarget] = useState<CodeEditorTarget | null>(null), [codeDirty, setCodeDirty] = useState(false);
  const [contentVersion, setContentVersion] = useState(0);
  const codeSaved = useCallback((): void => setContentVersion((v) => v + 1), []);
  const codeTargetRef = useRef(codeTarget); codeTargetRef.current = codeTarget;
  const codeDirtyRef = useRef(codeDirty); codeDirtyRef.current = codeDirty;
  const acceptProjects = (value: LocalProjectsState): void => setProjects((previous) => previous && previous.sequence > value.sequence ? previous : value);
  const openCode = useCallback((target: CodeEditorTarget): void => {
    if (codeTargetRef.current?.sessionId === target.sessionId && JSON.stringify(codeTargetRef.current.target) === JSON.stringify(target.target)) return;
    if (codeDirtyRef.current && !window.confirm('El archivo de código tiene cambios sin guardar. ¿Descartar el borrador y abrir otro archivo?')) return;
    setCodeTarget(target); setCodeDirty(false);
  }, []);
  const closeCode = useCallback((): void => { setCodeTarget(null); setCodeDirty(false); }, []);
  const updateCodeDirty = useCallback((dirty: boolean): void => setCodeDirty(dirty), []);
  const revealFocus = useCallback((): void => setActive('canvas'), []);
  const openGalleryWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (!focus.current) throw new Error('La sesión de workspace todavía no está lista.');
    await focus.current.openWorkspace(workspaceId);
  }, []);
  const showGalleryPlacement = useCallback(async (workspaceId: string, placementId: string): Promise<void> => {
    if (!focus.current) throw new Error('La sesión de workspace todavía no está lista.');
    await focus.current.openPlacement(workspaceId, placementId);
  }, []);
  async function beforeProjectSwitch(): Promise<boolean> {
    if (codeDirtyRef.current && (!window.confirm('¿Guardar el código antes de cambiar de proyecto? Cancelar conserva el archivo y la sesión abiertos.') || !await codeController.current?.save())) return false;
    return await focus.current?.settle('cambiar de proyecto') ?? true;
  }
  function selectSection(id: SectionId): void {
    if (id === 'canvas' && focus.current) { void focus.current.openCanvas().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se abrió el workspace.')); return; }
    void (focus.current?.flush() ?? Promise.resolve()).then(() => setActive(id)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se guardó el estado de la vista.'));
  }
  useEffect(() => {
    if (codeTargetRef.current && codeTargetRef.current.sessionId !== projects?.active?.sessionId) { setCodeTarget(null); setCodeDirty(false); }
  }, [projects?.active?.sessionId]);
  const section = sections.find(([id]) => id === active)!;

  useEffect(() => {
    let mounted = true;
    setError(null);
    const connect = async (): Promise<void> => {
      try {
        if (!window.a3) throw new Error('El puente de escritorio no está disponible. Reabre A3.');
        const result = await window.a3.getAppInfo();
        if (!mounted) return;
        if (result.ok) {
          setInfo(result.value);
          const local = await window.a3.projects({ action: 'restore' });
          if (mounted && local.ok) acceptProjects(local.value);
          else if (mounted && !local.ok) setError(local.error.message);
        }
        else setError(`${result.error.message} ${result.error.recovery}`);
      } catch {
        if (mounted) setError('No se pudo conectar con el proceso principal. Reintenta o reabre A3.');
      }
    };
    void connect();
    return () => { mounted = false; };
  }, [attempt]);

  return <div className="shell">
    <a href="#content" className="skip-link">Saltar al contenido</a>
    <header className="topbar">
      <span className="brand" aria-label="A3">A3<span className="brand-dot" /></span>
      <span className="project-name">{projects?.active?.name ?? 'Sin proyecto abierto'}</span>
      <span className="stage">Proyectos locales</span>
    </header>
    <aside className="sidebar">
      <p className="eyebrow">Tu espacio de trabajo</p>
      <nav aria-label="Herramientas de A3">
        {sections.map(([id, label], index) => <button key={id} data-section={id}
          aria-current={active === id ? 'page' : undefined} onClick={() => selectSection(id)}>
          <span className="nav-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{label}
        </button>)}
      </nav>
      <div className="sidebar-note">Local por diseño<br /><span>Windows · preparación inicial</span></div>
    </aside>
    <main id="content" className="content" tabIndex={-1}>
      <div className="breadcrumb">A3 <span>/</span> {section[1]}</div>
      {projects?.restoreNotice && <p role="status">{projects.restoreNotice}</p>}
      {active === 'projects' ? <ProjectsPanel state={projects} onChange={acceptProjects} beforeSwitch={beforeProjectSwitch} /> : active === 'canvas' ? !projects?.active && <p>Abre un proyecto para restaurar sus vistas.</p> : active === 'files' ? <FileExplorerPanel active={projects?.active} onOpenCode={openCode} contentVersion={contentVersion} onChanged={codeSaved} /> : active === 'gallery' ? <MediaGalleryPanel project={projects?.active ?? null} onOpenWorkspace={openGalleryWorkspace} onShowPlacement={showGalleryPlacement} /> : active === 'tasks' ? <Suspense fallback={<p>Cargando tareas…</p>}><PlanningPanel key={projects?.active?.sessionId} project={projects?.active ?? null} onChanged={codeSaved} onShowPlacement={showGalleryPlacement} /></Suspense> : active === 'variables' ? <Suspense fallback={<p>Cargando variables…</p>}><VariablesPanel key={projects?.active?.sessionId} project={projects?.active ?? null} onChanged={codeSaved} /></Suspense> : active === 'prompts' ? <Suspense fallback={<p>Cargando compilador…</p>}><PromptCompilerPanel key={projects?.active?.sessionId} project={projects?.active ?? null} /></Suspense> : active === 'preferences' ? <><ShortcutPreferences /><DiagramStylePreferences active={projects?.active ?? null} /></> : <><section className="intro" aria-labelledby="section-title">
        <p className="eyebrow">Un lugar para tus ideas</p>
        <h1 id="section-title">{section[1]}</h1>
        <p className="lead">{section[2]}</p>
        <div className="placeholder"><span className="status-dot" />
          <div><strong>Área preparada</strong><p>La navegación está disponible. Las funciones de esta sección se incorporarán en las próximas etapas.</p></div>
        </div>
      </section></>}
      {projects?.active && <Suspense fallback={active === 'canvas' ? <p role="status">Restaurando sesión…</p> : null}><FocusWorkspace key={projects.active.sessionId} project={projects.active} visible={active === 'canvas'} onReveal={revealFocus}
        controllerRef={focus} onOpenCode={openCode} contentVersion={contentVersion} onSaved={codeSaved} onProjectsChanged={() => {
          void window.a3?.projects({ action: 'list' }).then((result) => { if (result.ok) acceptProjects(result.value); else setError(result.error.message); });
        }} /></Suspense>}
      {active !== 'projects' && active !== 'canvas' && active !== 'gallery' && active !== 'variables' && active !== 'prompts' && active !== 'tasks' && <section className="foundation" aria-labelledby="foundation-title">
        <div><p className="eyebrow">Primer paso</p><h2 id="foundation-title">Una base común</h2></div>
        <p>Explora las secciones desde la barra izquierda. Esta entrega prepara la ventana y la comunicación de escritorio.</p>
        <button className="secondary" onClick={() => setActive('preferences')}>Ver Preferencias <span aria-hidden="true">↗</span></button>
      </section>}
      {error && <div className="error" role="alert"><p>{error}</p>
        <button onClick={() => setAttempt((value) => value + 1)}>Reintentar conexión</button></div>}
    </main>
    <aside className="inspector" aria-label="Estado de escritorio">
      <p className="eyebrow">Escritorio</p><h2>Estado del proyecto</h2>
      <p role="status" className="connection">{error ? 'Conexión con error' : info ? 'Proceso principal conectado' : 'Conectando…'}</p>
      {info && <dl>
        <dt>Aplicación</dt><dd>{info.name} {info.version}</dd>
        <dt>Plataforma</dt><dd>{info.platform}</dd>
        <dt>Electron</dt><dd>{info.electron}</dd>
        <dt>Chromium</dt><dd>{info.chromium}</dd>
        <dt>Node del host</dt><dd>{info.node}</dd>
      </dl>}
      <p className="inspector-note">{projects?.active ? `${projects.active.name} · ${projects.active.externalConflict ? 'Conflicto externo' : projects.active.pendingName || projects.active.pendingViewport ? 'Sin guardar' : projects.active.mode === 'writer' ? 'Guardado' : 'Solo lectura'}. Los permisos se aplican a esta carpeta.` : 'Crea o abre un proyecto desde Inicio. Las aprobaciones de carpetas pertenecen a este dispositivo.'}</p>
    </aside>
    <footer className="statusbar">
      <span><span className="status-dot" />{info && !error ? 'Escritorio listo' : 'Verificando escritorio'}</span>
      <button aria-expanded={activityOpen} aria-controls="activity" onClick={() => setActivityOpen(!activityOpen)}>
        {activityOpen ? 'Cerrar actividad' : 'Ver actividad'}</button>
    </footer>
    {activityOpen && <section id="activity" className="activity" aria-label="Actividad de inicio">
      <h2>Actividad de inicio</h2><p>{error ?? (info ? 'Ventana y puente de escritorio iniciados.' : 'Esperando conexión del proceso principal.')}</p>
    </section>}
    {codeTarget && <Suspense fallback={<div className="markdown-backdrop"><p role="status">Preparando editor de código…</p></div>}>
      <CodeEditorDialog key={`${codeTarget.sessionId}:${JSON.stringify(codeTarget.target)}`} target={codeTarget} activeSessionId={projects?.active?.sessionId ?? null} onDirtyChange={updateCodeDirty} onSaved={codeSaved} onClose={closeCode} controllerRef={codeController} />
    </Suspense>}
  </div>;
}
