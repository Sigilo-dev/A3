import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, LocalProjectsState } from '../../shared/desktop-api';
import { ProjectsPanel } from './ProjectsPanel';
import { FileExplorerPanel } from './FileExplorerPanel';
import type { MarkdownEditorTarget } from './MarkdownEditor';
import type { CodeEditorTarget } from './CodeEditor';
const CodeEditorDialog = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditorDialog })));
const CanvasPanel = lazy(() => import('./CanvasPanel').then((module) => ({ default: module.CanvasPanel })));
const MarkdownEditorDialog = lazy(() => import('./MarkdownEditor').then((module) => ({ default: module.MarkdownEditorDialog })));

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
  const [markdownTarget, setMarkdownTarget] = useState<MarkdownEditorTarget | null>(null);
  const [markdownDirty, setMarkdownDirty] = useState(false);
  const [codeTarget, setCodeTarget] = useState<CodeEditorTarget | null>(null), [codeDirty, setCodeDirty] = useState(false);
  const [contentVersion, setContentVersion] = useState(0);
  const codeSaved = useCallback((): void => setContentVersion((v) => v + 1), []);
  const codeTargetRef = useRef(codeTarget); codeTargetRef.current = codeTarget;
  const codeDirtyRef = useRef(codeDirty); codeDirtyRef.current = codeDirty;
  const markdownTargetRef = useRef(markdownTarget); markdownTargetRef.current = markdownTarget;
  const markdownDirtyRef = useRef(markdownDirty); markdownDirtyRef.current = markdownDirty;
  const acceptProjects = (value: LocalProjectsState): void => setProjects((previous) => previous && previous.sequence > value.sequence ? previous : value);
  const openMarkdown = useCallback((target: MarkdownEditorTarget): void => {
    if (codeTargetRef.current && codeDirtyRef.current && !window.confirm('El archivo de código tiene cambios sin guardar. ¿Descartar su borrador?')) return;
    setCodeTarget(null); setCodeDirty(false);
    const current = markdownTargetRef.current;
    if (current?.sessionId === target.sessionId && current.entityId === target.entityId && current.resourceId === target.resourceId) return;
    if (current && markdownDirtyRef.current && !window.confirm('El documento actual tiene cambios sin guardar. ¿Descartar el borrador y abrir otra página?')) return;
    setMarkdownDirty(false); setMarkdownTarget(target);
  }, []);
  const closeMarkdown = useCallback((): void => { setMarkdownTarget(null); setMarkdownDirty(false); }, []);
  const updateMarkdownDirty = useCallback((dirty: boolean): void => setMarkdownDirty(dirty), []);
  const openCode = useCallback((target: CodeEditorTarget): void => {
    if (codeTargetRef.current?.sessionId === target.sessionId && JSON.stringify(codeTargetRef.current.target) === JSON.stringify(target.target)) return;
    if (codeDirtyRef.current && !window.confirm('El archivo de código tiene cambios sin guardar. ¿Descartar el borrador y abrir otro archivo?')) return;
    if (markdownDirtyRef.current && !window.confirm('La página tiene cambios sin guardar. ¿Descartar el borrador y abrir el archivo?')) return;
    setMarkdownTarget(null); setMarkdownDirty(false); setCodeTarget(target); setCodeDirty(false);
  }, []);
  const closeCode = useCallback((): void => { setCodeTarget(null); setCodeDirty(false); }, []);
  const updateCodeDirty = useCallback((dirty: boolean): void => setCodeDirty(dirty), []);
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
          const local = await window.a3.projects({ action: 'list' });
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
          aria-current={active === id ? 'page' : undefined} onClick={() => setActive(id)}>
          <span className="nav-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{label}
        </button>)}
      </nav>
      <div className="sidebar-note">Local por diseño<br /><span>Windows · preparación inicial</span></div>
    </aside>
    <main id="content" className="content" tabIndex={-1}>
      <div className="breadcrumb">A3 <span>/</span> {section[1]}</div>
      {active === 'projects' ? <ProjectsPanel state={projects} onChange={acceptProjects} /> : active === 'canvas' ? <Suspense fallback={<p role="status">Abriendo lienzo…</p>}><CanvasPanel active={projects?.active} onOpenMarkdown={openMarkdown} onOpenCode={openCode} contentVersion={contentVersion} /></Suspense> : active === 'files' ? <FileExplorerPanel active={projects?.active} onOpenCode={openCode} contentVersion={contentVersion} /> : <><section className="intro" aria-labelledby="section-title">
        <p className="eyebrow">Un lugar para tus ideas</p>
        <h1 id="section-title">{section[1]}</h1>
        <p className="lead">{section[2]}</p>
        <div className="placeholder"><span className="status-dot" />
          <div><strong>Área preparada</strong><p>La navegación está disponible. Las funciones de esta sección se incorporarán en las próximas etapas.</p></div>
        </div>
      </section></>}
      {active !== 'projects' && active !== 'canvas' && <section className="foundation" aria-labelledby="foundation-title">
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
    {markdownTarget && <Suspense fallback={<div className="markdown-backdrop"><p role="status">Preparando editor Markdown…</p></div>}>
      <MarkdownEditorDialog key={`${markdownTarget.sessionId}:${markdownTarget.entityId}:${markdownTarget.resourceId}`} target={markdownTarget}
        activeSessionId={projects?.active?.sessionId ?? null} onDirtyChange={updateMarkdownDirty} onClose={closeMarkdown} />
    </Suspense>}
    {codeTarget && <Suspense fallback={<div className="markdown-backdrop"><p role="status">Preparando editor de código…</p></div>}>
      <CodeEditorDialog key={`${codeTarget.sessionId}:${JSON.stringify(codeTarget.target)}`} target={codeTarget} activeSessionId={projects?.active?.sessionId ?? null} onDirtyChange={updateCodeDirty} onSaved={codeSaved} onClose={closeCode} />
    </Suspense>}
  </div>;
}
