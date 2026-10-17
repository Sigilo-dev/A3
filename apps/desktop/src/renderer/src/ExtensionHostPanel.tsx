import { useEffect, useRef, useState } from 'react';
import type { LocalProjectSession } from '../../shared/desktop-api';
import type { ExtensionHostSnapshot, ExtensionReview, ExtensionsRequest } from '../../shared/extensions';

export function ExtensionHostPanel({ project }: { project: LocalProjectSession }): React.JSX.Element {
  const [state, setState] = useState<ExtensionHostSnapshot | null>(null), [review, setReview] = useState<ExtensionReview | null>(null);
  const [licenseAcknowledged, setLicenseAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const session = useRef(project.sessionId); session.current = project.sessionId;
  async function send(request: ExtensionsRequest): Promise<void> {
    setBusy(true); setError('');
    try {
      const result = await window.a3?.extensions(request);
      if (session.current !== request.sessionId) return;
      if (!result) throw new Error('El host de extensiones no está disponible.');
      if (!result.ok) { if (request.action === 'apply') setReview(null); throw new Error(`${result.error.code}: ${result.error.message}`); }
      if ('token' in result.value) { setReview(result.value); setLicenseAcknowledged(false); }
      else { setState(result.value); setReview(null); setLicenseAcknowledged(false); }
    } catch (reason) { if (session.current === request.sessionId) setError(reason instanceof Error ? reason.message : 'No se completó la operación.'); }
    finally { if (session.current === request.sessionId) setBusy(false); }
  }
  useEffect(() => { setState(null); setReview(null); setError(''); void send({ action: 'status', sessionId: project.sessionId }); }, [project.sessionId]);
  async function importManifest(file?: File): Promise<void> {
    if (!file || busy) return;
    const sessionId = project.sessionId;
    if (file.size > 256 * 1024) { setError('El manifiesto supera 256 KiB.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (session.current === sessionId) await send({ action: 'review', sessionId, bytes });
  }
  return <section className="node-package-card" aria-labelledby="extension-host-title">
    <h2 id="extension-host-title">Extensiones programadas</h2>
    <p role="status">Ejecución deshabilitada: A3 todavía no tiene una sandbox Windows comprobada para plugins. Las aprobaciones locales siguen sin permiso efectivo de ejecución.</p>
    <label className="secondary node-package-import">Revisar manifiesto JSON<input type="file" accept=".json,application/json" aria-label="Revisar manifiesto de extensión programada" disabled={busy} onChange={(event) => { void importManifest(event.currentTarget.files?.[0]).catch(() => setError('No se pudo leer el manifiesto.')); event.currentTarget.value = ''; }} /></label>
    {review && <section aria-label="Revisión de manifiesto de extensión">
      <h3>{review.manifest.name} · {review.manifest.version}</h3>
      <p>ID: {review.manifest.id} · Licencia declarada: {review.manifest.license}</p>
      <p>SHA-256 del manifiesto: <code>{review.integrity}</code></p>
      <p>Compatibilidad A3: {review.compatible ? 'compatible con API 1.0.0' : 'no compatible'} · Licencia declarada: {review.license}</p>
      <p>Entrypoint declarado: {review.manifest.entrypoints.main.path}. Su código no se abre ni se verifica como ejecutable.</p>
      {review.previousVersion && <p>Actualización {review.previousVersion} → {review.manifest.version}. Se valida en staging, conserva la versión previa para rollback y revoca todas las concesiones anteriores. Los datos del proyecto permanecen intactos.</p>}
      <pre>{JSON.stringify(review.changes, null, 2)}</pre>
      <label><input type="checkbox" checked={licenseAcknowledged} disabled={busy} onChange={(event) => setLicenseAcknowledged(event.currentTarget.checked)} /> He revisado la licencia declarada y los cambios de permisos y scopes.</label>
      <button type="button" className="secondary" disabled={busy || !licenseAcknowledged || !review.compatible} onClick={() => { void send({ action: 'apply', sessionId: project.sessionId, token: review.token, licenseAcknowledged }); }}>Instalar en staging y activar desactivada</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => setReview(null)}>Cancelar revisión</button>
    </section>}
    {state?.extensions.map((entry) => <article className="node-package-card" key={entry.manifest.id}>
      <h3>{entry.manifest.name} · {entry.manifest.version}</h3><p>{entry.manifest.id} · Desactivada · Runtime no disponible</p>
      <p>El modo fallback conserva entidades, fuentes, propiedades y conexiones. La extensión no puede leer ni modificar datos del proyecto mientras no haya sandbox y concesión efectivas.</p>
      {entry.rollbackVersion && <button type="button" className="secondary" disabled={busy} onClick={() => { void send({ action: 'rollback', sessionId: project.sessionId, id: entry.manifest.id, integrity: entry.integrity }); }}>Volver a {entry.rollbackVersion}</button>}
      {entry.permissions.map((permission) => <div key={permission.capability}>
        <p><strong>{permission.capability}</strong> · {permission.approved ? 'Aprobación local registrada' : 'Sin concesión local'} · Efectiva: no</p>
        <pre>{JSON.stringify(permission.requested, null, 2)}</pre>
        <button type="button" className="secondary" disabled={busy} onClick={() => { void send({ action: 'grant', sessionId: project.sessionId, id: entry.manifest.id, integrity: entry.integrity, capability: permission.capability, scope: permission.requested }); }}>Revisar concesión de {permission.capability}</button>
        <button type="button" className="quiet" disabled={busy || !permission.approved} onClick={() => { void send({ action: 'revoke', sessionId: project.sessionId, id: entry.manifest.id, integrity: entry.integrity, capability: permission.capability }); }}>Revocar {permission.capability}</button>
      </div>)}
      <p>La ejecución requiere una sandbox comprobada y la intersección de cada concesión local con los permisos efectivos del proyecto.</p>
      <button type="button" className="quiet" disabled={busy} onClick={() => { void send({ action: 'disable', sessionId: project.sessionId, id: entry.manifest.id, integrity: entry.integrity }); }}>Desactivar y revocar concesiones</button>
      <button type="button" className="quiet danger" disabled={busy} onClick={() => { void send({ action: 'remove', sessionId: project.sessionId, id: entry.manifest.id, integrity: entry.integrity }); }}>Quitar registro · conservar datos</button>
    </article>)}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
