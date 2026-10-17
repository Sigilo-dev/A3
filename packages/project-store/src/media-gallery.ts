import type { DomainRecord, Entity, Resource } from '@a3/domain';

export type MediaGalleryKind = 'image' | 'video';
export type MediaGalleryAvailability = 'available' | 'remote' | 'approval-required' | 'permission-denied' | 'missing' | 'changed' | 'unavailable';
export interface MediaGalleryWorkspace { id: string; name: string; revision: number; viewport: { x: number; y: number; zoom: number }; canWrite: boolean; placementCount: number; }
export interface MediaGalleryGroup { id: string; workspaceId: string; workspaceName: string; name: string; }
export interface MediaGalleryCollection { id: string; name: string; }
export interface MediaGalleryRepresentation {
  entityId: string; title: string; type: string; tags: readonly string[]; collectionIds: readonly string[];
  placementId?: string; workspaceId?: string; workspaceName?: string; groupIds: readonly string[];
}
export interface MediaGalleryItem {
  resourceId: string; kind: MediaGalleryKind; mediaType?: string; resourceKind?: Resource['kind']; label: string; url?: string;
  availability: MediaGalleryAvailability; representations: readonly MediaGalleryRepresentation[];
}
export interface MediaGalleryCatalog {
  projectId: string; projectName: string; workspaces: readonly MediaGalleryWorkspace[]; groups: readonly MediaGalleryGroup[];
  collections: readonly MediaGalleryCollection[]; tags: readonly string[]; items: readonly MediaGalleryItem[];
}
export interface MediaGalleryFilters { workspaceId?: string; groupId?: string; collectionId?: string; tag?: string; kind?: MediaGalleryKind; }

type AvailabilityMap = Readonly<Record<string, MediaGalleryAvailability>>;
const imageType = 'a3.content.image';
const videoTypes = new Set(['a3.content.video', 'a3.content.youtube']);

function extensionMediaType(path: string): string | undefined {
  const extension = path.split(/[\\/]/).at(-1)?.toLowerCase().split('.').at(-1);
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/x-m4v', ogv: 'video/ogg' } as Record<string, string>)[extension ?? ''];
}
function remoteMediaType(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.hostname === 'youtu.be' || parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) return 'video/x-a3-youtube';
    return extensionMediaType(parsed.pathname);
  } catch { return undefined; }
}
function resourceMediaType(resource: Resource): string | undefined {
  if (resource.kind === 'remote-url') {
    const inferred = remoteMediaType(resource.url);
    return !resource.mediaType || resource.mediaType === 'text/uri-list' ? inferred ?? resource.mediaType : resource.mediaType;
  }
  return resource.mediaType ?? extensionMediaType(resource.path);
}
function mediaKind(entity: Entity | undefined, resource: Resource | undefined): MediaGalleryKind | undefined {
  if (entity?.type === imageType) return 'image';
  if (entity && videoTypes.has(entity.type)) return 'video';
  const mediaType = resource ? resourceMediaType(resource) : undefined;
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType?.startsWith('video/')) return 'video';
  return undefined;
}
export function mediaGalleryKind(entities: readonly Entity[], resource?: Resource): MediaGalleryKind | undefined {
  for (const entity of entities) { const kind = mediaKind(entity, resource); if (kind) return kind; }
  return mediaKind(undefined, resource);
}
function resourceLabel(resource: Resource): string {
  if (resource.kind === 'remote-url') {
    try { const url = new URL(resource.url); return url.hostname === 'youtu.be' || url.hostname.endsWith('youtube.com') ? 'YouTube' : url.hostname; }
    catch { return 'Referencia web'; }
  }
  return resource.path.split(/[\\/]/).at(-1) || 'Medio sin nombre';
}

