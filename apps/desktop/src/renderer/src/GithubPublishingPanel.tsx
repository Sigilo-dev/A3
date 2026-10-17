import { useState } from 'react';
import type { LocalProjectSession } from '../../shared/desktop-api';
import type { GithubRequest, GithubReview, GithubValue } from '../../shared/github-publishing';

export function GithubPublishingPanel({ active }: { active: LocalProjectSession }): React.JSX.Element {
  const [account, setAccount] = useState<Extract<GithubValue, { state: string }> | null>(null), [review, setReview] = useState<GithubReview | null>(null);
  const [url, setUrl] = useState(''), [branch, setBranch] = useState('main'), [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmedUrl, setConfirmedUrl] = useState('');
  const send = async (request: GithubRequest): Promise<GithubValue> => {
    const result = await window.a3?.github(request); if (!result) throw new Error('Puente GitHub no disponible.'); if (!result.ok) throw new Error(result.error.message); return result.value;
  };
  const act = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'GitHub no disponible.'); } finally { setBusy(false); } };
  const accountAction = (action: 'status' | 'connect-manual' | 'disconnect' | 'manual-help'): void => { void act(async () => {
    const result = await send({ action, sessionId: active.sessionId });
    if ('state' in result) setAccount(result); if ('completed' in result && result.completed === 'disconnected') { setAccount(null); setReview(null); setNotice('Credencial local eliminada. No revoca el token en GitHub ni cierra la sesión del navegador.'); }
  }); };
  const prepare = (kind: 'push' | 'create'): void => { void act(async () => { const result = await send({ action: 'review', sessionId: active.sessionId, kind, url, branch, visibility }); if ('token' in result) { setReview(result); setConfirmedUrl(''); } }); };
  const apply = (): void => { if (review) void act(async () => {
    const result = await send({ action: 'apply', sessionId: active.sessionId, token: review.token, confirmedUrl });
    if ('completed' in result) { setReview(null); setNotice(result.completed === 'created' ? 'Repositorio creado vacío. Revisa por separado un push para enviar commits.' : `Push confirmado: ${result.url} · ${result.commit}`); }
  }); };
  const cancel = (): void => { if (review) { const token = review.token; void send({ action: 'cancel', sessionId: active.sessionId, token }).then(() => { setReview(null); setNotice('Cancelación solicitada. Si el envío ya empezó, verifica el remoto antes de repetir.'); }).catch(() => setError('No se confirmó la cancelación. Verifica el remoto.')); } };
  return <section data-github-panel aria-labelledby="github-publish-title">
    <h2 id="github-publish-title">Publicar en GitHub</h2>
    <p>El proyecto funciona localmente sin remoto. Esta acción usa solo la raíz <code>{active.root}</code>; los repositorios referenciados conservan su ámbito independiente.</p>
    <p>No hay OAuth de GitHub configurado. Puedes usar un token personal manual o crear el remoto y publicar con tus herramientas Git externas. El chat web y la cuenta de ChatGPT son independientes.</p>
    <p>Para conectar: copia el token desde GitHub y pulsa «Conectar token desde portapapeles». El host lo verifica y guarda con protección de Windows; no lo pegues en el proyecto.</p>
    <p>El token debe permitir leer metadatos y escribir contenido del destino. Crear un repositorio también necesita permiso de creación o administración; las reglas de organización, rama o workflows pueden exigir permisos adicionales.</p>
    <div className="git-actions"><button disabled={busy} onClick={() => accountAction('status')}>Consultar cuenta</button><button disabled={busy} onClick={() => accountAction('connect-manual')}>Conectar token desde portapapeles</button><button disabled={busy} onClick={() => accountAction('disconnect')}>Desconectar GitHub</button><button disabled={busy} onClick={() => accountAction('manual-help')}>Flujo externo manual</button></div>
    {account && <p data-github-account>{account.state === 'connected' ? `Cuenta: ${account.account?.login} · ID ${account.account?.id}` : 'Sin autorización en A3'} · Almacén protegido: {account.protectedStorage ? 'disponible' : 'no disponible'}</p>}
    <fieldset disabled={busy || !!review}><legend>Destino explícito</legend>
      <label>URL GitHub HTTPS<input aria-label="URL GitHub HTTPS" placeholder="https://github.com/cuenta/proyecto.git" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <label>Rama destino<input aria-label="Rama GitHub destino" value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
      <label>Visibilidad<select aria-label="Visibilidad GitHub" value={visibility} onChange={(event) => setVisibility(event.target.value as 'private' | 'public')}><option value="private">Privado (predeterminado)</option><option value="public">Público</option></select></label>
      <p>La visibilidad de un destino existente debe coincidir; A3 no la cambia. Crear un remoto solo admite tu cuenta personal.</p>
      <div className="git-actions"><button data-github-review disabled={!url || !branch} onClick={() => prepare('push')}>Revisar push</button><button disabled={!url || !branch} onClick={() => prepare('create')}>Revisar creación de repositorio</button></div>
    </fieldset>
    {review && <section className="git-review" aria-labelledby="github-review-title"><h3 id="github-review-title">Revisar {review.kind}</h3>
      <p>Cuenta: {review.account.login} · ID {review.account.id}</p><p>Raíz: <code>{review.root}</code></p><p>URL y destino: <code>{review.url}</code> · Repositorio ID: {review.remoteId ?? 'nuevo'}</p>
      <p>Visibilidad: {review.visibility} · Rama destino: {review.branch} · Commit: <code>{review.commit}</code></p>
      <p>Exclusiones: {review.exclusions.join('; ')}. Una exclusión en el historial bloquea el envío, no borra historia.</p>
      <p>{review.historyObjects} objetos de historia revisados · {review.bytes} bytes sin comprimir. Se publican solo commits confirmados, no archivos sin commit. {review.kind === 'create' && 'Esta acción solo crea el remoto vacío.'}</p>
      <details><summary>{review.files.length} archivos en el commit</summary><ul>{review.files.map((file) => <li key={file.path}>{file.path} · {file.bytes} bytes</li>)}</ul></details>
      <label>Confirma copiando la URL exacta<input aria-label="Confirmar URL GitHub" disabled={busy} value={confirmedUrl} onChange={(event) => setConfirmedUrl(event.target.value)} /></label>
      <button data-github-apply disabled={busy || confirmedUrl !== review.url} onClick={apply}>Confirmar destino y {review.kind === 'create' ? 'crear' : 'publicar'}</button><button onClick={cancel}>Cancelar revisión o envío</button>
    </section>}
    {notice && <p role="status" data-github-notice>{notice}</p>}{error && <p role="alert" data-github-error>{error}</p>}
  </section>;
}
