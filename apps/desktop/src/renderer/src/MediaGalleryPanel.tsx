import { useEffect, useMemo, useState } from 'react';
import type { LocalProjectSession, MediaGalleryCatalog, MediaGalleryItem, MediaGalleryPreview, MediaGalleryRepresentation } from '../../shared/desktop-api';
import { filterMediaGalleryItems } from '@a3/project-store/media-gallery';
import { screenToWorld } from '../../shared/world-viewport';
import { ImageConversionDialog } from './ImageConversionDialog';
import { AvConversionDialog } from './AvConversionDialog';

type GalleryProject = Pick<LocalProjectSession, 'sessionId' | 'projectId' | 'name'>;
interface Props { project: GalleryProject | null; onOpenWorkspace(workspaceId: string): Promise<void>; onShowPlacement(workspaceId: string, placementId: string): Promise<void>; }
function stateLabel(item: MediaGalleryItem): string {
  switch (item.availability) {
    case 'remote': return 'Referencia web';
    case 'approval-required': return 'Montaje sin aprobar';
    case 'permission-denied': return 'Indexación o lectura denegada';
    case 'missing': return 'Montaje ausente';
    case 'changed': return 'Montaje cambiado';
    case 'unavailable': return 'No disponible';
    default: return item.resourceKind === 'mounted-file' ? 'Montaje aprobado' : 'En el proyecto';
  }
}