/** Builds a transient gallery view from project records; resource IDs are the deduplication key. */
export function buildMediaGalleryCatalog(input: { projectId: string; projectName: string; records: readonly DomainRecord[]; availability?: AvailabilityMap }): MediaGalleryCatalog {
  const workspaces = input.records.filter((record): record is Extract<DomainRecord, { kind: 'workspace' }> => record.kind === 'workspace')
    .map(({ value }) => ({ id: value.id, name: value.name, revision: value.revision, viewport: value.viewport, canWrite: false,
      placementCount: input.records.filter((item) => item.kind === 'placement' && item.workspaceId.toLowerCase() === value.id.toLowerCase()).length }));
  const workspaceById = new Map(workspaces.map((item) => [item.id.toLowerCase(), item]));
  const collectionRecords = input.records.filter((record): record is Extract<DomainRecord, { kind: 'collection' }> => record.kind === 'collection');
  const collections = collectionRecords.map(({ value }) => ({ id: value.id, name: value.name }));
  const collectionByEntity = new Map<string, string[]>();
  for (const { value } of collectionRecords) for (const entityId of value.entityIds) {
    const key = entityId.toLowerCase(), ids = collectionByEntity.get(key) ?? []; ids.push(value.id); collectionByEntity.set(key, ids);
  }
  const entities = input.records.filter((record): record is Extract<DomainRecord, { kind: 'entity' }> => record.kind === 'entity').map(({ value }) => value);
  const entityById = new Map(entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const resources = input.records.filter((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource').map(({ value }) => value);
  const resourceById = new Map(resources.map((resource) => [resource.id.toLowerCase(), resource]));
  const placements = input.records.filter((record): record is Extract<DomainRecord, { kind: 'placement' }> => record.kind === 'placement');
  const groupRecords = input.records.filter((record): record is Extract<DomainRecord, { kind: 'group' }> => record.kind === 'group');
  const groupByKey = new Map(groupRecords.map((record) => [`${record.workspaceId.toLowerCase()}:${record.value.id.toLowerCase()}`, record]));
  const groups = groupRecords.map((record) => ({ id: record.value.id, workspaceId: record.workspaceId,
    workspaceName: workspaceById.get(record.workspaceId.toLowerCase())?.name ?? 'Workspace ausente', name: record.value.name }));
  const groupIdsByPlacement = new Map<string, Set<string>>();
  for (const group of groupRecords) {
    const key = `${group.workspaceId.toLowerCase()}:${group.value.id.toLowerCase()}`, found = new Set<string>(), visited = new Set<string>();
    const visit = (groupKey: string): void => {
      if (visited.has(groupKey)) return; visited.add(groupKey);
      const current = groupByKey.get(groupKey); if (!current) return;
      for (const member of current.value.members) {
        if (member.kind === 'placement') found.add(member.id.toLowerCase());
        else if (member.kind === 'group') visit(`${group.workspaceId.toLowerCase()}:${member.id.toLowerCase()}`);
      }
    };
    visit(key);
    for (const placementId of found) { const ids = groupIdsByPlacement.get(placementId) ?? new Set<string>(); ids.add(group.value.id); groupIdsByPlacement.set(placementId, ids); }
  }
  const placementsByEntity = new Map<string, typeof placements>();
  for (const placement of placements) { const key = placement.value.entityId.toLowerCase(), list = placementsByEntity.get(key) ?? []; list.push(placement); placementsByEntity.set(key, list); }
  const representationsByResource = new Map<string, MediaGalleryRepresentation[]>();
  const addRepresentation = (entity: Entity, resourceId: string, placement?: (typeof placements)[number]): void => {
    const key = resourceId.toLowerCase(), list = representationsByResource.get(key) ?? [];
    const workspace = placement ? workspaceById.get(placement.workspaceId.toLowerCase()) : undefined;
    list.push({ entityId: entity.id, title: entity.title, type: entity.type, tags: [...entity.tags], collectionIds: [...(collectionByEntity.get(entity.id.toLowerCase()) ?? [])],
      ...(placement ? { placementId: placement.value.id, workspaceId: placement.workspaceId, workspaceName: workspace?.name ?? 'Workspace ausente' } : {}),
      groupIds: placement ? [...(groupIdsByPlacement.get(placement.value.id.toLowerCase()) ?? [])] : [] });
    representationsByResource.set(key, list);
  };
  for (const entity of entities) if (entity.contentResourceId && mediaKind(entity, resourceById.get(entity.contentResourceId.toLowerCase()))) {
    const placementsForEntity = placementsByEntity.get(entity.id.toLowerCase()) ?? [];
    if (placementsForEntity.length) for (const placement of placementsForEntity) addRepresentation(entity, entity.contentResourceId, placement);
    else addRepresentation(entity, entity.contentResourceId);
  }
  const itemKinds = new Map<string, MediaGalleryKind>();
  for (const resource of resources) {
    const kind = mediaKind(undefined, resource);
    if (kind) itemKinds.set(resource.id.toLowerCase(), kind);
  }
  for (const entity of entities) if (entity.contentResourceId) {
    const key = entity.contentResourceId.toLowerCase(), kind = mediaKind(entity, resourceById.get(key));
    if (kind && !itemKinds.has(key)) itemKinds.set(key, kind);
  }
  const items: MediaGalleryItem[] = [];
  for (const [key, kind] of itemKinds) {
    const resource = resourceById.get(key), reps = representationsByResource.get(key) ?? [];
    const entity = reps.length ? entityById.get(reps[0]!.entityId.toLowerCase()) : undefined;
    const mediaType = resource ? resourceMediaType(resource) : undefined;
    const url = resource?.kind === 'remote-url' ? resource.url : undefined;
    items.push({ resourceId: resource?.id ?? key, kind, ...(mediaType ? { mediaType } : {}), ...(resource ? { resourceKind: resource.kind } : {}),
      label: resource ? resourceLabel(resource) : entity?.title ?? 'Recurso multimedia ausente', ...(url ? { url } : {}),
      availability: input.availability?.[key] ?? (resource?.kind === 'remote-url' ? 'remote' : resource ? 'available' : 'missing'),
      representations: reps });
  }
  const tags = [...new Set(items.flatMap((item) => item.representations.flatMap((rep) => rep.tags)))].sort((a, b) => a.localeCompare(b));
  items.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'image' ? -1 : 1) || a.resourceId.localeCompare(b.resourceId));
  return { projectId: input.projectId, projectName: input.projectName, workspaces, groups, collections, tags, items };
}

/** Applies UI facets without cloning resources or introducing a second persisted index. */
export function filterMediaGalleryItems(items: readonly MediaGalleryItem[], filters: MediaGalleryFilters): MediaGalleryItem[] {
  return items.filter((item) => (!filters.kind || item.kind === filters.kind) &&
    (!filters.workspaceId || item.representations.some((representation) => representation.workspaceId === filters.workspaceId)) &&
    (!filters.groupId || item.representations.some((representation) => representation.groupIds.includes(filters.groupId!))) &&
    (!filters.collectionId || item.representations.some((representation) => representation.collectionIds.includes(filters.collectionId!))) &&
    (!filters.tag || item.representations.some((representation) => representation.tags.includes(filters.tag!))));
}
