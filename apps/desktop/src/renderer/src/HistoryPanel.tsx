import { useCallback, useEffect, useState } from 'react';
import type { LocalProjectSession, LocalHistoryRestorePreview } from '../../shared/desktop-api';
import type { HistoryRequest, HistoryResult } from '../../shared/history';
import type { GitApplied, GitProjectView, GitRequest, GitReviewView } from '../../shared/git-operations';

type Source = 'local' | 'git' | 'agents';
function displayDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
function bytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }

export function HistoryPanel({ active, onChanged, onOpenGit }: { active: LocalProjectSession | null; onChanged(): void; onOpenGit(): void }): React.JSX.Element {
  const [source, setSource] = useState<Source>('local');
  const [snapshots, setSnapshots] = useState<readonly import('../../shared/desktop-api').SnapshotSummary[]>([]);
  const [localDiagnostics, setLocalDiagnostics] = useState<readonly string[]>([]);
  const [git, setGit] = useState<GitProjectView | null>(null), [preview, setPreview] = useState<LocalHistoryRestorePreview | GitReviewView | null>(null);
  const [receipt, setReceipt] = useState<GitApplied | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [gitError, setGitError] = useState(''), [notice, setNotice] = useState('');
  const history = useCallback(async (request: HistoryRequest): Promise<Extract<HistoryResult, { ok: true }>['value']> => {
    const result = await window.a3?.history(request);
    if (!result) throw new Error('El puente de historial no está disponible.');
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, []);
  const gitRequest = useCallback(async (request: GitRequest): Promise<GitProjectView | GitReviewView | GitApplied | { cancelled: true }> => {
    const result = await window.a3?.git(request);
    if (!result) throw new Error('El puente local de Git no está disponible.');
    if (!result.ok) throw new Error(result.error.message);
    if (Array.isArray(result.value) || 'changed' in result.value) throw new Error('La operación de historial devolvió un tipo de respuesta inesperado.');
    return result.value as GitProjectView | GitReviewView | GitApplied | { cancelled: true };
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const [localResult, gitResult] = await Promise.allSettled([history({ action: 'load', sessionId: active.sessionId }), gitRequest({ action: 'load', sessionId: active.sessionId })]);
    if (localResult.status === 'rejected') throw localResult.reason;
    const local = localResult.value;
    if ('snapshots' in local) { setSnapshots(local.snapshots); setLocalDiagnostics(local.diagnostics); }
    if (gitResult.status === 'rejected') { setGit(null); setGitError(gitResult.reason instanceof Error ? gitResult.reason.message : 'Git no está disponible.'); }
    else if ('status' in gitResult.value) { setGit(gitResult.value); setGitError(''); }
  }, [active, history, gitRequest]);
  useEffect(() => { setPreview(null); setReceipt(null); setError(''); setNotice(''); void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se pudo leer el historial.')); }, [load]);
  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'La operación no se completó.'); }
    finally { setBusy(false); }
  };
  const reviewLocal = (snapshotId: string): void => { if (active) void act(async () => {
    const value = await history({ action: 'preview', sessionId: active.sessionId, snapshotId });
    if ('changes' in value) setPreview(value);
  }); };
  const reviewGit = (commit: string): void => { if (active) void act(async () => {
    const value = await gitRequest({ action: 'review', sessionId: active.sessionId, input: { kind: 'restore-commit', commit } });
    if ('token' in value) setPreview(value);
  }); };
  const cancelReview = (): void => { if (!active || !preview) return; void act(async () => {
    if ('snapshot' in preview) await history({ action: 'cancel', sessionId: active.sessionId, token: preview.token });
    else await gitRequest({ action: 'cancel', sessionId: active.sessionId, token: preview.token });
    setPreview(null); setNotice('Revisión cancelada; no se modificó el proyecto.');
  }); };
  const applyReview = (): void => { if (!active || !preview) return; void act(async () => {
    if ('snapshot' in preview) {
      const value = await history({ action: 'apply', sessionId: active.sessionId, token: preview.token });
      if ('snapshotId' in value) setNotice(`Restauración local aplicada mediante el journal. Punto de vuelta: ${value.snapshotId ?? 'no necesario'}.`);
    } else {
      const value = await gitRequest({ action: 'apply', sessionId: active.sessionId, token: preview.token });
      if ('applied' in value) {
        setReceipt(value);
        setNotice(`Versión Git aplicada mediante el journal. Punto de vuelta local: ${value.snapshotId ?? 'no necesario'}.`);
      }
    }
    setPreview(null); onChanged(); await load();
  }); };
  const canWrite = active?.mode === 'writer' && !active.externalConflict;

  return <section className="history-panel" aria-labelledby="history-title">
    <p className="eyebrow">Proyecto A3 · Recuperación e historial</p><h1 id="history-title">Historial del proyecto</h1>
    {!active ? <p>Abre un proyecto para consultar sus snapshots y versiones Git.</p> : <>
      <p>Las ediciones locales, los commits Git y la actividad de agentes se muestran como fuentes distintas. Git no sustituye los snapshots de recuperación.</p>
      <div role="tablist" aria-label="Fuentes del historial" className="git-actions">
        <button type="button" role="tab" aria-selected={source === 'local'} disabled={busy || !!preview} onClick={() => setSource('local')}>Recuperación local</button>
        <button type="button" role="tab" aria-selected={source === 'git'} disabled={busy || !!preview} onClick={() => setSource('git')}>Git</button>
        <button type="button" role="tab" aria-selected={source === 'agents'} disabled={busy || !!preview} onClick={() => setSource('agents')}>Agentes</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(load)}>Actualizar</button>
      </div>
      {source === 'local' && <section role="tabpanel" aria-label="Recuperación local">
        <h2>Snapshots de recuperación</h2><p>Capturas anteriores a operaciones del store. La restauración conserva una copia nueva del estado actual antes de aplicar cambios.</p>
        {localDiagnostics.map((diagnostic) => <p role="status" key={diagnostic}>{diagnostic}</p>)}
        {snapshots.length ? <ul className="history-list">{snapshots.map((snapshot) => <li key={snapshot.snapshotId}>
          <div><strong>{displayDate(snapshot.createdAt)}</strong> · {snapshot.reason}<p>{snapshot.fileCount} archivo(s) · {bytes(snapshot.bytes)} · <code>{snapshot.snapshotId}</code></p></div>
          <button type="button" disabled={busy || !canWrite || !!preview} onClick={() => reviewLocal(snapshot.snapshotId)}>Previsualizar restauración</button>
        </li>)}</ul> : <p>No hay snapshots de recuperación disponibles para este proyecto.</p>}
        {!canWrite && <p role="status">La restauración requiere un proyecto en modo escritor y sin conflictos externos pendientes.</p>}
      </section>}
      {source === 'git' && <section role="tabpanel" aria-label="Versiones Git">
        {gitError && <p role="alert">Git no está disponible en este momento: {gitError} Los snapshots locales siguen disponibles.</p>}
        <h2>Estado local sin commit</h2>
        <p>Estos cambios están en el directorio de trabajo o el índice. A3 no los confunde con un snapshot ni con un commit.</p>
        {git?.status.state === 'ready' && git.status.entries.length ? <ul>{git.status.entries.map((entry) => <li key={entry.path}><code>{entry.index}{entry.worktree}</code> {entry.path}</li>)}</ul> : <p>{git?.status.state === 'ready' ? 'Sin cambios Git locales.' : git?.status.state === 'not-installed' ? 'Git no está instalado; los snapshots locales siguen disponibles.' : `Estado Git: ${git?.status.state ?? 'consultando'}.`}</p>}
        <h2>Commits</h2>
        {git?.log.length ? <ol className="history-list">{git.log.map((entry) => <li key={entry.oid}>
          <div><strong>{displayDate(entry.date)}</strong> · {entry.subject}<p><code>{entry.oid}</code></p></div>
          <button type="button" disabled={busy || !canWrite || !!preview || git.status.state !== 'ready'} onClick={() => reviewGit(entry.oid)}>Revisar y restaurar esta versión</button>
        </li>)}</ol> : <p>{gitError ? 'No se pudo leer la lista de commits.' : 'No hay commits locales disponibles.'}</p>}
        <button type="button" className="secondary" onClick={onOpenGit}>Abrir operaciones Git locales</button>
      </section>}
      {source === 'agents' && <section role="tabpanel" aria-label="Actividad de agentes"><h2>Actividad de agentes</h2><p>Aún no hay un registro de actividad de agentes conectado a este historial.</p></section>}
      {preview && <section className="git-review" aria-labelledby="history-review-title"><h2 id="history-review-title">Previsualizar restauración</h2>
        {'snapshot' in preview ? <><p>Fuente local · {displayDate(preview.snapshot.createdAt)} · snapshot <code>{preview.snapshot.snapshotId}</code></p>
          <p>La operación se aplicará con revisión y journal. Una restauración de varios archivos no es atómica.</p>
          {preview.changes.map((change) => <article key={change.path}><h3>{change.path}</h3><p>SHA-256: {change.beforeHash ?? 'ausente'} → {change.afterHash ?? 'ausente'} · {bytes(change.beforeBytes)} → {bytes(change.afterBytes)}</p><pre aria-label={`Diff ${change.path}`}>{change.diff ?? `Diff no disponible (${change.detail ?? 'formato binario'}); se muestran hashes y tamaños.`}</pre></article>)}</>
          : <><p>Fuente Git · commit <code>{preview.targetCommit}</code> · rama actual {preview.branch ?? 'sin rama'}</p><p>Git y los editores deben permanecer sin cambios hasta aplicar. A3 guardará un punto de vuelta local y usará el journal E1.</p>
            <p>Archivos afectados: {preview.paths.length}</p>{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            {preview.diffs.map((diff) => <article key={diff.path}><h3>{diff.path}</h3><pre aria-label={`Diff ${diff.path}`}>{diff.text}</pre></article>)}</>}
        <div className="git-actions"><button type="button" disabled={busy || !canWrite} onClick={applyReview}>Aplicar restauración</button><button type="button" disabled={busy} onClick={cancelReview}>Cancelar</button></div>
      </section>}
      {receipt?.snapshotId && <p role="status">El punto de vuelta se guarda como snapshot E1: <code>{receipt.snapshotId}</code>.</p>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
