import { useEffect, useRef, useState } from 'react';
import { AV_PROFILES, validAvSettings, type AvEngineInfo, type AvJobView, type AvRequest, type AvSettings } from '../../shared/av-conversion';

interface Row { resourceId: string; jobId: string; view?: AvJobView; settings?: AvSettings; name: string; error?: string; }
const states: Record<AvJobView['state'], string> = { inspecting: 'Inspeccionando…', inspected: 'Inspeccionado', queued: 'En cola', converting: 'Convirtiendo…', verifying: 'Verificando salida…', staged: 'Salida preparada', saving: 'Confirmando…', saved: 'Recurso creado', cancelled: 'Cancelado', error: 'Error', conflict: 'Conflicto' };
const inProgress = (view?: AvJobView): boolean => !!view && ['inspecting', 'queued', 'converting', 'verifying', 'saving'].includes(view.state);
const size = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

export function AvConversionDialog({ sessionId, resourceIds, onClose, onSaved }: { sessionId: string; resourceIds: string[]; onClose(): void; onSaved(): void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([]), [selected, setSelected] = useState(0), [engine, setEngine] = useState<AvEngineInfo | null>(null);
  const [error, setError] = useState(''), [closing, setClosing] = useState(false), [configuring, setConfiguring] = useState(false), [generation, setGeneration] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), current = useRef(rows); current.current = rows;
  const key = resourceIds.join(','), saving = rows.some((row) => row.view?.state === 'saving');
  async function call(request: AvRequest): Promise<AvJobView | AvEngineInfo> {
    const result = await window.a3?.avConversion(request);
    if (!result) throw new Error('El puente local no está disponible.');
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
    return result.value;
  }
  function patch(jobId: string, change: Partial<Row>): void { setRows((before) => before.map((row) => row.jobId === jobId ? { ...row, ...change } : row)); }
  function receive(view: AvJobView): void {
    setRows((before) => before.map((row) => {
      if (row.jobId !== view.jobId) return row;
      const video = view.source?.streams.find((stream) => stream.kind === 'video');
      const profile = video ? 'mp4' : 'mp3';
      return { ...row, view, ...(!row.settings && view.source ? { settings: { profile, width: Math.max(2, Math.floor((video?.width ?? 160) / 2) * 2), height: Math.max(2, Math.floor((video?.height ?? 90) / 2) * 2), crf: 23, audioKbps: 128 },
        name: (view.sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:<>"|?*\x00-\x1f]/g, '_').slice(0, 100) || 'media') + `-converted-${row.jobId.slice(0, 8)}.${profile}` } : {}) };
    }));
  }
  useEffect(() => {
    const origin = document.activeElement; dialog.current?.showModal();
    return () => { if (origin instanceof HTMLElement && origin.isConnected) origin.focus(); };
  }, []);
  useEffect(() => {
    let live = true, polling = false;
    const pending = [...new Set(resourceIds)].slice(0, 16).map((resourceId) => ({ resourceId, jobId: crypto.randomUUID(), name: '' }));
    setRows(pending); setSelected(0);
    void call({ action: 'engine-status' }).then((value) => { if (live && 'available' in value) setEngine(value); }).catch((e: Error) => { if (live) setError(e.message); });
    void (async () => { for (const row of pending) {
      if (!live) break;
      try { const value = await call({ action: 'inspect', sessionId, jobId: row.jobId, resourceId: row.resourceId }); if (live && 'jobId' in value) receive(value); }
      catch (e) { if (live) patch(row.jobId, { error: e instanceof Error ? e.message : 'No se pudo inspeccionar.' }); }
    } })();
    const timer = setInterval(() => {
      if (polling) return; polling = true;
      void (async () => { try { for (const row of current.current.filter((row) => inProgress(row.view))) {
        const value = await call({ action: 'status', sessionId, jobId: row.jobId }); if (live && 'jobId' in value) receive(value);
      } } catch (e) { if (live) setError(e instanceof Error ? e.message : 'No se pudo consultar el trabajo.'); } finally { polling = false; } })();
    }, 400);
    return () => { live = false; clearInterval(timer); for (const row of pending) void window.a3?.avConversion({ action: 'cancel', sessionId, jobId: row.jobId }); };
  }, [sessionId, key, generation]);
  async function close(): Promise<void> {
    if (saving || closing) return; setClosing(true);
    await Promise.allSettled(current.current.map((row) => call({ action: 'cancel', sessionId, jobId: row.jobId }))); onClose();
  }
  async function configure(): Promise<void> {
    if (configuring || saving) return; setConfiguring(true); setError('');
    try {
      const value = await call({ action: 'configure-engine' }); if ('available' in value) setEngine(value);
      if ('available' in value && value.available) {
        await Promise.allSettled(current.current.map((row) => call({ action: 'cancel', sessionId, jobId: row.jobId }))); setGeneration((n) => n + 1);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo configurar.'); }
    finally { setConfiguring(false); }
  }
  function edit(row: Row, settings: AvSettings, name = row.name): void { patch(row.jobId, { settings, name, error: undefined,
    ...(row.view ? { view: { ...row.view, state: 'inspected', output: undefined } } : {}) }); }
  async function action(row: Row, kind: 'convert' | 'save' | 'cancel'): Promise<void> {
    if (kind === 'convert' && (!row.settings || !validAvSettings(row.settings))) return;
    try {
      patch(row.jobId, { error: undefined, ...(row.view && kind !== 'cancel' ? { view: { ...row.view, state: kind === 'save' ? 'saving' : 'queued' } } : {}) });
      const value = await call(kind === 'convert' ? { action: kind, sessionId, jobId: row.jobId, settings: row.settings!, destination: `assets/converted/${row.name}` } : { action: kind, sessionId, jobId: row.jobId });
      if ('jobId' in value) { receive(value); if (value.state === 'saved') onSaved(); }
    } catch (e) { patch(row.jobId, { error: e instanceof Error ? e.message : 'No se pudo completar.', ...(row.view ? { view: { ...row.view, state: 'error' } } : {}) }); }
  }
  const row = rows[selected], view = row?.view, settings = row?.settings, video = view?.source?.streams.find((stream) => stream.kind === 'video');
  const busy = closing || configuring || inProgress(view) || view?.state === 'saved' || view?.state === 'cancelled';
  const allowed = (item: Row): boolean => !!item.settings && validAvSettings(item.settings) && !!item.view?.source?.supported && !!item.view.engine.profiles.includes(item.settings.profile) && !inProgress(item.view) && !['saved', 'cancelled'].includes(item.view.state);
  return <dialog ref={dialog} className="image-conversion-dialog av-conversion-dialog" aria-labelledby="av-title" onCancel={(event) => { event.preventDefault(); void close(); }}>
    <header><h2 id="av-title">Convertir audio y video</h2><button className="secondary" autoFocus disabled={saving || closing} onClick={() => void close()}>{closing ? 'Cancelando…' : 'Cerrar / cancelar pendientes'}</button></header>
    <p>El original se conserva. Cada salida se inspecciona y decodifica completa antes de poder crear un recurso nuevo. Un trabajo de audio/video a la vez.</p>
    <p role="status" data-av-engine>{engine?.message ?? 'Comprobando componente opcional…'} {engine?.version} {engine?.license}</p>
    <button className="secondary" data-av-configure disabled={configuring || rows.some((row) => inProgress(row.view))} onClick={() => void configure()}>Configurar FFmpeg/ffprobe opcionales…</button>
    {error && <p role="alert" className="error">{error}</p>}
    {rows.length > 1 && <nav className="image-conversion-batch" aria-label="Archivos del lote">{rows.map((item, index) => <button className="secondary" key={item.jobId} aria-current={index === selected ? 'true' : undefined} onClick={() => setSelected(index)}>{item.view?.sourceName ?? `Medio ${index + 1}`} · {item.view ? states[item.view.state] : 'Inspeccionando…'}</button>)}</nav>}
    {row?.error && <p role="alert" className="error">{row.error}</p>}
    {view && <p data-av-state role="status">{states[view.state]}{view.message ? ` · ${view.message}` : ''}</p>}
    {view?.source && <div className="image-source-info" data-av-source><strong>{view.sourceName}</strong><span>Contenedor real: {view.source.container} · {size(view.source.bytes)} · {view.source.duration === null ? 'Duración desconocida' : `${view.source.duration.toFixed(2)} s`}</span>
      {view.source.streams.map((stream) => <span key={stream.index}>Pista {stream.index}: {stream.kind} / {stream.codec}{stream.width ? ` · ${stream.width} × ${stream.height} · ${stream.frameRate ?? '?'} fps` : ''}{stream.channels ? ` · ${stream.channels} canal(es) · ${stream.sampleRate} Hz` : ''}</span>)}</div>}
    {row && view?.source && settings && <>
      <fieldset className="image-conversion-options" disabled={busy}><legend>Perfil, calidad y destino</legend>
        <label>Perfil<select data-av-profile value={settings.profile} onChange={(event) => { const profile = event.target.value as AvSettings['profile']; edit(row, { ...settings, profile }, row.name.replace(/\.[^.]+$/, '.' + profile)); }}>
          {AV_PROFILES.map((profile) => <option key={profile.id} value={profile.id} disabled={!view.engine.profiles.includes(profile.id) || profile.video && !video}>{profile.label}{!view.engine.profiles.includes(profile.id) ? ' · Componente requerido' : profile.video && !video ? ' · Requiere video' : ''}</option>)}</select></label>
        <label>Anchura (px, par)<input type="number" min="2" max="1920" step="2" disabled={!AV_PROFILES.find((p) => p.id === settings.profile)?.video} value={settings.width} onChange={(event) => edit(row, { ...settings, width: Number(event.target.value) })} /></label>
        <label>Altura (px, par)<input type="number" min="2" max="1080" step="2" disabled={!AV_PROFILES.find((p) => p.id === settings.profile)?.video} value={settings.height} onChange={(event) => edit(row, { ...settings, height: Number(event.target.value) })} /></label>
        <label>CRF video (18–35; menor = más calidad)<input type="number" min="18" max="35" disabled={['mp3', 'flac'].includes(settings.profile)} value={settings.crf} onChange={(event) => edit(row, { ...settings, crf: Number(event.target.value) })} /></label>
        <label>Audio (kbps)<select value={settings.audioKbps} disabled={['mkv', 'flac'].includes(settings.profile)} onChange={(event) => edit(row, { ...settings, audioKbps: Number(event.target.value) })}>{[96, 128, 192, 256, 320].map((n) => <option key={n}>{n}</option>)}</select></label>
        <label className="image-destination">Archivo nuevo en <code>assets/converted/</code><input aria-label="Nombre del medio convertido" maxLength={200} value={row.name} onChange={(event) => edit(row, settings, event.target.value)} /></label>
      </fieldset>
      <aside className="image-loss-report" aria-label="Pérdidas de conversión"><h3>Pérdidas y cambios previstos</h3><ul>{(view.output?.losses ?? [...view.source.warnings,
        'El original se conserva. La salida elimina metadatos y capítulos, normaliza audio a estéreo/48 kHz y FLAC a 16 bits; puede cambiar canales, frecuencia y profundidad.',
        ...(!['mp3', 'flac'].includes(settings.profile) ? ['Video H.264 Baseline de 8 bits, YUV 4:2:0 a 30 fps: pérdida de imagen, HDR y transparencia. Cambiar dimensiones puede alterar la proporción.'] : video ? ['Se extrae solo el audio; el video no forma parte de la salida.'] : []),
        ...(['mkv', 'flac'].includes(settings.profile) ? ['FLAC no recupera calidad perdida de MP3/AAC.'] : ['Audio recodificado con pérdida.']),
        ...(['mp4', 'mov'].includes(settings.profile) ? ['Contenedor fragmentado por pipe; la compatibilidad con reproductores puede variar.'] : [])]).map((text, i) => <li key={i}>{text}</li>)}</ul></aside>
      {inProgress(view) && <progress aria-label="Progreso de conversión" max="100" {...(view.progress === null ? {} : { value: view.progress })} />}
      {view.output ? <p data-av-output>Destino: <code>{view.output.path}</code> · Tamaño calculado: {size(view.output.bytes)} · Códecs comprobados: {view.output.streams.map((stream) => stream.codec).join(' / ')}</p> : <p>El tamaño final se calcula al preparar la salida; todavía no hay una estimación fiable.</p>}
      <footer><button className="secondary" data-av-prepare disabled={busy || !allowed(row) || !row.name} onClick={() => void action(row, 'convert')}>Preparar salida</button>
        <button className="primary" data-av-save disabled={closing || view.state !== 'staged'} onClick={() => void action(row, 'save')}>Crear recurso nuevo</button></footer>
    </>}
    {row && inProgress(view) && <button className="secondary" data-av-cancel disabled={view?.state === 'saving'} onClick={() => void action(row, 'cancel')}>Cancelar trabajo</button>}
    {rows.length > 1 && <footer><button className="secondary" disabled={closing || rows.some((row) => inProgress(row.view)) || !rows.some(allowed)} onClick={() => void (async () => { for (const item of current.current.filter(allowed)) await action(item, 'convert'); })()}>Preparar lote (cola de uno)</button>
      <button className="primary" disabled={closing || saving || !rows.some((row) => row.view?.state === 'staged')} onClick={() => void (async () => { for (const item of current.current.filter((r) => r.view?.state === 'staged')) await action(item, 'save'); })()}>Confirmar salidas preparadas</button><small>Cada archivo es una transacción independiente; un lote puede tener resultados parciales y conflictos.</small></footer>}
  </dialog>;
}
