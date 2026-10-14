import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/desktop-api';

const sections = [
  ['projects', 'Proyectos', 'Inicio y selección de proyectos locales.'],
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
  const section = sections.find(([id]) => id === active)!;

  useEffect(() => {
    let mounted = true;
    setError(null);
    const connect = async (): Promise<void> => {
      try {
        if (!window.a3) throw new Error('El puente de escritorio no está disponible. Reabre A3.');
        const result = await window.a3.getAppInfo();
        if (!mounted) return;
        if (result.ok) setInfo(result.value);
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
      <span className="project-name">Sin proyecto abierto</span>
      <span className="stage">Base escritorio · E1-A</span>
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
      <section className="intro" aria-labelledby="section-title">
        <p className="eyebrow">Un lugar para tus ideas</p>
        <h1 id="section-title">{active === 'projects' ? 'De la idea al proyecto.' : section[1]}</h1>
        <p className="lead">{active === 'projects'
          ? 'Documentos, referencias y diagramas compartirán un mismo espacio local.' : section[2]}</p>
        <div className="placeholder"><span className="status-dot" />
          <div><strong>Área preparada</strong><p>La navegación está disponible. Las funciones de esta sección se incorporarán en las próximas etapas.</p></div>
        </div>
      </section>
      <section className="foundation" aria-labelledby="foundation-title">
        <div><p className="eyebrow">Primer paso</p><h2 id="foundation-title">Una base común</h2></div>
        <p>Explora las secciones desde la barra izquierda. Esta entrega prepara la ventana y la comunicación de escritorio.</p>
        <button className="secondary" onClick={() => setActive('preferences')}>Ver Preferencias <span aria-hidden="true">↗</span></button>
      </section>
      {error && <div className="error" role="alert"><p>{error}</p>
        <button onClick={() => setAttempt((value) => value + 1)}>Reintentar conexión</button></div>}
    </main>
    <aside className="inspector" aria-label="Estado de escritorio">
      <p className="eyebrow">Escritorio</p><h2>Estado de la base</h2>
      <p role="status" className="connection">{error ? 'Conexión con error' : info ? 'Proceso principal conectado' : 'Conectando…'}</p>
      {info && <dl>
        <dt>Aplicación</dt><dd>{info.name} {info.version}</dd>
        <dt>Plataforma</dt><dd>{info.platform}</dd>
        <dt>Electron</dt><dd>{info.electron}</dd>
        <dt>Chromium</dt><dd>{info.chromium}</dd>
        <dt>Node del host</dt><dd>{info.node}</dd>
      </dl>}
      <p className="inspector-note">Los archivos y servicios del proyecto se conectarán en las siguientes entregas.</p>
    </aside>
    <footer className="statusbar">
      <span><span className="status-dot" />{info && !error ? 'Escritorio listo' : 'Verificando escritorio'}</span>
      <button aria-expanded={activityOpen} aria-controls="activity" onClick={() => setActivityOpen(!activityOpen)}>
        {activityOpen ? 'Cerrar actividad' : 'Ver actividad'}</button>
    </footer>
    {activityOpen && <section id="activity" className="activity" aria-label="Actividad de inicio">
      <h2>Actividad de inicio</h2><p>{error ?? (info ? 'Ventana y puente de escritorio iniciados.' : 'Esperando conexión del proceso principal.')}</p>
    </section>}
  </div>;
}
