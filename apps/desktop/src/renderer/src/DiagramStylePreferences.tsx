import { useEffect, useMemo, useState } from 'react';
import { adaptDiagramStyle, defaultDiagramStyleProfile, serializeDiagramTheme, type DiagramEngine, type DiagramStyleProfile } from '@a3/domain';
import type { DiagramStyleState, LocalProjectSession } from '../../shared/desktop-api';

const engines: { id: DiagramEngine; label: string }[] = [
  { id: 'a3-native', label: 'A3 nativo' }, { id: 'mermaid', label: 'Mermaid' },
  { id: 'plantuml', label: 'PlantUML' }, { id: 'structurizr', label: 'Structurizr' }
];
function themeOptions(engine: DiagramEngine): string[] {
  return engine === 'mermaid' ? ['default', 'base', 'dark', 'forest', 'neutral'] : ['default', 'dark', 'forest', 'neutral'];
}
function numberValue(value: string): number | undefined { return value === '' ? undefined : Number(value); }

export function DiagramStylePreferences({ active }: { active: LocalProjectSession | null }): React.JSX.Element {
  const workspaceId = active?.workspaces[0]?.id;
  const [state, setState] = useState<DiagramStyleState | null>(null);
  const [profile, setProfile] = useState<DiagramStyleProfile>(defaultDiagramStyleProfile());
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setState(null); setProfile(defaultDiagramStyleProfile()); setStatus(''); setError(null);
    if (!active || !workspaceId || !window.a3) return () => { current = false; };
    void window.a3.canvas({ action: 'diagram-style-load', sessionId: active.sessionId, workspaceId }).then((result) => {
      if (!current) return;
      if (!result.ok) throw new Error(`${result.error.message} ${result.error.recovery}`);
      setState(result.value); setProfile(result.value.profile);
      if (result.value.diagnostics.length) setError(`El perfil guardado no es compatible con la versión actual y se muestra el predeterminado. ${result.value.diagnostics.join(' ')}`);
    }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : 'No se pudo leer el estilo del proyecto.'); });
    return () => { current = false; };
  }, [active?.sessionId, workspaceId]);

  const adaptation = useMemo(() => adaptDiagramStyle(profile), [profile]);
  const themeJson = useMemo(() => {
    try { return serializeDiagramTheme(profile); } catch { return ''; }
  }, [profile]);
  const patch = (update: (old: DiagramStyleProfile) => DiagramStyleProfile): void => { setProfile((old) => update(old)); setStatus('Cambios pendientes de guardar.'); };
  async function save(): Promise<void> {
    if (!active || !workspaceId || !state || !window.a3 || busy || !state.canWrite) return;
    setBusy(true); setError(null); setStatus('Guardando perfil…');
    try {
      const response = await window.a3.canvas({ action: 'diagram-style-save', sessionId: active.sessionId, workspaceId,
        expectedProjectRevision: state.projectRevision, profile });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      setState(response.value); setProfile(response.value.profile); setStatus('Perfil guardado en el manifiesto del proyecto.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar el perfil.'); setStatus(''); }
    finally { setBusy(false); }
  }

  if (!active) return <section className="diagram-style-preferences"><h2>Estilo de diagramas</h2><p>Abre un proyecto para configurar y guardar su tema declarativo.</p></section>;
  return <section className="diagram-style-preferences" aria-labelledby="diagram-style-title">
    <h2 id="diagram-style-title">Estilo de diagramas del proyecto</h2>
    <p>El perfil se guarda en el manifiesto. La vista resuelve estilos por tipo → tema del proyecto → entidad → vista. Cada motor aplica su propio subconjunto.</p>
    {!workspaceId && <p role="alert">El proyecto no tiene un workspace disponible para editar este perfil.</p>}
    {!state && !error && <p role="status">Leyendo el perfil guardado…</p>}
    <fieldset disabled={!workspaceId || !state || busy}>
      <legend>Motor y tema</legend>
      <label>Motor de destino <select value={profile.engine} onChange={(event) => {
        const engine = event.target.value as DiagramEngine; patch((old) => ({ ...old, engine, theme: themeOptions(engine)[0]! }));
      }}>{engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}</select></label>
      <label>Tema <select value={themeOptions(profile.engine).includes(profile.theme) ? profile.theme : 'default'} onChange={(event) => patch((old) => ({ ...old, theme: event.target.value }))}>
        {themeOptions(profile.engine).map((theme) => <option key={theme} value={theme}>{theme}</option>)}
      </select></label>
    </fieldset>
    <fieldset disabled={!workspaceId || !state || busy}>
      <legend>Tipografía</legend>
      <label>Familia <input value={profile.fonts?.family ?? ''} maxLength={120} placeholder="Segoe UI" onChange={(event) => patch((old) => ({ ...old, fonts: { ...old.fonts, ...(event.target.value ? { family: event.target.value } : { family: undefined }) } }))} /></label>
      <label>Tamaño (px) <input type="number" min="6" max="72" value={profile.fonts?.size ?? ''} onChange={(event) => patch((old) => ({ ...old, fonts: { ...old.fonts, size: numberValue(event.target.value) } }))} /></label>
    </fieldset>
    <fieldset disabled={!workspaceId || !state || busy}>
      <legend>Colores y bordes</legend>
      {(['background', 'primary', 'secondary', 'text', 'line'] as const).map((key) => <label key={key}>{key} <input type="color" value={profile.colors?.[key] ?? ({ background: '#ffffff', primary: '#e8eef3', secondary: '#f7f9fb', text: '#18212a', line: '#607387' }[key])}
        onChange={(event) => patch((old) => ({ ...old, colors: { ...old.colors, [key]: event.target.value } }))} /></label>)}
      <label>Color de borde <input type="color" value={profile.borders?.color ?? '#718096'} onChange={(event) => patch((old) => ({ ...old, borders: { ...old.borders, color: event.target.value } }))} /></label>
      <label>Ancho de borde <input type="number" min="0" max="12" value={profile.borders?.width ?? ''} onChange={(event) => patch((old) => ({ ...old, borders: { ...old.borders, width: numberValue(event.target.value) } }))} /></label>
      <label>Radio de borde <input type="number" min="0" max="48" value={profile.borders?.radius ?? ''} onChange={(event) => patch((old) => ({ ...old, borders: { ...old.borders, radius: numberValue(event.target.value) } }))} /></label>
    </fieldset>
    <fieldset disabled={!workspaceId || !state || busy}>
      <legend>Geometría y fondo</legend>
      <label>Orientación <select value={profile.orientation ?? ''} onChange={(event) => patch((old) => ({ ...old, orientation: event.target.value ? event.target.value as DiagramStyleProfile['orientation'] : undefined }))}>
        <option value="">Sin indicar</option><option value="top-down">Arriba a abajo</option><option value="left-right">Izquierda a derecha</option><option value="bottom-up">Abajo a arriba</option><option value="right-left">Derecha a izquierda</option>
      </select></label>
      <label>Separación de nodos <input type="number" min="0" max="1000" value={profile.spacing?.nodes ?? ''} onChange={(event) => patch((old) => ({ ...old, spacing: { ...old.spacing, nodes: numberValue(event.target.value) } }))} /></label>
      <label>Separación de niveles <input type="number" min="0" max="1000" value={profile.spacing?.ranks ?? ''} onChange={(event) => patch((old) => ({ ...old, spacing: { ...old.spacing, ranks: numberValue(event.target.value) } }))} /></label>
      <label>Fondo <input type="color" value={profile.background?.color ?? '#ffffff'} onChange={(event) => patch((old) => ({ ...old, background: { ...old.background, color: event.target.value } }))} /></label>
      <label>Recurso de fondo (ID A3) <input value={profile.background?.resourceId ?? ''} maxLength={36} placeholder="UUID del recurso" onChange={(event) => patch((old) => ({ ...old, background: { ...old.background, resourceId: event.target.value || undefined } }))} /></label>
      <label>Escala <input type="number" min="0.1" max="4" step="0.1" value={profile.scale ?? ''} onChange={(event) => patch((old) => ({ ...old, scale: numberValue(event.target.value) }))} /></label>
    </fieldset>
    {state?.diagnostics.map((diagnostic) => <p role="alert" key={diagnostic}>{diagnostic}</p>)}
    <section className="diagram-style-compatibility" aria-label="Compatibilidad del motor">
      <h3>Compatibilidad · {profile.engine}</h3>
      {adaptation.unsupported.length ? <p role="status">No se aplican: {adaptation.unsupported.join(', ')}.</p> : <p role="status">Todos los campos configurados tienen una representación para este motor.</p>}
      <p>La salida visual depende de la versión, el tipo de diagrama y las fuentes instaladas; no se garantiza igualdad entre motores.</p>
    </section>
    <button type="button" className="primary" onClick={() => void save()} disabled={!state?.canWrite || busy || !workspaceId}>{busy ? 'Guardando…' : 'Guardar perfil'}</button>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <details className="diagram-theme-export"><summary>Exportar tema declarativo (JSON)</summary>
      <p>Contenido portable listo para copiar a un archivo de tema. Los campos no compatibles se mantienen declarados y aparecen en el informe.</p>
      <textarea aria-label="JSON del tema declarativo" readOnly value={themeJson} rows={16} onFocus={(event) => event.currentTarget.select()} />
    </details>
  </section>;
}
