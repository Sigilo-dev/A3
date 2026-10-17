import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectCapabilityState } from '@a3/project-store';
import type { LocalProjectSession } from '../../shared/desktop-api';
import type { CodexAuthState } from '../../shared/codex-auth';
import { createCodexAgentView } from '../../shared/codex-agent-view';
import { CodexAccountPanel } from './CodexAccountPanel';

const capabilityLabels: Record<string, string> = {
  'project.read': 'Leer el proyecto', 'mount.read': 'Leer montajes', 'mount.index': 'Indexar montajes', 'mount.write': 'Escribir en montajes',
  'document.edit': 'Editar documentos', 'diagram.edit': 'Editar diagramas', 'task.edit': 'Editar tareas', delete: 'Eliminar',
  'project.recover': 'Recuperar proyecto', 'process.run': 'Ejecutar procesos', 'network.access': 'Acceder a red',
  'package.install': 'Instalar paquetes', 'apps.connect': 'Conectar aplicaciones', 'media.convert': 'Convertir medios',
  'git.status': 'Consultar Git', 'git.diff': 'Leer diff de Git', 'git.stage': 'Preparar cambios Git', 'git.commit': 'Crear commits',
  'git.push': 'Publicar cambios', 'git.branch': 'Cambiar ramas', 'git.restore': 'Restaurar Git', export: 'Exportar'
};
const modes: Record<string, string> = { deny: 'denegado', propose: 'propuesta', approval: 'requiere aprobación', direct: 'concesión directa' };
const profileNames: Record<string, string> = { consultar: 'Consultar', proponer: 'Proponer', trabajar: 'Trabajar', personalizado: 'Personalizado' };
const authNames: Record<string, string> = {
  disconnected: 'Desconectado', authorizing: 'Autorización en curso', 'identity-only': 'Identidad · falta permiso del plan',
  connected: 'Permiso del plan · consulta no comprobada', expired: 'Autorización vencida', 'not-eligible': 'Cuenta no elegible',
  'limit-exhausted': 'Límite agotado', unavailable: 'Proveedor no disponible'
};
const authorizationLabel = (state: CodexAuthState | null): string => !state ? 'Consultando cuenta…'
  : state.status === 'connected' && state.inferenceVerified ? 'Consulta comprobada anteriormente'
    : authNames[state.status] ?? 'Estado no reconocido';

