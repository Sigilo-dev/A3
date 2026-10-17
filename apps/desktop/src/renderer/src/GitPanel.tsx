import { useCallback, useEffect, useState } from 'react';
import type { LocalProjectSession } from '../../shared/desktop-api';
import type { GitApplied, GitProjectView, GitRequest, GitReviewInput, GitReviewView } from '../../shared/git-operations';

export function GitPanel({ active, onChanged }: { active: LocalProjectSession | null; onChanged(): void }): React.JSX.Element {
  const [view, setView] = useState<GitProjectView | null>(null), [review, setReview] = useState<GitReviewView | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [hunks, setHunks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [message, setMessage] = useState(''), [name, setName] = useState(''), [email, setEmail] = useState(''), [branch, setBranch] = useState(''), [commit, setCommit] = useState('');
  const [receipt, setReceipt] = useState<GitApplied | null>(null);
  const request = useCallback(async (input: GitRequest) => {
    const result = await window.a3?.git(input);
    if (!result) throw new Error('El puente local de Git no está disponible.');
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const result = await request({ action: 'load', sessionId: active.sessionId });
    if ('status' in result) { setView(result); setSelected([]); }
  }, [active, request]);
  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se pudo leer Git.')); }, [load]);
  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'La operación no se completó.'); }
    finally { setBusy(false); }
  };
  const prepare = (input: GitReviewInput): void => { if (active) void act(async () => {
    const result = await request({ action: 'review', sessionId: active.sessionId, input });
    if ('token' in result) { setReview(result); setHunks(result.diffs.flatMap((diff) => diff.hunks.map((hunk) => hunk.id))); }
  }); };
  const apply = (): void => { if (active && review) void act(async () => {
    const partial = review.kind === 'stage' && review.diffs.length === 1 && review.diffs[0]!.hunks.length > 0;
    const result = await request({ action: 'apply', sessionId: active.sessionId, token: review.token, ...(partial ? { hunkIds: hunks } : {}) });
    if ('applied' in result) {
      setReceipt(result); setReview(null); setNotice(`Operación ${result.kind} completada${result.commit ? ' · ' + result.commit.slice(0, 12) : ''}.`);
      if (result.kind.includes('restore')) onChanged(); await load();
    }
  }); };
  const cancel = (): void => { if (active && review) void act(async () => { await request({ action: 'cancel', sessionId: active.sessionId, token: review.token }); setReview(null); setNotice('Revisión cancelada.'); }); };
  const ready = view?.status.state === 'ready';
  return <section className="git-panel" aria-labelledby="git-title">
    <p className="eyebrow">Proyecto A3 · Git local</p><h1 id="git-title">Versiones locales</h1>
    {!active ? <p>Abre un proyecto para revisar su repositorio.</p> : <>
      <p>Raíz del repositorio: <code data-git-root>{view?.root ?? active.root}</code></p>
      <p>Rama: <strong>{view?.status.branch ?? 'Sin rama activa'}</strong> · Estado: <span data-git-state>{view?.status.state ?? 'consultando'}</span></p>
      <p>Las acciones de esta pantalla afectan solo al proyecto A3. Guardar borradores es necesario antes de operar con Git.</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void act(load)}>Actualizar estado</button>
      {view?.status.excludedTrackedCount ? <p role="alert">Hay {view.status.excludedTrackedCount} archivos protegidos en el índice. Crear commits queda bloqueado hasta revisar sus exclusiones.</p> : null}
      {ready && <>
        <fieldset disabled={busy || !!review}><legend>Seleccionar archivos</legend>
          {view.status.entries.length ? view.status.entries.map((entry) => <label key={entry.path} className="git-file"><input type="checkbox" aria-label={`Seleccionar ${entry.path}`} checked={selected.includes(entry.path)} onChange={(event) => setSelected((paths) => event.target.checked ? [...paths, entry.path] : paths.filter((path) => path !== entry.path))} /><code>{entry.index}{entry.worktree}</code> {entry.path}</label>) : <p>No hay cambios visibles.</p>}
          <div className="git-actions">
            <button type="button" data-git-stage disabled={!selected.length} onClick={() => prepare({ kind: 'stage', paths: selected })}>Revisar stage</button>
            <button type="button" disabled={!selected.length} onClick={() => prepare({ kind: 'unstage', paths: selected })}>Revisar unstage</button>
            <label>Versión de origen<select aria-label="Versión de origen" value={commit} onChange={(event) => setCommit(event.target.value)}><option value="">HEAD actual</option>{view.log.map((entry) => <option value={entry.oid} key={entry.oid}>{entry.oid.slice(0, 8)} · {entry.subject}</option>)}</select></label>
            <button type="button" data-git-restore disabled={!selected.length || !view.status.head} onClick={() => prepare({ kind: 'restore', paths: selected, ...(commit ? { commit } : {}) })}>Revisar restore</button>
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
  </section>;
}
