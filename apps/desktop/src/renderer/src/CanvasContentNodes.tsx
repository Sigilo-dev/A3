import type { CanvasEntitySummary, CanvasResourcePreview } from '../../shared/desktop-api';

function textProperty(entity: CanvasEntitySummary, key: string): string {
  const value = entity.properties[key];
  return typeof value === 'string' ? value : '';
}

function DrawingAssetPreview({ source }: { source: string }): React.JSX.Element {
  try {
    const asset = JSON.parse(source) as { strokes?: { points?: { x: number; y: number }[]; parameters?: { size?: number }; style?: Record<string, unknown> }[] };
    if (!Array.isArray(asset.strokes) || asset.strokes.length > 256) throw new Error('invalid');
    const strokes = asset.strokes.filter((stroke) => Array.isArray(stroke.points) && stroke.points.length >= 2 && stroke.points.length <= 10000 &&
      stroke.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    if (!strokes.length) return <p className="canvas-content-state">Dibujo vectorial vacío</p>;
    const points = strokes.flatMap((stroke) => stroke.points!);
    const minX = Math.min(...points.map((point) => point.x)), minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x)), maxY = Math.max(...points.map((point) => point.y));
    const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
    return <svg className="canvas-drawing-asset-preview" viewBox={`${minX} ${minY} ${width} ${height}`} role="img" aria-label={`${strokes.length} trazos vectoriales`}>
      {strokes.map((stroke, index) => <polyline key={index} points={stroke.points!.map((point) => `${point.x},${point.y}`).join(' ')} fill="none"
        stroke={typeof stroke.style?.['a3.ui.stroke.color'] === 'string' && /^#[\da-f]{6}$/i.test(stroke.style['a3.ui.stroke.color'] as string) ? stroke.style['a3.ui.stroke.color'] as string : '#c3ed82'}
        strokeWidth={Number.isFinite(stroke.parameters?.size) ? Math.min(32, Math.max(0.5, stroke.parameters!.size!)) : 4} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>;
  } catch { return <p className="canvas-content-state">Fuente de dibujo no interpretable; los bytes originales se conservan.</p>; }
}

export function CanvasContentBody({ entity, preview, mediaUrl, activatePlayback, playbackBusy, playbackError, onOpenMarkdown }: {
  entity: CanvasEntitySummary; preview: CanvasResourcePreview | null; mediaUrl: string | null;
  activatePlayback: () => void; playbackBusy: boolean; playbackError: string | null; onOpenMarkdown?: () => void;
}): React.JSX.Element {
  const resource = entity.contentResource;
  const description = textProperty(entity, 'a3.content.description');
  const altText = textProperty(entity, 'a3.content.alt-text');
  const language = textProperty(entity, 'a3.content.language');
  const title = entity.title || entity.type;
  const unavailable = !resource ? 'Falta el descriptor del recurso; el contenido se conserva para reparación.' :
    preview?.state === 'unavailable' ? 'Recurso no disponible o sin permiso. El descriptor se conserva.' :
    preview?.state === 'too-large' ? 'El recurso supera el límite seguro de vista previa; el original permanece intacto.' : '';
  const text = preview?.state === 'ready' ? preview.text : null;
  const video = entity.type === 'a3.content.video';
  const audio = entity.type === 'a3.content.audio';
  const image = entity.type === 'a3.content.image';
  const youtube = entity.type === 'a3.content.youtube';
  const webLink = entity.type === 'a3.content.web-link';
  const file = entity.type === 'a3.content.file';
  const markdown = entity.type === 'a3.core.page' || entity.type === 'a3.content.markdown';
  const shortText = entity.type === 'a3.content.short-text';
  const code = entity.type === 'a3.content.code';
  const drawing = entity.type === 'a3.core.drawing';

  if (image) return <section className="canvas-content-card" data-content-renderer="image" aria-label={`Imagen ${title}`}>
    {mediaUrl ? <img className="canvas-image-preview" src={mediaUrl} alt={altText || title} /> : <div className="canvas-media-placeholder" aria-hidden="true">▧</div>}
    <strong>{title}</strong>{resource && <small>{resource.label} · {resource.mediaType ?? 'tipo de imagen sin determinar'}</small>}
    {description && <p>{description}</p>}{unavailable && <p className="canvas-content-state">{unavailable}</p>}
    {resource?.kind === 'remote-url' && <p className="canvas-content-state">Imagen remota guardada como referencia. A3 no descarga la URL automáticamente.</p>}
    {preview?.state === 'too-large' && <p className="canvas-content-state">La vista previa supera 4 MiB.</p>}
  </section>;
  if (video || audio) return <section className="canvas-content-card" data-content-renderer={video ? 'video' : 'audio'} aria-label={`${video ? 'Video' : 'Audio'} ${title}`}>
    <div className="canvas-media-placeholder" aria-hidden="true">{video ? '▶' : '♫'}</div><strong>{title}</strong>
    {resource && <small>{resource.label} · {resource.mediaType ?? (video ? 'video' : 'audio')}</small>}
    {description && <p>{description}</p>}
    {resource?.kind === 'remote-url' ? <p className="canvas-content-state">Referencia remota conservada; A3 no inicia conexiones de red automáticamente.</p> : <>
      {mediaUrl ? video ? <video className="canvas-media-player" src={mediaUrl} controls preload="none" aria-label={`Reproducir ${title}`} /> :
        <audio className="canvas-media-player" src={mediaUrl} controls preload="none" aria-label={`Reproducir ${title}`} /> :
        <button className="quiet" data-content-play onClick={activatePlayback} disabled={playbackBusy || !resource}>{playbackBusy ? 'Preparando…' : 'Activar reproductor'}</button>}
      {playbackError && <p className="canvas-content-state" role="status">{playbackError}</p>}{unavailable && <p className="canvas-content-state">{unavailable}</p>}
    </>}
  </section>;
  if (youtube) return <section className="canvas-content-card" data-content-renderer="youtube" aria-label={`Referencia de YouTube ${title}`}>
    <div className="canvas-media-placeholder" aria-hidden="true">▶</div><strong>{title}</strong>
    {resource?.url && <code className="canvas-content-url">{resource.url}</code>}
    {description && <p>{description}</p>}
    <p className="canvas-content-state">URL guardada sin descarga de miniatura. La reproducción remota requiere permiso de red, no disponible en esta versión.</p>
  </section>;
  if (webLink) return <section className="canvas-content-card" data-content-renderer="web-link" aria-label={`Enlace web ${title}`}>
    <strong>{title}</strong>{resource?.url && <code className="canvas-content-url">{resource.url}</code>}
    {description && <p>{description}</p>}<p className="canvas-content-state">La página no se consulta automáticamente.</p>
  </section>;
  if (file) return <section className="canvas-content-card" data-content-renderer="file" aria-label={`Archivo ${title}`}>
    <div className="canvas-media-placeholder" aria-hidden="true">▤</div><strong>{title}</strong>
    {resource && <small>{resource.label} · {resource.mediaType ?? 'MIME desconocido'}</small>}
    {resource?.kind === 'remote-url' && <><code className="canvas-content-url">{resource.url}</code><p className="canvas-content-state">Referencia URL conservada; A3 no consulta ni descarga el recurso automáticamente.</p></>}
    {unavailable && <p className="canvas-content-state">{unavailable}</p>}
  </section>;
  if (markdown || shortText || code || drawing) return <section className="canvas-content-card" data-content-renderer={drawing ? 'drawing' : code ? 'code' : shortText ? 'short-text' : 'markdown'}>
    <div className="canvas-content-heading"><strong>{title}</strong>{code && language && <small>{language}</small>}</div>
    {description && <p>{description}</p>}
    {text !== null ? drawing ? <DrawingAssetPreview source={text} /> : <pre className={`canvas-content-preview${code ? ' is-code' : ''}`}>{text.slice(0, markdown ? 1800 : 1400)}</pre> :
      <p className="canvas-content-state">{unavailable || (preview?.state === 'too-large' ? 'Contenido extenso; el original está intacto.' : preview?.state === 'binary' ? 'El recurso no es texto UTF-8.' :
        resource?.kind === 'remote-url' ? 'Referencia URL conservada; el origen no se consulta automáticamente.' : 'Vista previa disponible cuando el nodo está visible.')}</p>}
    {resource && <small className="canvas-resource-label">{resource.label}</small>}
    {markdown && <><small>Markdown · vista de lectura</small>{onOpenMarkdown && <button className="quiet canvas-markdown-open" data-open-markdown={entity.id} onClick={onOpenMarkdown}>Abrir editor visual</button>}</>}
    {shortText && <><small>Texto breve · fuente Markdown</small>{onOpenMarkdown && <button className="quiet canvas-markdown-open" data-open-markdown={entity.id} onClick={onOpenMarkdown}>Abrir editor visual</button>}</>}
    {drawing && <small>Dibujo vectorial · la fuente canónica se conserva en el recurso</small>}
  </section>;
  return <section className="canvas-content-card" data-content-renderer="fallback">
    <strong>Vista genérica del contenido</strong>
    {text !== null ? <pre className="canvas-content-preview">{text.slice(0, 1200)}</pre> : <p className="canvas-content-state">{unavailable || (resource?.kind === 'remote-url'
      ? 'Referencia URL conservada; A3 no la consulta automáticamente.'
      : 'Vista previa disponible cuando el nodo está visible; entidad, propiedades, puertos y conexiones se conservan.')}</p>}
    {resource?.url && <code className="canvas-content-url">{resource.url}</code>}
    {resource && <small>{resource.label} · {resource.mediaType ?? 'MIME desconocido'}</small>}
  </section>;
}
