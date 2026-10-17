export type AgentProviderConnection = 'not-configured' | 'connected' | 'lost';
export type AgentTurnViewStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | null;

export interface VerifiedModelCatalog {
  verified: true;
  models: readonly { id: string; label: string; available: boolean }[];
}

export interface CodexAgentEvidence {
  providerConnection: AgentProviderConnection;
  modelCatalog?: VerifiedModelCatalog;
  turnStatus: AgentTurnViewStatus;
  turnControlsAvailable: boolean;
  diagnostic?: string | null;
}

export interface CodexAgentView {
  providerLabel: string;
  turnLabel: string;
  streamingLabel: string;
  modelLabels: readonly string[];
  modelNotice: string;
  errorNotice: string | null;
  canStart: boolean;
  canStop: boolean;
  canResume: boolean;
  resultLabel: string;
}

const diagnosticMessages: Record<string, string> = {
  USAGE_LIMIT_EXHAUSTED: 'Se agotó el límite reportado por el proveedor. No se adivina cuándo se restablece y no se cambia a facturación de API.',
  PROVIDER_RATE_LIMITED: 'El proveedor aplicó un límite temporal. No se cambia a facturación de API.',
  PROVIDER_ACCESS_DENIED: 'El proveedor denegó acceso al modelo o la ruta solicitada. No se ofrece un modelo alternativo sin verificar.',
  PROVIDER_PERMISSION_REJECTED: 'El proveedor rechazó los permisos de esta consulta. Revisa la autorización de la cuenta.',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'El proveedor no está disponible temporalmente. No se cambia de proveedor ni de facturación.',
  TOKEN_EXPIRED: 'La autorización venció. Renueva la sesión oficial antes de iniciar una consulta.',
  STREAM_DISCONNECTED: 'Se perdió el flujo del proveedor. El estado del turno puede ser incierto; conserva el resultado local y reconecta antes de continuar.',
  RECONNECT_UNCERTAIN: 'No se pudo recuperar el flujo. El turno queda incierto y no se vuelve a enviar automáticamente.',
  REQUEST_TIMEOUT: 'No llegó una respuesta del proveedor. El resultado queda incierto; no se repite automáticamente.'
};

/** Projects only verified provider evidence into display state. This view never grants authority. */
export function createCodexAgentView(evidence: CodexAgentEvidence): CodexAgentView {
  const modelLabels = evidence.modelCatalog?.verified
    ? [...new Set(evidence.modelCatalog.models.filter((model) => model && model.available === true && typeof model.id === 'string' && /^[\w.-]{1,96}$/.test(model.id) && typeof model.label === 'string' && model.label.trim()).map((model) => model.label.trim()))]
    : [];
  const active = evidence.turnStatus === 'running' || evidence.turnStatus === 'cancelling';
  const uncertain = evidence.turnStatus === 'uncertain' || evidence.turnStatus === 'interrupted';
  const providerLabel = evidence.providerConnection === 'connected' ? 'Conectado' : evidence.providerConnection === 'lost' ? 'Conexión perdida' : 'No configurado';
  const turnLabel = active ? (evidence.turnStatus === 'cancelling' ? 'Deteniendo' : 'En curso') : uncertain ? 'Incierto · requiere revisar/reconectar' : evidence.turnStatus === 'completed' ? 'Completado' : evidence.turnStatus === 'failed' ? 'Falló' : 'No iniciado';
  const streamingLabel = evidence.providerConnection === 'lost' && active ? 'Flujo perdido · resultado incierto' : active && evidence.providerConnection === 'connected' ? 'Recibiendo eventos' : 'Inactivo';
  const accessible = evidence.diagnostic === 'PROVIDER_ACCESS_DENIED' || evidence.diagnostic === 'MODEL_NOT_ACCESSIBLE';
  const modelNotice = accessible
    ? 'El modelo/ruta no fue aceptado por el proveedor; no se muestra como disponible.'
    : modelLabels.length
      ? 'Modelos marcados disponibles por el catálogo verificado del proveedor.'
      : 'No hay catálogo de modelos verificado para esta instalación; no se ofrece ningún modelo.';
  const errorNotice = evidence.diagnostic ? diagnosticMessages[evidence.diagnostic] ?? 'El proveedor informó un estado que requiere atención. No se repite ni se cambia de proveedor automáticamente.' : null;
  const providerReady = evidence.providerConnection === 'connected';
  const canStop = evidence.turnControlsAvailable && providerReady && evidence.turnStatus === 'running';
  const canResume = evidence.turnControlsAvailable && providerReady && uncertain;
  return {
    providerLabel, turnLabel, streamingLabel, modelLabels, modelNotice, errorNotice,
    canStart: false, // No thread/start + turn/start IPC is wired in E5-F2.
    canStop, canResume,
    resultLabel: evidence.turnStatus ? 'El ledger local puede contener un resultado de turno.' : 'No hay propuestas ni resultados de turno en esta sesión.'
  };
}

