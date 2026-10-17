import { useCallback, useEffect, useState } from 'react';
import type { LocalProjectSession } from '../../shared/desktop-api';
import type { GitApplied, GitAutomationPolicy, GitAutomationSnapshot, GitMountChoice, GitProjectView, GitRequest, GitReviewInput, GitReviewView } from '../../shared/git-operations';
import { GithubPublishingPanel } from './GithubPublishingPanel';

export function GitPanel({ active, onChanged, initialMountId, onMountChange }: { active: LocalProjectSession | null; onChanged(): void; initialMountId?: string | null; onMountChange?(mountId: string | null): void }): React.JSX.Element {
  const [view, setView] = useState<GitProjectView | null>(null), [review, setReview] = useState<GitReviewView | null>(null);
  const [mounts, setMounts] = useState<readonly GitMountChoice[]>([]), [mountId, setMountId] = useState<string | null>(initialMountId ?? null);
  const [selected, setSelected] = useState<string[]>([]), [hunks, setHunks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [message, setMessage] = useState(''), [name, setName] = useState(''), [email, setEmail] = useState(''), [branch, setBranch] = useState(''), [commit, setCommit] = useState('');
  const [receipt, setReceipt] = useState<GitApplied | null>(null);
  const [automation, setAutomation] = useState<GitAutomationSnapshot | null>(null), [automationPreview, setAutomationPreview] = useState<readonly { path: string; text: string }[]>([]);
  const [automationDraft, setAutomationDraft] = useState<GitAutomationPolicy>({ schemaVersion: '1.0.0', mode: 'manual', idleMs: 300_000, branch: 'main', paths: [], messageTemplate: 'chore: update {count} files', authorName: '', authorEmail: '', pushAfterCommit: false });
  const request = useCallback(async (input: GitRequest) => {
    const result = await window.a3?.git(input);
    if (!result) throw new Error('El puente local de Git no está disponible.');
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, []);
  useEffect(() => { setMountId(initialMountId ?? null); }, [initialMountId]);
  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const catalog = await request({ action: 'mounts', sessionId: active.sessionId });
    if (Array.isArray(catalog)) setMounts(catalog);
    const selectedMount = Array.isArray(catalog) ? catalog.find((mount) => mount.mountId === mountId) : undefined;
    if (mountId && !selectedMount) { setView(null); setError('El montaje ya no pertenece al proyecto activo. Actualiza el explorador.'); return; }
    if (selectedMount && selectedMount.status !== 'available') { setView(null); setError(`La raíz del montaje no está disponible (${selectedMount.status}). Relocalízala desde Archivos.`); return; }
    if (selectedMount && !selectedMount.capabilities.git) { setView(null); setError('Git no está concedido para este montaje. Concede la capacidad de Git para esta raíz.'); return; }
    const result = await request({ action: 'load', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) });
    if ('status' in result) {
      setView(result); setSelected([]);
      const automationState = await request({ action: 'automation-state', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) });
      if ('policy' in automationState && 'run' in automationState) { setAutomation(automationState); setAutomationDraft(automationState.policy); setSelected([...automationState.policy.paths]); }
    }
  }, [active, request, mountId]);
  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se pudo leer Git.')); }, [load]);
  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'La operación no se completó.'); }
    finally { setBusy(false); }
  };
  const prepare = (input: GitReviewInput): void => { if (active) void act(async () => {
    const result = await request({ action: 'review', sessionId: active.sessionId, input, ...(mountId ? { mountId } : {}) });
    if ('token' in result) { setReview(result); setHunks(result.diffs.flatMap((diff) => diff.hunks.map((hunk) => hunk.id))); }
  }); };
  const apply = (): void => { if (active && review) void act(async () => {
    const partial = review.kind === 'stage' && review.diffs.length === 1 && review.diffs[0]!.hunks.length > 0;
    const result = await request({ action: 'apply', sessionId: active.sessionId, token: review.token, ...(mountId ? { mountId } : {}), ...(partial ? { hunkIds: hunks } : {}) });
    if ('applied' in result) {
      setReceipt(result); setReview(null); setNotice(`Operación ${result.kind} completada${result.commit ? ' · ' + result.commit.slice(0, 12) : ''}.`);
      if (result.kind.includes('restore')) onChanged(); await load();
    }
  }); };
  const cancel = (): void => { if (active && review) void act(async () => { await request({ action: 'cancel', sessionId: active.sessionId, token: review.token, ...(mountId ? { mountId } : {}) }); setReview(null); setNotice('Revisión cancelada.'); }); };
  const selectedMount = mounts.find((mount) => mount.mountId === mountId), projectRepository = !mountId;
  const setGitGrant = (granted: boolean): void => { if (!active || !mountId) return; void act(async () => {
    const result = await request({ action: 'mount-capability', sessionId: active.sessionId, mountId, granted });
    if ('changed' in result && result.changed) { setNotice(granted ? 'Git quedó concedido para esta raíz.' : 'Git quedó revocado para esta raíz.'); await load(); }
  }); };
  const saveAutomation = (): void => { if (!active) return; void act(async () => {
    const policy = { ...automationDraft, branch: automationDraft.branch || view?.status.branch || 'main', paths: [...selected] };
    const result = await request({ action: 'automation-save', sessionId: active.sessionId, ...(mountId ? { mountId } : {}), policy });
    if ('saved' in result) {
      setAutomationDraft(policy); setNotice('Política local guardada para esta raíz. El push conserva una autorización separada y revocable.');
      const state = await request({ action: 'automation-state', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) }); if ('policy' in state && 'run' in state) setAutomation(state);
    }
  }); };
  const previewAutomation = (): void => { if (!active) return; void act(async () => {
    const result = await request({ action: 'automation-preview', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) });
    if ('preview' in result) setAutomationPreview(result.diffs.map((diff) => ({ path: diff.path, text: diff.text })));
  }); };
  const resumeAutomation = (): void => { if (!active || mountId) return; void act(async () => {
    const result = await request({ action: 'automation-resume', sessionId: active.sessionId }); if ('run' in result) setAutomation(result);
  }); };
  const previewMatchesSavedPolicy = !!automation && JSON.stringify({ ...automationDraft, paths: [...selected] }) === JSON.stringify(automation.policy);
  useEffect(() => {
    if (!active || !automation || automation.policy.mode !== 'auto-after-idle') return;
    let stopped = false, lastCommit = automation.run.commit;
    const tick = async (): Promise<void> => {
      try {
        const result = await request({ action: 'automation-state', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) });
        if (stopped || !('run' in result) || !('policy' in result)) return;
        setAutomation(result);
        if (result.run.commit && result.run.commit !== lastCommit && ['committed', 'pushed'].includes(result.run.state)) { lastCommit = result.run.commit; onChanged(); const latest = await request({ action: 'load', sessionId: active.sessionId, ...(mountId ? { mountId } : {}) }); if ('status' in latest) setView(latest); }
      } catch { /* The visible automation state remains available; the next tick retries the status read. */ }
    };
    const timer = window.setInterval(() => { void tick(); }, 15_000); void tick();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, automation?.policy.mode, mountId, onChanged, request]);
  const ready = view?.status.state === 'ready';
  return <section className="git-panel" aria-labelledby="git-title">
    <p className="eyebrow">Proyecto A3 · Git local</p><h1 id="git-title">Versiones locales</h1>
    {!active ? <p>Abre un proyecto para revisar su repositorio.</p> : <>
      <label>Raíz Git<select aria-label="Raíz Git" value={mountId ?? ''} disabled={busy || !!review} onChange={(event) => { const id = event.target.value || null; setMountId(id); onMountChange?.(id); setView(null); setSelected([]); setError(''); setNotice(''); }}>
        <option value="">Proyecto A3 · {active.name}</option>{mounts.map((mount) => <option key={mount.mountId} value={mount.mountId}>{mount.label} · {mount.status}</option>)}
      </select></label>
      <p>Repositorio seleccionado: {projectRepository ? 'Proyecto A3' : selectedMount?.label ?? 'Montaje'} · raíz <code data-git-root>{view?.root ?? selectedMount?.root ?? (projectRepository ? active.root : 'sin binding local')}</code></p>
      <p>Rama: <strong>{view?.status.branch ?? 'Sin rama activa'}</strong> · Estado: <span data-git-state>{view?.status.state ?? 'consultando'}</span></p>
      <p>Las acciones afectan solo a la raíz seleccionada. A3 no busca repositorios padres ni hermanos. Guardar borradores es necesario antes de operar con Git.</p>
      {selectedMount && <div className="mount-git-permissions" aria-label="Permisos del montaje seleccionado">
        <p>Permisos independientes de esta raíz: lectura {selectedMount.capabilities.read ? 'concedida' : 'denegada'} · indexación {selectedMount.capabilities.index ? 'concedida' : 'denegada'} · Git {selectedMount.capabilities.git ? 'concedido' : 'denegado'} · escritura externa no disponible.</p>
        <button type="button" className="secondary" disabled={busy || !!review || !selectedMount.capabilities.git && selectedMount.status !== 'available'} onClick={() => setGitGrant(!selectedMount.capabilities.git)}>{selectedMount.capabilities.git ? 'Revocar Git en esta raíz' : 'Conceder Git en esta raíz'}</button>
      </div>}
      <button type="button" className="secondary" disabled={busy} onClick={() => void act(load)}>Actualizar estado</button>
      {view?.status.excludedTrackedCount ? <p role="alert">Hay {view.status.excludedTrackedCount} archivos protegidos en el índice. Crear commits queda bloqueado hasta revisar sus exclusiones.</p> : null}
      {ready && <>
        <fieldset disabled={busy || !!review}><legend>Seleccionar archivos</legend>
          {view.status.entries.length ? view.status.entries.map((entry) => <label key={entry.path} className="git-file"><input type="checkbox" aria-label={`Seleccionar ${entry.path}`} checked={selected.includes(entry.path)} onChange={(event) => setSelected((paths) => event.target.checked ? [...paths, entry.path] : paths.filter((path) => path !== entry.path))} /><code>{entry.index}{entry.worktree}</code> {entry.path}</label>) : <p>No hay cambios visibles.</p>}
          <div className="git-actions">
            <button type="button" data-git-stage disabled={!selected.length} onClick={() => prepare({ kind: 'stage', paths: selected })}>Revisar stage</button>
            <button type="button" disabled={!selected.length} onClick={() => prepare({ kind: 'unstage', paths: selected })}>Revisar unstage</button>
            <label>Versión de origen<select aria-label="Versión de origen" value={commit} onChange={(event) => setCommit(event.target.value)}><option value="">HEAD actual</option>{view.log.map((entry) => <option value={entry.oid} key={entry.oid}>{entry.oid.slice(0, 8)} · {entry.subject}</option>)}</select></label>
            {projectRepository && <button type="button" data-git-restore disabled={!selected.length || !view.status.head} onClick={() => prepare({ kind: 'restore', paths: selected, ...(commit ? { commit } : {}) })}>Revisar restore</button>}
          </div>
        </fieldset>
        <form onSubmit={(event) => { event.preventDefault(); prepare({ kind: 'commit', message, name, email }); }}><fieldset disabled={busy || !!review}><legend>Commit del índice revisado</legend>
          <label>Nombre del autor<input aria-label="Nombre del autor" required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Email del autor<input type="email" aria-label="Email del autor" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Mensaje del commit<textarea aria-label="Mensaje del commit" required maxLength={4096} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
          <button type="submit" data-git-commit>Revisar commit</button>
        </fieldset></form>
        <form onSubmit={(event) => { event.preventDefault(); prepare({ kind: 'branch', branch }); }}><fieldset disabled={busy || !!review}><legend>Ramas locales</legend>
          <ul>{view.branches.map((entry) => <li key={entry.name}>{entry.name} · <code>{entry.oid.slice(0, 8)}</code></li>)}</ul>
          <label>Nombre de rama nueva<input aria-label="Nombre de rama nueva" required value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
          <p>Crear una rama conserva la rama activa y el contenido actual.</p><button type="submit">Revisar creación de rama</button>
        </fieldset></form>
      </>}
      {ready && <section aria-labelledby="git-automation-title" className="git-automation">
        <h2 id="git-automation-title">Automatización de esta raíz</h2>
        <p>Solo usa archivos elegidos aquí. La espera comienza cuando cambia su contenido. Los conflictos, otra rama o permisos revocados detienen el lote. No se ejecutan scripts del repositorio.</p>
        <label>Política<select aria-label="Política de automatización" value={automationDraft.mode} onChange={(event) => setAutomationDraft((value) => ({ ...value, mode: event.target.value as GitAutomationPolicy['mode'], pushAfterCommit: event.target.value === 'auto-after-idle' ? value.pushAfterCommit : false }))}>
          <option value="manual">Solo manual</option><option value="auto-after-idle">Commit después de inactividad</option>
        </select></label>
        <label>Rama permitida<input aria-label="Rama de automatización" value={automationDraft.branch} onChange={(event) => setAutomationDraft((value) => ({ ...value, branch: event.target.value }))} /></label>
        <label>Espera (minutos)<input aria-label="Espera de automatización" type="number" min={0.5} max={1440} step={0.5} value={automationDraft.idleMs / 60_000} onChange={(event) => setAutomationDraft((value) => ({ ...value, idleMs: Math.round(Number(event.target.value) * 60_000) }))} /></label>
        <label>Plantilla de mensaje<input aria-label="Plantilla de mensaje" maxLength={512} value={automationDraft.messageTemplate} onChange={(event) => setAutomationDraft((value) => ({ ...value, messageTemplate: event.target.value }))} /></label>
        {automationDraft.mode === 'auto-after-idle' && <>
          <label>Autor del commit<input aria-label="Autor automático" required value={automationDraft.authorName} onChange={(event) => setAutomationDraft((value) => ({ ...value, authorName: event.target.value }))} /></label>
          <label>Email del autor<input aria-label="Email del autor automático" type="email" required value={automationDraft.authorEmail} onChange={(event) => setAutomationDraft((value) => ({ ...value, authorEmail: event.target.value }))} /></label>
          <label><input type="checkbox" aria-label="Habilitar publicación automática" checked={automationDraft.pushAfterCommit} disabled={!!mountId || !automation?.capabilities.push || !automation?.capabilities.pushCredentialAvailable} onChange={(event) => setAutomationDraft((value) => ({ ...value, pushAfterCommit: event.target.checked }))} /> Habilitar push automático con permiso Git push directo</label>
          {automationDraft.pushAfterCommit && <label>Destino GitHub exacto<input aria-label="Destino GitHub automático" type="url" required value={automationDraft.destinationUrl ?? ''} placeholder="https://github.com/owner/repository.git" onChange={(event) => setAutomationDraft((value) => ({ ...value, destinationUrl: event.target.value }))} /></label>}
        </>}
        <p>Archivos seleccionados: {selected.length ? selected.join(', ') : 'ninguno'}. La selección se guarda junto a la política.</p>
        <div className="git-actions"><button type="button" disabled={busy || !!review} onClick={saveAutomation}>Guardar política</button><button type="button" className="secondary" disabled={busy || !!review || !previewMatchesSavedPolicy || !automation?.policy.paths.length} onClick={previewAutomation}>Previsualizar diff</button></div>
        {automation && <p role="status">Estado: {automation.run.state}{automation.run.code ? ` · ${automation.run.code}` : ''}{automation.run.branch ? ` · rama ${automation.run.branch}` : ''}{automation.run.commit ? ` · commit ${automation.run.commit.slice(0, 12)}` : ''} · stage {automation.capabilities.stage ? 'directo' : 'denegado'} · commit {automation.capabilities.commit ? 'directo' : 'denegado'} · permiso push {automation.capabilities.push ? 'directo' : 'denegado'} · credencial GitHub {automation.capabilities.pushCredentialAvailable ? 'guardada' : 'ausente / no compatible en esta raíz'}</p>}
        {automation?.run.state === 'push-pending' || automation?.run.state === 'blocked' && ['authorization-expired', 'authorization-unavailable', 'remote-unavailable', 'github-unavailable', 'remote-conflict', 'remote-permission-denied'].includes(automation.run.code ?? '') ? <button type="button" disabled={busy || !!review || !!mountId || (!!automation.run.commit && !automation.capabilities.push)} onClick={resumeAutomation}>{automation.run.commit ? 'Reintentar solo este push pendiente' : 'Reintentar tras resolver el bloqueo'}</button> : null}
        {automation?.run.diffs?.map((diff) => <article key={`run-${diff.path}`}><h3>Diff ejecutado · {diff.path}</h3><pre aria-label={`Diff ejecutado ${diff.path}`}>{diff.text}</pre></article>)}
        {automationPreview.map((diff) => <article key={diff.path}><h3>{diff.path}</h3><pre aria-label={`Diff propuesto ${diff.path}`}>{diff.text}</pre></article>)}
      </section>}
      {review && <section className="git-review" aria-labelledby="git-review-title"><h2 id="git-review-title">Revisar {review.kind}</h2>
        <p>Raíz: <code>{review.root}</code> · Rama: {review.branch ?? 'sin rama'}</p>
        {review.message && <p>Mensaje: {review.message}</p>}{review.targetBranch && <p>Rama nueva: {review.targetBranch}</p>}{review.targetCommit && <p>Versión: {review.targetCommit}</p>}
        <p>Afectados: {review.paths.join(', ')}</p>{review.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        {review.diffs.map((diff) => <article key={diff.path}><h3>{diff.path}</h3><pre aria-label={`Diff ${diff.path}`}>{diff.text}</pre>
          {review.kind === 'stage' && review.diffs.length === 1 && diff.hunks.map((hunk, index) => <label key={hunk.id}><input type="checkbox" aria-label={`Incluir hunk ${index + 1}`} checked={hunks.includes(hunk.id)} onChange={(event) => setHunks((ids) => event.target.checked ? [...ids, hunk.id] : ids.filter((id) => id !== hunk.id))} />Incluir hunk {index + 1}</label>)}
        </article>)}
        <div className="git-actions"><button type="button" data-git-apply disabled={busy} onClick={apply}>Aplicar revisión</button><button type="button" disabled={busy} onClick={cancel}>Cancelar revisión</button></div>
      </section>}
      {receipt?.snapshotId && <p role="status">Punto de retorno: <code data-git-snapshot>{receipt.snapshotId}</code> <button type="button" disabled={busy || !!review} onClick={() => prepare({ kind: 'undo-restore', undoToken: receipt.undoToken })}>Revisar retorno</button></p>}
    </>}
    {notice && <p role="status" data-git-notice>{notice}</p>}{error && <p role="alert" data-git-error>{error}</p>}
    {active && projectRepository && <GithubPublishingPanel key={active.sessionId} active={active} />}
  </section>;
}
