import { useEffect, useState } from 'react';
import type { CodexAuthRequest, CodexAuthState } from '../../shared/codex-auth';

const messages: Record<string, string> = {
  NOT_CONFIGURED: 'Conecta tu cuenta elegible y revisa el consentimiento en el navegador del sistema.',
  WAITING_FOR_BROWSER: 'Esperando autorización en el navegador del sistema. Puedes cancelar aquí.',
  PLAN_GRANTED_NOT_TESTED: 'Identidad validada y permiso del plan concedido. La inferencia y el acceso a modelos aún no se han comprobado.',
  INFERENCE_CONFIRMED: 'Codex completó una consulta con esta cuenta. Esto confirma acceso para esa consulta.',
  PLAN_PERMISSION_MISSING: 'Identidad validada, sin permiso para usar el plan. Autorízalo explícitamente o usa el chat manual.',
  CANCELLED: 'Autorización cancelada. No se inicia ninguna consulta.',
  CONSENT_DECLINED: 'Consentimiento rechazado. Puedes continuar manualmente.',
  INVALID_STATE: 'La respuesta no corresponde a esta autorización. Inicia de nuevo desde A3.',
  INVALID_CALLBACK: 'Callback o registro no válido. Inicia de nuevo desde A3.',
  INVALID_IDENTITY: 'No se pudo verificar la identidad recibida. No se guardaron esas credenciales.',
  ACCOUNT_MISMATCH: 'La identidad recibida no corresponde a la cuenta seleccionada.',
  SECURE_STORAGE_UNAVAILABLE: 'No hay almacenamiento del sistema validado. La conexión está deshabilitada; usa el chat manual.',
  SECURE_STORAGE_UNREADABLE: 'No se pueden leer las credenciales protegidas. Se conserva el archivo original.',
  SECURE_STORAGE_WRITE_FAILED: 'No se pudo guardar la conexión en almacenamiento protegido.',
  REAUTHORIZATION_REQUIRED: 'La sesión requiere una nueva autorización con ChatGPT.',
  AUTH_TEMPORARILY_UNAVAILABLE: 'La autorización no está disponible temporalmente. Reintenta después o usa el chat manual.',
  PLAN_ACCESS_DENIED: 'OpenAI no concedió acceso a esta cuenta, workspace o región. Usa el chat manual.',
  PLAN_NOT_ELIGIBLE: 'Esta cuenta, workspace o política no es elegible. No repitas el login; agrega otra cuenta o usa el chat manual.',
  USAGE_LIMIT: 'Se alcanzó un límite del proveedor. Espera o usa el chat manual.',
  USAGE_LIMIT_EXHAUSTED: 'OpenAI rechazó la consulta por límite de uso. No se conoce la hora de restablecimiento; se conservaron las credenciales.',
  PROVIDER_RATE_LIMITED: 'OpenAI rechazó la consulta por un límite temporal. Se conservaron las credenciales.',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'OpenAI no está disponible temporalmente. Se conservaron las credenciales; inténtalo más tarde.',
  PROVIDER_PERMISSION_REJECTED: 'OpenAI rechazó el contexto de autorización. Revisa la cuenta y los permisos concedidos.',
  PROVIDER_ACCESS_DENIED: 'OpenAI rechazó el acceso al modelo o la ruta para esta consulta. No se cambió el método de pago ni se ofreció un modelo alternativo.',
  AUTH_REFRESHED_RETRY_REQUEST: 'El token fue renovado por el flujo oficial. Reintenta la consulta original una vez.',
  TOKEN_EXPIRED: 'El token venció. Renueva la sesión OAuth antes de volver a consultar.',
  BROWSER_UNAVAILABLE: 'No se pudo abrir el navegador del sistema.',
  AUTH_TIMEOUT: 'La autorización venció. Inicia un nuevo intento.',
  DISCONNECTED: 'Sesión OAuth desconectada. Las cookies del chat manual permanecen independientes.',
  REMOTE_REVOCATION_UNCONFIRMED: 'Credenciales locales eliminadas. No se confirmó la revocación remota; desconecta A3 también en Ajustes de ChatGPT.',
  ACCOUNT_SELECTED: 'Cuenta seleccionada. Sus permisos de proyecto siguen siendo independientes.'
};
export function CodexAccountPanel({ onManual, onStateChange }: { onManual(): void; onStateChange?: (state: CodexAuthState) => void }): React.JSX.Element {
  const [state, setState] = useState<CodexAuthState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function act(request: CodexAuthRequest): Promise<void> {
    setBusy(true); setError('');
    try {
      const result = await window.a3?.codexAuthorization(request);
      if (!result) throw new Error('Puente no disponible.');
      if (result.ok) { setState(result.value); onStateChange?.(result.value); } else setError(result.error.message);
    } catch { setError('No se pudo consultar la autorización. Puedes continuar manualmente.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let live = true, polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return; polling = true;
      try { const result = await window.a3?.codexAuthorization({ action: 'state' }); if (live && result?.ok) { setState(result.value); onStateChange?.(result.value); } }
      catch { if (live) setError('No se pudo consultar la conexión.'); } finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 750);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const pending = state?.status === 'authorizing', active = state?.accounts.find((item) => item.id === state.activeAccountId);
  return <section className="intro" aria-labelledby="codex-account-title" data-codex-account>
    <h1 id="codex-account-title">Conectar cuenta de ChatGPT</h1>
    <p>Autoriza el uso de tu plan en el navegador del sistema. La elegibilidad depende de OpenAI, tu cuenta, región y workspace. A3 no utiliza una API key del desarrollador ni cambia a facturación de API.</p>
    <label>Cuenta ChatGPT<select aria-label="Cuenta ChatGPT" value={state?.activeAccountId ?? ''} disabled={busy || pending} onChange={(event) => void act({ action: 'select', accountId: event.target.value })}>
      {!state?.activeAccountId && <option value="">Sin cuenta seleccionada</option>}
      {state?.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.signedIn ? ' · conectada' : ' · desconectada'}</option>)}
    </select></label>
    <div className="panel-actions">
      <button type="button" data-codex-connect disabled={busy || pending || state?.status === 'unavailable' || state?.status === 'not-eligible' || state?.status === 'limit-exhausted'} onClick={() => void act({ action: 'connect', ...(active ? { accountId: active.id } : {}) })}>Continue with ChatGPT</button>
      {active && <button type="button" data-codex-add disabled={busy || pending || state?.status === 'unavailable'} onClick={() => void act({ action: 'connect' })}>Agregar otra cuenta o workspace</button>}
      {state?.status === 'identity-only' && active && <button type="button" data-codex-enable disabled={busy || pending} onClick={() => void act({ action: 'connect', accountId: active.id, enablePlan: true })}>Autorizar uso del plan</button>}
      {(state?.status === 'expired' || active?.signedIn) && <button type="button" data-codex-refresh disabled={busy || pending} onClick={() => void act({ action: 'refresh' })}>Renovar sesión</button>}
      {state?.status === 'limit-exhausted' && <button type="button" data-codex-usage onClick={() => void act({ action: 'open-usage' })}>Ver uso de ChatGPT</button>}
      <button type="button" data-codex-cancel disabled={!pending && !busy} onClick={() => void act({ action: 'cancel' })}>Cancelar autorización</button>
      <button type="button" data-codex-disconnect disabled={busy || pending || !active} onClick={() => void act({ action: 'disconnect' })}>Desconectar OAuth</button>
      <button type="button" data-codex-manual onClick={onManual}>Abrir chat manual</button>
    </div>
    <p role="status" data-codex-status={state?.status ?? 'loading'}>{state ? messages[state.diagnostic] ?? 'Autorización no disponible (' + state.diagnostic + '). Usa el chat manual o reintenta.' : 'Consultando conexión…'}</p>
    {state?.status === 'expired' && <p>El token venció o requiere autorización de nuevo. Renueva o vuelve a conectar antes de cualquier consulta.</p>}
    {error && <p role="alert">{error}</p>}
    <p>Esta conexión no accede a tus conversaciones o memoria de ChatGPT, no concede permisos de proyecto y no inicia turnos de agente. Copiar y pegar en el chat manual sigue siendo una acción tuya.</p>
  </section>;
}