export function MediaGalleryPanel({ project, onOpenWorkspace, onShowPlacement }: Props): React.JSX.Element {
  const [catalog, setCatalog] = useState<MediaGalleryCatalog | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  const [workspaceFilter, setWorkspaceFilter] = useState(''), [groupFilter, setGroupFilter] = useState('');
  const [collectionFilter, setCollectionFilter] = useState(''), [tagFilter, setTagFilter] = useState(''), [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all');
  const [selected, setSelected] = useState<MediaGalleryItem | null>(null), [preview, setPreview] = useState<MediaGalleryPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false), [imageUrl, setImageUrl] = useState<string | null>(null), [targetWorkspace, setTargetWorkspace] = useState('');
  const [actionBusy, setActionBusy] = useState(false), [actionMessage, setActionMessage] = useState<string | null>(null);
  const [conversionIds, setConversionIds] = useState<string[]>([]), [batchIds, setBatchIds] = useState<string[]>([]);
  const [avIds, setAvIds] = useState<string[]>([]), [avBatch, setAvBatch] = useState<string[]>([]);
  useEffect(() => { setAvIds([]); setAvBatch([]); }, [project?.sessionId]);

  useEffect(() => {
    let live = true;
    setCatalog(null); setError(null);
    if (!project) return () => { live = false; };
    setLoading(true);
    void window.a3?.gallery({ action: 'load', sessionId: project.sessionId }).then((result) => {
      if (!live) return;
      if (!result.ok) { setError(`${result.error.message} ${result.error.recovery}`); return; }
      if (!('items' in result.value)) { setError('La respuesta del catálogo no tiene el formato esperado.'); return; }
      setCatalog(result.value); setTargetWorkspace(result.value.workspaces[0]?.id ?? '');
    }).catch(() => { if (live) setError('No se pudo cargar el catálogo de medios del proyecto.'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [project?.sessionId, refresh]);

  useEffect(() => {
    if (!preview?.bytes) { setImageUrl(null); return; }
    const url = URL.createObjectURL(new Blob([preview.bytes as BlobPart], { type: preview.mediaType ?? 'application/octet-stream' }));
    setImageUrl(url); return () => URL.revokeObjectURL(url);
  }, [preview?.bytes, preview?.mediaType]);

  const visibleItems = useMemo(() => catalog ? filterMediaGalleryItems(catalog.items, {
    ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}), ...(groupFilter ? { groupId: groupFilter } : {}),
    ...(collectionFilter ? { collectionId: collectionFilter } : {}), ...(tagFilter ? { tag: tagFilter } : {}), ...(kindFilter !== 'all' ? { kind: kindFilter } : {})
  }) : [], [catalog, kindFilter, workspaceFilter, groupFilter, collectionFilter, tagFilter]);

  async function openPreview(item: MediaGalleryItem): Promise<void> {
    setSelected(item); setPreview(null); setActionMessage(null); setPreviewLoading(true);
    if (item.kind === 'video' || item.availability === 'remote') { setPreviewLoading(false); return; }
    try {
      const result = await window.a3?.gallery({ action: 'preview', sessionId: project!.sessionId, resourceId: item.resourceId });
      if (!result) throw new Error('El puente local no está disponible.');
      if (!result.ok) throw new Error(`${result.error.message} ${result.error.recovery}`);
      if ('state' in result.value) setPreview(result.value);
      else throw new Error('El host devolvió un catálogo en lugar del preview solicitado.');
    } catch (cause) { setActionMessage(cause instanceof Error ? cause.message : 'No se pudo abrir el preview.'); }
    finally { setPreviewLoading(false); }
  }

  async function playVideo(item: MediaGalleryItem): Promise<void> {
    if (!project) return;
    setPreviewLoading(true); setActionMessage(null);
    try {
      const result = await window.a3?.gallery({ action: 'preview', sessionId: project.sessionId, resourceId: item.resourceId, purpose: 'playback' });
      if (!result) throw new Error('El puente local no está disponible.');
      if (!result.ok) throw new Error(`${result.error.message} ${result.error.recovery}`);
      if ('state' in result.value) setPreview(result.value);
      else throw new Error('El host devolvió un catálogo en lugar del medio.');
    } catch (cause) { setActionMessage(cause instanceof Error ? cause.message : 'No se pudo abrir el video.'); }
    finally { setPreviewLoading(false); }
  }

  async function showRepresentation(item: MediaGalleryItem, representation?: MediaGalleryRepresentation): Promise<void> {
    if (!project || !catalog) return;
    const workspaceId = representation?.workspaceId ?? targetWorkspace;
    const workspace = catalog.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) { setActionMessage('Selecciona un workspace disponible.'); return; }
    if (!workspace.canWrite && (!representation?.placementId)) { setActionMessage('Este workspace está en solo lectura o el broker denegó diagram.edit.'); return; }
    setActionBusy(true); setActionMessage(null);
    try {
      if (representation?.placementId) { await onShowPlacement(workspaceId, representation.placementId); return; }
      const opened = await window.a3?.canvas({ action: 'load', sessionId: project.sessionId, workspaceId });
      if (!opened?.ok) throw new Error(opened && !opened.ok ? opened.error.message : 'El puente local no está disponible.');
      const position = screenToWorld({ x: 360 + workspace.placementCount * 28, y: 240 + workspace.placementCount * 20 }, workspace.viewport);
      let changed;
      if (representation) changed = await window.a3?.canvas({ action: 'create-placement', sessionId: project.sessionId, workspaceId,
        expectedWorkspaceRevision: opened.value.revision, entityId: representation.entityId, position });
      else {
        const kind = item.url ? (item.mediaType === 'video/x-a3-youtube' ? 'youtube' : item.kind === 'image' ? 'image' : 'web-link') : item.kind;
        changed = await window.a3?.canvas({ action: 'create-content-node', sessionId: project.sessionId, workspaceId,
          expectedWorkspaceRevision: opened.value.revision, node: { kind, title: item.label, position, ...(item.url ? { url: item.url } : { resourceId: item.resourceId }) } });
      }
      if (!changed?.ok) throw new Error(changed && !changed.ok ? `${changed.error.message} ${changed.error.recovery}` : 'El puente local no está disponible.');
      const placement = changed.value.placements.find((item) => !opened.value.placements.some((before) => before.id === item.id));
      if (placement) await onShowPlacement(workspaceId, placement.id); else await onOpenWorkspace(workspaceId);
      setSelected(null);
    } catch (cause) { setActionMessage(cause instanceof Error ? cause.message : 'No se pudo mostrar el medio en el lienzo.'); }
    finally { setActionBusy(false); }
  }

  const groupLabel = (id: string): string => {
    const group = catalog?.groups.find((item) => item.id === id);
    return group ? `${group.workspaceName} · ${group.name}` : 'Grupo';
  };
  const renderCards = (items: readonly MediaGalleryItem[], kind: 'image' | 'video'): React.JSX.Element => <div className="gallery-grid">
    {items.filter((item) => item.kind === kind).map((item) => <article className="gallery-card" key={item.resourceId} data-media-kind={item.kind} data-gallery-resource-id={item.resourceId}>
      {kind === 'image' && item.resourceKind !== 'remote-url' && <label className="gallery-batch-choice"><input type="checkbox" aria-label={`Seleccionar ${item.label} para convertir`} checked={batchIds.includes(item.resourceId)} disabled={!batchIds.includes(item.resourceId) && batchIds.length >= 16}
        onChange={(event) => setBatchIds((before) => event.target.checked ? [...before, item.resourceId] : before.filter((id) => id !== item.resourceId))} /> Seleccionar</label>}
      {kind === 'video' && item.resourceKind && item.resourceKind !== 'remote-url' && <label className="gallery-batch-choice"><input type="checkbox" aria-label={`Seleccionar ${item.label} para convertir audio/video`} checked={avBatch.includes(item.resourceId)} disabled={!avBatch.includes(item.resourceId) && avBatch.length >= 16}
        onChange={(event) => setAvBatch((before) => event.target.checked ? [...before, item.resourceId] : before.filter((id) => id !== item.resourceId))} /> Seleccionar audio/video</label>}
      <button className="gallery-card-preview" onClick={() => void openPreview(item)} aria-label={`Abrir preview de ${item.label}`}>
        {item.kind === 'image' ? <span className="gallery-icon" aria-hidden="true">▧</span> : <span className="gallery-icon gallery-video-icon" aria-hidden="true">▶</span>}
        <span className="gallery-card-title">{item.label}</span>
      </button>
      <div className="gallery-card-meta"><span>{stateLabel(item)}</span><span>{item.representations.length} {item.representations.length === 1 ? 'representación' : 'representaciones'}</span></div>
      {item.representations.length > 0 && <div className="gallery-card-representations">
        {item.representations.slice(0, 3).map((rep, index) => <span key={`${rep.entityId}:${rep.placementId ?? 'unplaced'}:${index}`}>{rep.title}{rep.workspaceName ? ` · ${rep.workspaceName}` : ' · Sin placement'}
          {rep.groupIds.length > 0 ? ` · ${rep.groupIds.map(groupLabel).join(', ')}` : ''}</span>)}
        {item.representations.length > 3 && <span>y {item.representations.length - 3} más</span>}
      </div>}
      <button className="secondary gallery-show-button" onClick={() => void openPreview(item)}>Preview y ubicación…</button>
    </article>)}
  </div>;

  return <section className="media-gallery" aria-labelledby="gallery-title">
    <div className="gallery-heading"><div><p className="eyebrow">Catálogo de recursos</p><h1 id="gallery-title">Galería</h1><p>{project ? `Proyecto actual: ${catalog?.projectName ?? project.name}` : 'Abre un proyecto para consultar sus recursos.'}</p></div>
      <button className="secondary" disabled={!project || loading} onClick={() => setRefresh((value) => value + 1)}>Actualizar</button></div>
    {project && batchIds.length > 0 && <button className="secondary" onClick={() => setConversionIds(batchIds)}>Convertir selección ({batchIds.length})…</button>}
    {project && avBatch.length > 0 && <button className="secondary" onClick={() => setAvIds(avBatch)}>Convertir selección audio/video ({avBatch.length})…</button>}
    {project && <div className="gallery-filters" aria-label="Filtros de la galería">
      <label>Proyecto<select aria-label="Proyecto" value={catalog?.projectId ?? project.projectId} disabled><option value={catalog?.projectId ?? project.projectId}>{catalog?.projectName ?? project.name} · abierto</option></select></label>
      <label>Workspace<select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}><option value="">Todos</option>{catalog?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
      <label>Grupo<select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="">Todos</option>{catalog?.groups.map((group) => <option key={`${group.workspaceId}:${group.id}`} value={group.id}>{group.workspaceName} · {group.name}</option>)}</select></label>
      <label>Colección<select value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">Todas</option>{catalog?.collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label>
      <label>Etiqueta<select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Todas</option>{catalog?.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
      <label>Tipo<select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as 'all' | 'image' | 'video')}><option value="all">Todos</option><option value="image">Imágenes</option><option value="video">Videos</option></select></label>
    </div>}
    {!project && <p className="gallery-empty">Abre un proyecto desde Inicio. La galería usa únicamente su catálogo local.</p>}
    {project && loading && <p role="status">Leyendo catálogo…</p>}
    {error && <div className="error" role="alert"><p>{error}</p><button onClick={() => setRefresh((value) => value + 1)}>Reintentar</button></div>}
    {project && !loading && !error && <>
      <section className="gallery-category" aria-labelledby="gallery-images-title"><h2 id="gallery-images-title">Imágenes <span>{visibleItems.filter((item) => item.kind === 'image').length}</span></h2>
        {renderCards(visibleItems, 'image')}{visibleItems.every((item) => item.kind !== 'image') && <p className="gallery-empty">No hay imágenes que coincidan con los filtros.</p>}
      </section>
      <section className="gallery-category" aria-labelledby="gallery-videos-title"><h2 id="gallery-videos-title">Videos <span>{visibleItems.filter((item) => item.kind === 'video').length}</span></h2>
        {renderCards(visibleItems, 'video')}{visibleItems.every((item) => item.kind !== 'video') && <p className="gallery-empty">No hay videos que coincidan con los filtros.</p>}
      </section>
    </>}
    {selected && <div className="gallery-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="gallery-dialog" role="dialog" aria-modal="true" aria-labelledby="gallery-preview-title">
        <header><div><p className="eyebrow">{selected.kind === 'image' ? 'Imagen' : 'Video'}</p><h2 id="gallery-preview-title">{selected.label}</h2></div>
          <button className="secondary" onClick={() => setSelected(null)} aria-label="Cerrar preview">Cerrar</button></header>
        {selected.kind === 'image' && selected.resourceKind && selected.resourceKind !== 'remote-url' && <button className="secondary" data-gallery-convert onClick={() => { setConversionIds([selected.resourceId]); setSelected(null); }}>Convertir imagen…</button>}
        {selected.kind === 'video' && selected.resourceKind && selected.resourceKind !== 'remote-url' && <button className="secondary" data-gallery-convert-av onClick={() => { setAvIds([selected.resourceId]); setSelected(null); }}>Convertir audio/video…</button>}
        {previewLoading ? <p role="status">Preparando preview…</p> : imageUrl && selected.kind === 'image' ? <img className="gallery-large-preview" src={imageUrl} alt={selected.label} /> :
          imageUrl && selected.kind === 'video' ? <video className="gallery-large-preview" src={imageUrl} controls autoPlay playsInline aria-label={`Reproducción de ${selected.label}`} /> :
          <div className="gallery-preview-placeholder"><span aria-hidden="true">{selected.kind === 'image' ? '▧' : '▶'}</span>
            <p>{selected.kind === 'video' ? 'El poster del video aún no está disponible. El archivo original se conserva y no se carga automáticamente.' :
              selected.availability === 'remote' ? 'La referencia web se muestra sin descargar su contenido.' : preview?.state === 'too-large' ? 'La imagen supera el límite local de preview.' : preview?.state === 'unavailable' ? 'El recurso no está disponible o falta permiso de lectura.' : 'No hay una miniatura para este recurso.'}</p>
            {selected.url && <code>{selected.url}</code>}
            {selected.kind === 'video' && selected.resourceKind !== 'remote-url' && <button className="primary" disabled={previewLoading || selected.availability !== 'available' && selected.resourceKind === 'mounted-file'} onClick={() => void playVideo(selected)}>Reproducir recurso local</button>}
          </div>}
        <div className="gallery-location"><h3>Representaciones y ubicación</h3>
          {selected.representations.map((rep, index) => <div className="gallery-location-row" key={`${rep.entityId}:${rep.placementId ?? 'unplaced'}:${index}`}>
            <span>{rep.title}{rep.workspaceName ? ` · ${rep.workspaceName}` : ' · Sin placement'}{rep.groupIds.length ? ` · ${rep.groupIds.map(groupLabel).join(', ')}` : ''}</span>
            <button className="secondary" disabled={actionBusy || !catalog?.workspaces.find((workspace) => workspace.id === rep.workspaceId)?.canWrite && !rep.placementId}
              onClick={() => void showRepresentation(selected, rep)}>{rep.placementId ? 'Mostrar en lienzo' : 'Añadir placement'}</button>
          </div>)}
          {(!selected.representations.length || selected.representations.every((rep) => !rep.placementId)) && <div className="gallery-add-location">
            <label>Ubicación<select aria-label="Workspace destino" value={targetWorkspace} onChange={(event) => setTargetWorkspace(event.target.value)}>
              {catalog?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id} disabled={!workspace.canWrite}>{workspace.name}{workspace.canWrite ? '' : ' · solo lectura'}</option>)}
            </select></label>
            <button className="primary" disabled={actionBusy || !catalog?.workspaces.find((workspace) => workspace.id === targetWorkspace)?.canWrite}
              onClick={() => void showRepresentation(selected, selected.representations[0])}>{actionBusy ? 'Añadiendo…' : 'Mostrar en lienzo'}</button>
          </div>}
        </div>
        {actionMessage && <p role="status" className="gallery-action-message">{actionMessage}</p>}
      </section>
    </div>}
    {project && conversionIds.length > 0 && <ImageConversionDialog sessionId={project.sessionId} resourceIds={conversionIds}
      onClose={() => setConversionIds([])} onSaved={() => { setBatchIds([]); setRefresh((value) => value + 1); }} />}
    {project && avIds.length > 0 && <AvConversionDialog key={project.sessionId} sessionId={project.sessionId} resourceIds={avIds}
      onClose={() => setAvIds([])} onSaved={() => { setAvBatch([]); setRefresh((value) => value + 1); }} />}
  </section>;
}
