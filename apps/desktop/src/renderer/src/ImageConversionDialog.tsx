import { useEffect, useRef, useState } from 'react';
import type { ImageConversionRequest, ImageConversionSettings, ImageConversionView } from '../../shared/desktop-api';

interface Row { resourceId: string; jobId: string; view?: ImageConversionView; settings?: ImageConversionSettings; fileName: string; error?: string; }
const stateLabel = { inspected: 'Inspeccionado', converting: 'Convirtiendo…', staged: 'Salida preparada', saving: 'Confirmando…', saved: 'Recurso creado', cancelled: 'Cancelado', conflict: 'Conflicto', error: 'Error' };
const formatBytes = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

export function ImageConversionDialog({ sessionId, resourceIds, onClose, onSaved }: { sessionId: string; resourceIds: string[]; onClose(): void; onSaved(): void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([]), [selected, setSelected] = useState(0), [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), rowRef = useRef(rows); rowRef.current = rows;
  const saving = rows.some((row) => row.view?.state === 'saving'), resourceKey = resourceIds.join(',');
  function update(jobId: string, patch: Partial<Row>): void { setRows((items) => items.map((item) => item.jobId === jobId ? { ...item, ...patch } : item)); }
  async function call(request: ImageConversionRequest): Promise<ImageConversionView> {
    const result = await window.a3?.imageConversion(request);
    if (!result) throw new Error('El puente local no está disponible.');
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
    return result.value;
  }
  useEffect(() => {
    let live = true;
    const pending: Row[] = [...new Set(resourceIds)].slice(0, 16).map((resourceId) => ({ resourceId, jobId: crypto.randomUUID(), fileName: '' }));
    setRows(pending);
    const inspect = async (row: Row): Promise<void> => {
      try {
        const view = await call({ action: 'inspect', sessionId, resourceId: row.resourceId, jobId: row.jobId });
        if (!live) return;
        const base = view.sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:<>"|?*\x00-\x1f]/g, '_').slice(0, 100) || 'imagen';
        update(row.jobId, { view, fileName: `${base}-converted-${row.jobId.slice(0, 8)}.png`, settings: { format: 'png', width: view.source.width,
          height: view.source.height, quality: 85, transparency: 'preserve', background: '#ffffff', paper: 'A4', orientation: 'portrait', marginMm: 10 } });
      } catch (error) { if (live) update(row.jobId, { error: error instanceof Error ? error.message : 'No se pudo inspeccionar.' }); }
    };
    void (async () => { for (let index = 0; live && index < pending.length; index += 2) await Promise.all(pending.slice(index, index + 2).map(inspect)); })();
    return () => { live = false; for (const row of pending) void window.a3?.imageConversion({ action: 'cancel', sessionId, jobId: row.jobId }); };
  }, [sessionId, resourceKey]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function close(): Promise<void> {
    if (saving || closing) return; setClosing(true);
    await Promise.allSettled(rowRef.current.map((row) => window.a3?.imageConversion({ action: 'cancel', sessionId, jobId: row.jobId })));
    onClose();
  }
  function edit(row: Row, settings: ImageConversionSettings, fileName = row.fileName): void {
    update(row.jobId, { settings, fileName, error: undefined, ...(row.view ? { view: { ...row.view, state: 'inspected', output: undefined, message: undefined } } : {}) });
  }
  async function prepare(row: Row): Promise<void> {
    if (!row.view || !row.settings || !row.view.source.supported || ['converting', 'saving', 'saved'].includes(row.view.state)) return;
    update(row.jobId, { error: undefined, view: { ...row.view, state: 'converting' } });
    try { update(row.jobId, { view: await call({ action: 'convert', sessionId, jobId: row.jobId, settings: row.settings, destination: `assets/converted/${row.fileName}` }) }); }
    catch (error) { update(row.jobId, { error: error instanceof Error ? error.message : 'No se pudo preparar.', view: { ...row.view, state: 'error' } }); }
  }
  async function save(row: Row): Promise<void> {
    if (row.view?.state !== 'staged') return;
    update(row.jobId, { error: undefined, view: { ...row.view, state: 'saving' } });
    try {
      const view = await call({ action: 'save', sessionId, jobId: row.jobId }); update(row.jobId, { view }); if (view.state === 'saved') onSaved();
    } catch (error) { update(row.jobId, { error: error instanceof Error ? error.message : 'No se pudo guardar.', view: { ...row.view, state: 'error' } }); }
  }
  async function prepareBatch(): Promise<void> {
    const batch = rowRef.current.filter((row) => row.view && ['inspected', 'error', 'conflict'].includes(row.view.state));
    for (let index = 0; index < batch.length; index += 2) await Promise.all(batch.slice(index, index + 2).map(prepare));
  }
  const row = rows[selected], view = row?.view, settings = row?.settings;
  const busy = closing || view?.state === 'converting' || view?.state === 'saving' || view?.state === 'saved';
  const expectedWarnings = view && settings ? [
    ...view.source.warnings, 'La salida se normaliza a sRGB/8 bits, aplica la orientación EXIF y elimina los metadatos.',
    ...(['jpeg', 'avif'].includes(settings.format) ? ['La codificación es con pérdida; la calidad no recupera detalle del original.'] : []),
    ...(view.source.alpha && (['jpeg', 'pdf'].includes(settings.format) || settings.transparency === 'flatten') ? ['Se perderá transparencia sobre el fondo elegido.'] : []),
    ...(settings.width !== view.source.width || settings.height !== view.source.height ? ['Cambiar dimensiones remuestrea la imagen; revisa la proporción.'] : []),
    ...(settings.format === 'pdf' ? ['PDF de una página A3/A4 con ajuste: imagen raster sobre página blanca.'] : [])
  ] : [];
  return <dialog className="image-conversion-dialog" ref={dialog} aria-labelledby="image-conversion-title" onCancel={(event) => { event.preventDefault(); void close(); }}>
    <header><div><p className="eyebrow">Procesamiento local</p><h2 id="image-conversion-title">Convertir imágenes</h2></div><button className="secondary" autoFocus disabled={saving || closing} onClick={() => void close()}>{closing ? 'Cancelando…' : 'Cerrar / cancelar pendientes'}</button></header>
    <p>Se conserva cada original. Las salidas se preparan primero y se crean como recursos nuevos al confirmarlas.</p>
    {rows.length > 1 && <nav className="image-conversion-batch" aria-label="Archivos del lote">{rows.map((item, index) => <button className="secondary" key={item.jobId} aria-current={index === selected ? 'true' : undefined} onClick={() => setSelected(index)}>
      {item.view?.sourceName ?? `Imagen ${index + 1}`} · {item.view ? stateLabel[item.view.state] : item.error ? 'Error' : 'Inspeccionando…'}</button>)}</nav>}
    {row?.error && <p className="error" role="alert">{row.error}</p>}
    {!view && !row?.error && <p role="status">Inspeccionando firma y dimensiones reales…</p>}
    {row && view && settings && <>
      <div className="image-source-info"><strong>{view.sourceName}</strong><span>Formato real: {view.source.format.toUpperCase()} · {view.source.width} × {view.source.height} px · {formatBytes(view.source.bytes)}</span>
        <span>{view.source.alpha ? 'Canal de transparencia presente' : 'Sin transparencia'} · {view.source.pages} página(s) · profundidad {view.source.depth}</span>
        <small>Sharp {view.engine.sharp} / libvips {view.engine.vips} · PDF-lib {view.engine.pdfLib} · {view.engine.platform}</small></div>
      <fieldset disabled={busy} className="image-conversion-options"><legend>Perfil y destino</legend>
        <label>Formato<select data-image-format value={settings.format} onChange={(event) => { const format = event.target.value as ImageConversionSettings['format']; edit(row, { ...settings, format }, row.fileName.replace(/\.[^.]+$/, `.${format === 'jpeg' ? 'jpg' : format}`)); }}>
          {view.engine.profiles.map((profile) => <option key={profile.format} value={profile.format} disabled={!profile.available}>{profile.format === 'avif' ? 'AVIF (AV1)' : profile.format.toUpperCase()}{profile.available ? '' : ' · componente requerido'}</option>)}
        </select></label>
        <label>Anchura (px)<input type="number" min="1" max="16000" value={settings.width} onChange={(event) => edit(row, { ...settings, width: Number(event.target.value) })} /></label>
        <label>Altura (px)<input type="number" min="1" max="16000" value={settings.height} onChange={(event) => edit(row, { ...settings, height: Number(event.target.value) })} /></label>
        <button className="quiet" onClick={() => edit(row, { ...settings, height: Math.max(1, Math.round(settings.width * view.source.height / view.source.width)) })}>Restaurar proporción original</button>
        <label>Calidad (1–100)<input type="number" min="1" max="100" value={settings.quality} disabled={!['jpeg', 'avif'].includes(settings.format)} onChange={(event) => edit(row, { ...settings, quality: Number(event.target.value) })} /></label>
        <label>Transparencia<select value={['jpeg', 'pdf'].includes(settings.format) ? 'flatten' : settings.transparency} disabled={['jpeg', 'pdf'].includes(settings.format)} onChange={(event) => edit(row, { ...settings, transparency: event.target.value as 'preserve' | 'flatten' })}><option value="preserve">Conservar canal alpha</option><option value="flatten">Aplanar con fondo</option></select></label>
        <label>Fondo<input type="color" value={settings.background} onChange={(event) => edit(row, { ...settings, background: event.target.value })} /></label>
        {settings.format === 'pdf' && <><label>Papel<select value={settings.paper} onChange={(event) => edit(row, { ...settings, paper: event.target.value as 'A3' | 'A4' })}><option>A3</option><option>A4</option></select></label>
          <label>Orientación<select value={settings.orientation} onChange={(event) => edit(row, { ...settings, orientation: event.target.value as 'portrait' | 'landscape' })}><option value="portrait">Vertical</option><option value="landscape">Horizontal</option></select></label>
          <label>Margen (mm)<input type="number" min="0" max="50" value={settings.marginMm} onChange={(event) => edit(row, { ...settings, marginMm: Number(event.target.value) })} /></label></>}
        <label className="image-destination">Archivo nuevo en <code>assets/converted/</code><input aria-label="Nombre del archivo convertido" maxLength={200} value={row.fileName} onChange={(event) => edit(row, settings, event.target.value)} /></label>
      </fieldset>
      <aside className="image-loss-report" aria-label="Pérdidas de conversión"><h3>Pérdidas y cambios previstos</h3><ul>{(view.output?.warnings ?? expectedWarnings).map((warning, index) => <li key={index}>{warning}</li>)}</ul></aside>
      <p role="status">{stateLabel[view.state]}{view.message ? ` · ${view.message}` : ''}</p>
      {view.output ? <p data-image-output>Destino: <code>{view.output.path}</code> · Tamaño calculado: {formatBytes(view.output.bytes)} · {view.output.width} × {view.output.height} px · {view.output.alpha ? 'con alpha' : 'sin alpha'}
        {view.output.pageWidth ? ` · página ${view.output.pageWidth.toFixed(2)} × ${view.output.pageHeight!.toFixed(2)} pt` : ''}</p> : <p>El tamaño final se calcula al preparar la salida; todavía no hay una estimación fiable.</p>}
      <footer><button className="secondary" data-image-prepare disabled={busy || !view.source.supported || !view.engine.profiles.find((profile) => profile.format === settings.format)?.available || !row.fileName} onClick={() => void prepare(row)}>Preparar salida</button>
        <button className="primary" data-image-save disabled={view.state !== 'staged' || closing} onClick={() => void save(row)}>Crear recurso nuevo</button></footer>
    </>}
    {rows.length > 1 && <footer><button className="secondary" disabled={closing || rows.some((row) => row.view && ['converting', 'saving'].includes(row.view.state))} onClick={() => void prepareBatch()}>Preparar lote (hasta 2 en paralelo)</button>
      <button className="primary" disabled={closing || saving || !rows.some((row) => row.view?.state === 'staged')} onClick={() => void (async () => { for (const row of rowRef.current) await save(row); })()}>Confirmar salidas preparadas</button><small>Cada archivo se confirma por separado; un lote puede tener éxitos y conflictos.</small></footer>}
  </dialog>;
}
