import { useCallback, useEffect, useState } from 'react';
import type { ProjectCapabilityState } from '@a3/project-store';
import type { LocalProjectSession } from '../../shared/desktop-api';
import { AGENT_CAPABILITY_GROUPS, type AgentProfilesRequest } from '../../shared/agent-profiles';

const profiles = [
  ['consultar', 'Consultar'], ['proponer', 'Proponer'], ['trabajar', 'Trabajar'], ['personalizado', 'Personalizado']
] as const;
const modes = [['deny', 'Denegado'], ['propose', 'Solo propuesta'], ['approval', 'Requiere aprobación'], ['direct', 'Directo']] as const;
const labels: Record<string, string> = {
  'project.read': 'Leer proyecto', 'mount.read': 'Leer carpetas montadas', 'mount.index': 'Indexar montajes', 'mount.write': 'Escribir en montajes',
  'document.edit': 'Editar documentos', 'diagram.edit': 'Editar diagramas', 'task.edit': 'Editar tareas', delete: 'Eliminar', 'project.recover': 'Recuperar proyecto',
  'process.run': 'Ejecutar procesos / shell', 'network.access': 'Acceder a red', 'apps.connect': 'Conectar aplicaciones', 'package.install': 'Instalar paquetes',
  'media.convert': 'Convertir medios', 'git.status': 'Consultar estado Git', 'git.diff': 'Leer diff Git', 'git.stage': 'Preparar cambios Git',
  'git.commit': 'Crear commits Git', 'git.push': 'Publicar Git', 'git.branch': 'Cambiar ramas Git', 'git.restore': 'Restaurar Git', export: 'Exportar datos'
};
const profileLabels: Record<string, string> = Object.fromEntries(profiles.map(([id, label]) => [id, label]));

export function AgentProfilesPreferences({ active }: { active: LocalProjectSession | null }): React.JSX.Element {
  const [state, setState] = useState<ProjectCapabilityState | null>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const sessionId = active?.sessionId;
  const request = useCallback(async (input: AgentProfilesRequest): Promise<void> => {
    if (!window.a3) throw new Error('El puente local de A3 no está disponible.');
    const result = await window.a3.agentProfiles(input);
    if (!result.ok) throw new Error(`${result.error.message} ${result.error.recovery}`);
    setState(result.value.state);
    if ('updated' in result.value) setStatus(result.value.updated ? 'Concesión local actualizada.' : 'No se cambió la concesión. La solicitud del proyecto sigue sin autoridad.');
  }, []);
  useEffect(() => {
    setState(null); setStatus(''); setError('');
    if (sessionId) void request({ action: 'load', sessionId }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se pudo leer la política.'));
  }, [sessionId, request]);
  const update = async (input: AgentProfilesRequest): Promise<void> => {
    setBusy(true); setError(''); setStatus('');
    try { await request(input); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se actualizó la concesión.'); }
    finally { setBusy(false); }
  };
  const byCapability = new Map(state?.capabilities.map((item) => [item.capability, item]) ?? []);

  return <section className="agent-profile-preferences" aria-labelledby="agent-profile-title">
    <p className="eyebrow">E5 · Permisos locales</p><h2 id="agent-profile-title">Perfil del agente</h2>
    {!active ? <p>Abre un proyecto para revisar sus permisos efectivos.</p> : <>
      <p>Proyecto: <strong>{active.name}</strong>. Este perfil y sus concesiones se guardan en este dispositivo, fuera del proyecto.</p>
      {state && <>
        <label>Perfil efectivo
          <select aria-label="Perfil efectivo del agente" value={state.effectiveProfile} disabled={busy}
            onChange={(event) => void update({ action: 'set-profile', sessionId: active.sessionId, profile: event.target.value as ProjectCapabilityState['effectiveProfile'] })}>
            {profiles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <p role="status">La solicitud portable del proyecto: {state.sharedRequestState === 'invalid' ? 'no es válida y no concede permisos' : state.requestedProfile ? profileLabels[state.requestedProfile] : 'sin perfil explícito'}.</p>
        {state.requestedProfile && state.requestedProfile !== state.effectiveProfile && <p className="permission-note">El proyecto solicita {profileLabels[state.requestedProfile]}; la concesión efectiva sigue siendo {profileLabels[state.effectiveProfile]}. Editar policies.json no cambia permisos.</p>}
        {state.sharedRequestState === 'invalid' && <p role="alert">No se pudo interpretar la solicitud compartida. La concesión local no cambió.</p>}
        <p className="permission-note">Las capacidades marcadas como no disponibles permanecen bloqueadas incluso si un proyecto las solicita. Shell, red, Git y conexiones de aplicaciones requieren límites propios y no se activan por perfil.</p>
        {AGENT_CAPABILITY_GROUPS.map((group) => <fieldset key={group.id}>
          <legend>{group.label}</legend>
          {group.capabilities.map((capability) => {
            const item = byCapability.get(capability);
            return <div className="agent-capability" key={capability}>
              <label>{labels[capability] ?? capability}
                <select aria-label={`Permiso efectivo: ${labels[capability] ?? capability}`} value={item?.effectiveMode ?? 'deny'} disabled={busy || !item?.available}
                  onChange={(event) => void update({ action: 'set-capability', sessionId: active.sessionId, capability, mode: event.target.value as 'deny' | 'propose' | 'approval' | 'direct' })}>
                  {modes.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
                </select>
              </label>
              <small role={item?.available && item.reason === 'granted' ? undefined : 'status'}>
                {!item?.available ? 'Bloqueado: capacidad no disponible en esta build' : item.effectiveMode === 'propose' ? 'Solo se permiten propuestas; aplicar queda denegado' : item.reason === 'profile-denied' ? 'Denegado por el perfil efectivo' : item.reason === 'approval-required' ? 'El host pide aprobación antes de aplicar' : item.reason === 'grant-unavailable' ? 'No hay concesión local' : 'Concedido localmente'}
                {item?.requestedMode ? ` · solicitud del proyecto: ${modes.find(([mode]) => mode === item.requestedMode)?.[1] ?? item.requestedMode}` : ''}
              </small>
            </div>;
          })}
        </fieldset>)}
      </>}
      {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    </>}
  </section>;
}