export function CodexAgentPanel({ active, onManual, onPrompts, onPreferences }: {
  active: LocalProjectSession | null;
  onManual(): void;
  onPrompts(): void;
  onPreferences(): void;
}): React.JSX.Element {
  const [auth, setAuth] = useState<CodexAuthState | null>(null);
  const [capabilities, setCapabilities] = useState<ProjectCapabilityState | null>(null);
  const [error, setError] = useState('');
  const [authorizationOpen, setAuthorizationOpen] = useState(true);
  const profileRequest = useRef(0);
  const view = createCodexAgentView({ providerConnection: 'not-configured', turnStatus: null, turnControlsAvailable: false, diagnostic: auth?.diagnostic });
  const acceptAuthState = useCallback((next: CodexAuthState): void => setAuth((current) => current && JSON.stringify(current) === JSON.stringify(next) ? current : next), []);
  const sessionId = active?.sessionId;
  const loadCapabilities = useCallback(async (): Promise<void> => {
    const sequence = ++profileRequest.current;
    if (!sessionId) { setCapabilities(null); setError(''); return; }
    try {
      const result = await window.a3?.agentProfiles({ action: 'load', sessionId });
      if (!result) throw new Error('El puente local no está disponible.');
      if (!result.ok) throw new Error(result.error.message);
      if (sequence === profileRequest.current) { setCapabilities(result.value.state); setError(''); }
    } catch (cause) { if (sequence === profileRequest.current) { setCapabilities(null); setError(cause instanceof Error ? cause.message : 'No se pudieron leer los permisos efectivos.'); } }
  }, [sessionId]);
  useEffect(() => { setCapabilities(null); void loadCapabilities(); return () => { profileRequest.current++; }; }, [loadCapabilities]);

  return <section className="codex-agent-panel" aria-labelledby="codex-agent-title">
    <header>
      <p className="eyebrow">E5 · Asistencia local</p>
      <h1 id="codex-agent-title">Agente</h1>
      <p className="lead">Codex usa solo la autorización oficial de tu cuenta. El modelo no amplía los permisos efectivos del proyecto ni activa herramientas por sí mismo.</p>
    </header>

    <section className="agent-runtime" aria-labelledby="agent-runtime-title">
      <div className="agent-runtime-heading"><div><p className="eyebrow">Estado comprobado</p><h2 id="agent-runtime-title">Control de turnos</h2></div><span className="agent-state" data-state="unavailable">{view.providerLabel}</span></div>
      <dl className="agent-runtime-grid">
        <div><dt>Proveedor automatizado</dt><dd>Codex app-server · no configurado en esta instalación</dd></div>
        <div><dt>Autorización</dt><dd>{authorizationLabel(auth)}</dd></div>
        <div><dt>Uso del plan</dt><dd>{auth?.inferenceVerified ? 'Consulta comprobada anteriormente' : auth?.planPermission ? 'Permiso presente · inferencia aún no comprobada' : 'Sin permiso de uso comprobado'}</dd></div>
        <div><dt>Modelos disponibles</dt><dd>{view.modelLabels.length ? view.modelLabels.join(', ') : 'Ninguno verificado'}</dd></div>
        <div><dt>Turno</dt><dd>{view.turnLabel}</dd></div>
        <div><dt>Streaming</dt><dd>{view.streamingLabel}</dd></div>
      </dl>
      <p className="agent-runtime-note">{view.modelNotice} El adaptador actual no publica catálogo de modelos ni conecta inicio de turno a esta vista.</p>
      <div className="agent-turn-actions" aria-label="Controles del turno">
        <button type="button" disabled aria-describedby="agent-turn-unavailable">Iniciar turno</button>
        <button type="button" disabled={!view.canStop}>Detener turno</button>
        <button type="button" disabled={!view.canResume}>Reanudar turno</button>
      </div>
      <p id="agent-turn-unavailable" className="agent-runtime-note">{view.errorNotice ?? 'Los controles de detener y reanudar se activarán cuando exista una conexión y un turno verificables. No se reenvían consultas automáticamente.'}</p>
      <div className="agent-results" aria-live="polite">
        <h3>Propuestas y resultados</h3>
        <p>{view.resultLabel} Las propuestas de Codex todavía no llegan a la interfaz ni se aplican al proyecto.</p>
      </div>
    </section>

    <section className="agent-runtime" aria-labelledby="agent-permissions-title">
      <div className="agent-runtime-heading"><div><p className="eyebrow">Aprobación local por proyecto</p><h2 id="agent-permissions-title">Capacidades efectivas</h2></div>
        {capabilities && <span className="agent-state" data-state="local">{profileNames[capabilities.effectiveProfile] ?? capabilities.effectiveProfile}</span>}</div>
      {!active ? <p>Abre un proyecto para leer su perfil efectivo local.</p> : error ? <p role="alert">{error}</p> : !capabilities ? <p role="status">Consultando permisos del proyecto…</p> : <>
        <p>Proyecto: <strong>{active.name}</strong>. Solo se muestran capacidades que el host marca disponibles. Su modo efectivo no concede acceso al modelo ni inicia herramientas.</p>
        <ul className="agent-effective-capabilities">
          {capabilities.capabilities.filter((item) => item.available).map((item) => <li key={item.capability}>
            <span>{capabilityLabels[item.capability] ?? item.capability}</span><span data-mode={item.effectiveMode}>{modes[item.effectiveMode] ?? item.effectiveMode}</span>
          </li>)}
        </ul>
        {!capabilities.capabilities.some((item) => item.available) && <p>No hay capacidades de agente disponibles en este proyecto.</p>}
        <p className="agent-runtime-note">Las capacidades no disponibles en esta build se omiten; las disponibles pueden estar denegadas por el perfil. El perfil portable del proyecto es solo una solicitud.</p>
      </>}
      {error && active && <button type="button" className="secondary" onClick={() => void loadCapabilities()}>Reintentar permisos</button>}
      <div className="agent-turn-actions"><button type="button" className="secondary" onClick={onPreferences}>Revisar preferencias de permisos</button></div>
    </section>

    <section className="agent-provider-choice" aria-label="Formas explícitas de continuar">
      <div><h2>Elige cómo continuar</h2><p>Sin turno Codex, puedes preparar un prompt copiable o abrir ChatGPT manualmente. No se usa una API de pago ni otro proveedor en segundo plano.</p></div>
      <div className="agent-turn-actions"><button type="button" onClick={onPrompts}>Preparar prompt copiable</button><button type="button" className="secondary" onClick={onManual}>Abrir ChatGPT manual</button></div>
    </section>

    <details className="agent-authorization" open={authorizationOpen} onToggle={(event) => setAuthorizationOpen(event.currentTarget.open)}><summary>Autorización de Codex y límites de cuenta</summary>
      <CodexAccountPanel onManual={onManual} onStateChange={acceptAuthState} />
    </details>
  </section>;
}
