import type { LocalCanvasWorkspace } from './projects.js';
import { getStroke } from 'perfect-freehand';
import rough from 'roughjs';

interface ExportRoughPath { d: string; fill?: string; stroke?: string; strokeWidth: number; }
interface ExportRoughGenerator { path(value: string, options: Record<string, unknown>): unknown; toPaths(value: unknown): ExportRoughPath[]; }
interface ExportRoughApi { generator(): ExportRoughGenerator; }
const roughImport = rough as unknown as ExportRoughApi & { default?: ExportRoughApi };
const roughApi = roughImport.default ?? roughImport;

export type CanvasExportScope = 'selection' | 'group' | 'diagram' | 'workspace';
export interface CanvasExportSelection { placements: readonly string[]; groups: readonly string[]; drawings: readonly string[]; edges: readonly string[]; }
export interface CanvasExportOptions {
  scope: CanvasExportScope; selection: CanvasExportSelection; groupId?: string;
  background: 'transparent' | 'opaque' | 'project'; margin: number; scale: number;
}
export interface CanvasExportContent { text?: string; dataUrl?: string; }
export interface CanvasExportWorkspace extends LocalCanvasWorkspace { content?: Readonly<Record<string, CanvasExportContent>>; }
export interface CanvasExportBounds { x: number; y: number; width: number; height: number; }
export interface CanvasExportResult { svg: string; width: number; height: number; bounds: CanvasExportBounds; rasterized: string[]; diagnostics: string[]; }
export interface PdfPagePlan { index: number; total: number; bounds: CanvasExportBounds; }
export interface PdfPageOptions { paper: 'A3' | 'A4'; orientation: 'portrait' | 'landscape'; marginMm: number; fit: 'page' | 'tiles'; scale: number; }

const esc = (value: unknown): string => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const finite = (value: number): boolean => Number.isFinite(value);
const safeHref = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined; } catch { return undefined; }
};
function selectedIds(workspace: LocalCanvasWorkspace, options: CanvasExportOptions): { placements: Set<string>; groups: Set<string>; drawings: Set<string>; edges: Set<string> } {
  const placements = new Set<string>(), groups = new Set<string>(), drawings = new Set<string>(), edges = new Set<string>();
  const groupMap = new Map(workspace.groups.map((group) => [group.id.toLowerCase(), group]));
  const placementIds = new Set(workspace.placements.map((item) => item.id.toLowerCase()));
  const drawingIds = new Set(workspace.drawings.map((item) => item.id.toLowerCase()));
  const edgeIds = new Set(workspace.visualEdges.map((item) => item.id.toLowerCase()));
  const visitGroup = (id: string, visited = new Set<string>()): void => {
    const key = id.toLowerCase(); if (visited.has(key)) return; visited.add(key);
    const group = groupMap.get(key); if (!group) return; groups.add(group.id.toLowerCase());
    for (const member of group.members) member.kind === 'placement' ? placements.add(member.id.toLowerCase()) : member.kind === 'drawing' ? drawings.add(member.id.toLowerCase()) : visitGroup(member.id, visited);
  };
  const addGroup = (id: string): void => { if (!groupMap.has(id.toLowerCase())) throw new Error('El grupo seleccionado ya no existe en este workspace.'); visitGroup(id); };
  if (options.scope === 'diagram' || options.scope === 'workspace') {
    for (const item of workspace.placements) placements.add(item.id.toLowerCase());
    for (const item of workspace.groups) groups.add(item.id.toLowerCase());
    for (const item of workspace.drawings) drawings.add(item.id.toLowerCase());
    for (const item of workspace.visualEdges) edges.add(item.id.toLowerCase());
  } else if (options.scope === 'group') {
    if (!options.groupId) throw new Error('Selecciona el grupo que se va a exportar.'); addGroup(options.groupId);
  } else {
    for (const id of options.selection.placements) { if (!placementIds.has(id.toLowerCase())) throw new Error('Una representación seleccionada ya no está en este workspace.'); placements.add(id.toLowerCase()); }
    for (const id of options.selection.drawings) { if (!drawingIds.has(id.toLowerCase())) throw new Error('Un trazo seleccionado ya no está en este workspace.'); drawings.add(id.toLowerCase()); }
    for (const id of options.selection.groups) addGroup(id);
    for (const id of options.selection.edges) { if (!edgeIds.has(id.toLowerCase())) throw new Error('Una línea seleccionada ya no está en este workspace.'); edges.add(id.toLowerCase()); }
    // Explicitly selected edges bring their endpoint representations into the export.
    for (const edge of workspace.visualEdges) if (edges.has(edge.id.toLowerCase())) { placements.add(edge.sourcePlacementId.toLowerCase()); placements.add(edge.targetPlacementId.toLowerCase()); }
  }
  // Include internal edges automatically. Boundary edges are omitted unless selected and diagnosed below.
  for (const edge of workspace.visualEdges) if (placements.has(edge.sourcePlacementId.toLowerCase()) && placements.has(edge.targetPlacementId.toLowerCase())) edges.add(edge.id.toLowerCase());
  return { placements, groups, drawings, edges };
}
function textLines(value: string, x: number, y: number, maxChars: number, lineHeight: number): string {
  const normalized = value.replace(/\r\n?/g, '\n'), lines: string[] = [];
  for (const line of normalized.split('\n')) {
    if (line.length <= maxChars) lines.push(line);
    else for (let offset = 0; offset < line.length; offset += maxChars) lines.push(line.slice(offset, offset + maxChars));
  }
  return lines.slice(0, 10).map((line, i) => `<text x="${x}" y="${y + i * lineHeight}" class="body">${esc(line)}</text>`).join('');
}
function dataBounds(points: { x: number; y: number }[], padding: number): CanvasExportBounds {
  if (!points.length) return { x: 0, y: 0, width: 320, height: 200 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y), minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { x: minX - padding, y: minY - padding, width: Math.max(1, maxX - minX + padding * 2), height: Math.max(1, maxY - minY + padding * 2) };
}

/** Deterministic SVG export from persisted workspace snapshots; it never reads React Flow or a live DOM. */
export function renderCanvasExportSvg(workspaces: readonly CanvasExportWorkspace[], options: CanvasExportOptions): CanvasExportResult {
  if (!workspaces.length || workspaces.length > 100) throw new Error('El export requiere de 1 a 100 workspaces.');
  if (!finite(options.margin) || options.margin < 0 || options.margin > 500 || !finite(options.scale) || options.scale < 0.1 || options.scale > 4) throw new Error('Margen o escala fuera del rango admitido.');
  const itemCount = workspaces.reduce((sum, workspace) => sum + workspace.placements.length + workspace.visualEdges.length + workspace.drawings.length, 0);
  if (itemCount > 15000) throw new Error('El diagrama excede el límite local de 15 000 primitivas. Divide el alcance en grupos o workspaces para exportar por partes.');
  const diagnostics: string[] = [], rasterized: string[] = [], layers: string[] = [], allPoints: { x: number; y: number }[] = [];
  let workspaceOffset = 0;
  for (const workspace of workspaces) {
    const picked = selectedIds(workspace, options), itemById = new Map(workspace.entities.map((entity) => [entity.id.toLowerCase(), entity]));
    const placementById = new Map(workspace.placements.map((placement) => [placement.id.toLowerCase(), placement]));
    const chosenPlacements = workspace.placements.filter((item) => picked.placements.has(item.id.toLowerCase()));
    const chosenDrawings = workspace.drawings.filter((item) => picked.drawings.has(item.id.toLowerCase()));
    const minNodeX = chosenPlacements.length ? Math.min(...chosenPlacements.map((p) => p.position.x)) : 0;
    const maxNodeX = chosenPlacements.length ? Math.max(...chosenPlacements.map((p) => p.position.x + p.size.width)) : 0;
    const offsetX = options.scope === 'workspace' && workspaceOffset > 0 ? workspaceOffset - minNodeX : 0;
    if (offsetX) layers.push(`<text x="${offsetX}" y="-36" class="workspace-label">${esc(workspace.name)}</text>`);
    else if (options.scope === 'workspace') layers.push(`<text x="${minNodeX}" y="-36" class="workspace-label">${esc(workspace.name)}</text>`);
    workspaceOffset = Math.max(workspaceOffset, maxNodeX + offsetX + 180);
    const x = (value: number): number => value + offsetX;
    const visibleIds = new Set(chosenPlacements.map((p) => p.id.toLowerCase()));
    const outsideEdges = workspace.visualEdges.filter((edge) => visibleIds.has(edge.sourcePlacementId.toLowerCase()) !== visibleIds.has(edge.targetPlacementId.toLowerCase()));
    if (outsideEdges.length) diagnostics.push(`${workspace.name}: ${outsideEdges.length} conexión(es) visual(es) hacia elementos fuera de la selección fueron omitidas.`);
    for (const group of workspace.groups) if (picked.groups.has(group.id.toLowerCase())) {
      const groupById = new Map(workspace.groups.map((item) => [item.id.toLowerCase(), item]));
      const ids = new Set<string>();
      const visit = (groupId: string, seen = new Set<string>()): void => {
        const key = groupId.toLowerCase(); if (seen.has(key)) return; seen.add(key);
        for (const member of groupById.get(key)?.members ?? []) member.kind === 'placement' ? ids.add(member.id.toLowerCase()) : member.kind === 'group' ? visit(member.id, seen) : undefined;
      };
      visit(group.id);
      const members = chosenPlacements.filter((p) => ids.has(p.id.toLowerCase())); if (!members.length) continue;
      const bounds = dataBounds(members.flatMap((p) => [{ x: p.position.x, y: p.position.y }, { x: p.position.x + p.size.width, y: p.position.y + p.size.height }]), 18);
      layers.push(`<rect class="group" x="${x(bounds.x)}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="14"/><text class="group-label" x="${x(bounds.x + 8)}" y="${bounds.y + 18}">${esc(group.name)}</text>`);
      allPoints.push({ x: x(bounds.x), y: bounds.y }, { x: x(bounds.x + bounds.width), y: bounds.y + bounds.height });
    }
    for (const edge of workspace.visualEdges) if (picked.edges.has(edge.id.toLowerCase()) && visibleIds.has(edge.sourcePlacementId.toLowerCase()) && visibleIds.has(edge.targetPlacementId.toLowerCase())) {
      const a = placementById.get(edge.sourcePlacementId.toLowerCase()), b = placementById.get(edge.targetPlacementId.toLowerCase()); if (!a || !b) continue;
      const colorValue = edge.style['a3.ui.line.color']; const color = typeof colorValue === 'string' && /^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : '#64748b';
      const direction = edge.style['a3.ui.line.direction'];
      const markerStart = direction === 'backward' || direction === 'both' ? ' marker-start="url(#a3-arrow)"' : '';
      const markerEnd = direction === 'forward' || direction === 'both' ? ' marker-end="url(#a3-arrow)"' : '';
      const points = [{ x: x(a.position.x + a.size.width / 2), y: a.position.y + a.size.height / 2 }, ...edge.waypoints.map((p) => ({ x: x(p.x), y: p.y })), { x: x(b.position.x + b.size.width / 2), y: b.position.y + b.size.height / 2 }];
      layers.push(`<polyline class="edge" stroke="${color}"${markerStart}${markerEnd} points="${points.map((p) => `${p.x},${p.y}`).join(' ')}"/>`);
      if (edge.label) layers.push(`<text class="edge-label" x="${(points[0]!.x + points.at(-1)!.x) / 2}" y="${(points[0]!.y + points.at(-1)!.y) / 2 - 6}">${esc(edge.label)}</text>`);
      allPoints.push(...points);
    }
    for (const relation of [...workspace.conceptualRelations, ...workspace.c4.relationViews, ...workspace.uml.relationViews, ...workspace.er.relationViews]) {
      if (!visibleIds.has(relation.sourcePlacementId.toLowerCase()) || !visibleIds.has(relation.targetPlacementId.toLowerCase())) continue;
      const a = placementById.get(relation.sourcePlacementId.toLowerCase()), b = placementById.get(relation.targetPlacementId.toLowerCase()); if (!a || !b) continue;
      const data = 'data' in relation && relation.data && typeof relation.data === 'object' ? relation.data as Record<string, unknown> : undefined;
      const multiplicity = (value: unknown): string => value && typeof value === 'object' && 'min' in value && 'max' in value ? `${String((value as { min: unknown }).min)}..${String((value as { max: unknown }).max ?? '*')}` : '';
      const umlDetail = data && ('source' in data || 'target' in data) ? `${String(data.label ?? '')} ${multiplicity((data.source as { multiplicity?: unknown } | undefined)?.multiplicity)}:${multiplicity((data.target as { multiplicity?: unknown } | undefined)?.multiplicity)}` : '';
      const erDetail = data && ('sourceCardinality' in data || 'targetCardinality' in data) ? `${String(data.label ?? '')} ${String(data.sourceCardinality ?? '')}:${String(data.targetCardinality ?? '')}` : '';
      const label = 'label' in relation ? String(relation.label ?? '') : 'description' in relation ? `${String(relation.description ?? '')}${'protocol' in relation && relation.protocol ? ` · ${relation.protocol}` : ''}` : 'kind' in relation ? `${String(relation.kind ?? '')}${umlDetail ? ` · ${umlDetail}` : ''}` : erDetail || 'Relación';
      const p1 = { x: x(a.position.x + a.size.width / 2), y: a.position.y + a.size.height / 2 }, p2 = { x: x(b.position.x + b.size.width / 2), y: b.position.y + b.size.height / 2 };
      layers.push(`<line class="semantic" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/><text class="edge-label" x="${(p1.x + p2.x) / 2}" y="${(p1.y + p2.y) / 2 - 6}">${esc(label)}</text>`);
      allPoints.push(p1, p2);
    }
    for (const drawing of chosenDrawings) {
      if (!drawing.points.length) continue;
      const input = drawing.points.map((p) => p.pressure === undefined ? [x(p.x), p.y] : [x(p.x), p.y, p.pressure]);
      const outline = getStroke(input, drawing.parameters);
      if (!outline.length) continue;
      const path = `M ${outline.map(([px, py]) => `${px} ${py}`).join(' L ')} Z`, strokeValue = drawing.style['a3.ui.stroke.color'];
      const stroke = typeof strokeValue === 'string' && /^#[0-9a-f]{6}$/i.test(strokeValue) ? strokeValue : '#27364b';
      if (drawing.style['a3.ui.stroke.rendering'] === 'rough') {
        const seed = Array.from(drawing.id).reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619), 2166136261) >>> 0 || 1;
        const roughnessValue = Number(drawing.style['a3.ui.stroke.roughness']), roughness = Number.isFinite(roughnessValue) ? Math.max(.1, Math.min(4, roughnessValue)) : 1.25;
        const generator = roughApi.generator();
        const paths = generator.toPaths(generator.path(path, { fill: stroke, fillStyle: 'solid', stroke, strokeWidth: .65, roughness, bowing: 1.2, seed }));
        for (const item of paths) layers.push(`<path class="drawing" d="${esc(item.d)}" fill="${esc(item.fill ?? 'none')}" stroke="${esc(item.stroke ?? 'none')}" stroke-width="${item.strokeWidth}"/>`);
      } else layers.push(`<path class="drawing" d="${path}" fill="${stroke}" stroke="none"/>`);
      allPoints.push(...drawing.points.map((p) => ({ x: x(p.x), y: p.y })));
    }
    for (const placement of chosenPlacements) {
      const entity = itemById.get(placement.entityId.toLowerCase()); if (!entity) { diagnostics.push(`${workspace.name}: representación ${placement.id} sin entidad; se omitió.`); continue; }
      const left = x(placement.position.x), top = placement.position.y, width = placement.size.width, height = placement.size.height;
      const fill = options.background === 'project' ? workspace.diagramStyle.colors?.secondary ?? '#f8fafc' : '#ffffff';
      const border = workspace.diagramStyle.colors?.line ?? '#64748b', color = workspace.diagramStyle.colors?.text ?? '#1e293b';
      const content = entity.contentResourceId ? workspace.content?.[entity.contentResourceId.toLowerCase()] ?? workspace.content?.[entity.contentResourceId] : undefined;
      const umlData = workspace.uml.elements.find((item) => item.id.toLowerCase() === entity.id.toLowerCase())?.data;
      const erData = workspace.er.elements.find((item) => item.id.toLowerCase() === entity.id.toLowerCase())?.data;
      const c4Data = workspace.c4.elements.find((item) => item.id.toLowerCase() === entity.id.toLowerCase())?.data;
      const isImage = entity.type === 'a3.content.image';
      const resourceHref = safeHref(entity.contentResource?.url) ?? (entity.contentResource ? `a3-resource:${encodeURIComponent(entity.contentResource.id)}` : undefined);
      if (isImage && content?.dataUrl && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$/i.test(content.dataUrl)) {
        const imageLinkOpen = resourceHref ? `<a href="${esc(resourceHref)}" target="_blank" rel="noopener noreferrer">` : '', imageLinkClose = resourceHref ? '</a>' : '';
        layers.push(`${imageLinkOpen}<image href="${content.dataUrl}" x="${left + 8}" y="${top + 32}" width="${width - 16}" height="${height - 42}" preserveAspectRatio="xMidYMid meet"/><rect class="node" x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="none" stroke="${border}"/><text class="node-title" x="${left + 10}" y="${top + 21}">${esc(entity.title)}</text>${imageLinkClose}`);
        rasterized.push(`${entity.title} (imagen raster incrustada)`);
      } else {
        if (isImage) diagnostics.push(`${entity.title}: poster de imagen no disponible; se muestra tarjeta de referencia.`);
        const href = resourceHref;
        const anchorOpen = href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">` : '';
        const anchorClose = href ? '</a>' : '';
        const typedSummary = umlData ?? erData ?? c4Data;
        const iotSummary = entity.ports.length ? { puertos: entity.ports.map((port) => ({ ...port })) } : undefined;
        const body = content?.text ?? String(entity.properties.description ?? entity.properties.body ?? entity.properties['a3.content.description'] ??
          (typedSummary ? JSON.stringify(typedSummary) : iotSummary ? JSON.stringify(iotSummary) : ''));
        const media = ['a3.content.video', 'a3.content.audio', 'a3.content.youtube'].includes(entity.type);
        const rasterLabel = media ? '<rect x="12" y="34" width="68" height="42" rx="4" fill="#e2e8f0"/><text x="24" y="59" class="body">▶ poster</text>' : '';
        if (media) diagnostics.push(`${entity.title}: medio representado como poster y referencia; reproducción no incluida.`);
        if (/^(a3\.diagram\.|a3\.content\.diagram)/.test(entity.type)) diagnostics.push(`${entity.title}: vista previa de fuente/propiedades; este exportador no ejecuta motores ni plugins.`);
        const bodyText = textLines(body.slice(0, 800), left + 10, top + 46, Math.max(18, Math.floor((width - 20) / 7)), 16);
        layers.push(`${anchorOpen}<g><rect class="node" x="${left}" y="${top}" width="${width}" height="${height}" rx="${workspace.diagramStyle.borders?.radius ?? 8}" fill="${fill}" stroke="${border}"/><text class="node-title" fill="${color}" x="${left + 10}" y="${top + 22}">${esc(entity.title)}</text><text class="node-type" x="${left + 10}" y="${top + 36}">${esc(entity.type.replace(/^a3\./, ''))}</text>${rasterLabel}${bodyText}</g>${anchorClose}`);
        if (!entity.typeAvailable) diagnostics.push(`${entity.title}: tipo/paquete sin renderer; se exporta fallback declarativo.`);
      }
      allPoints.push({ x: left, y: top }, { x: left + width, y: top + height });
    }
  }
  const padding = options.margin + 12, bounds = dataBounds(allPoints, padding), width = Math.ceil(bounds.width * options.scale), height = Math.ceil(bounds.height * options.scale);
  if (width > 30000 || height > 30000 || width * height > 160_000_000) throw new Error('El SVG supera el límite seguro de dimensiones; reduce escala o exporta una selección.');
  const backgroundColor = options.background === 'project' ? workspaces[0]?.diagramStyle.background?.color ?? workspaces[0]?.diagramStyle.colors?.background ?? '#ffffff' : '#ffffff';
  const background = options.background === 'transparent' ? '' : `<rect class="export-background" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${backgroundColor}"/>`;
  const report = esc(JSON.stringify({ schemaVersion: '1.0.0', rasterized, diagnostics }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img"><title>A3 · exportación</title><desc>Geometría exportada desde datos del proyecto A3. Sin controles del editor.</desc><metadata id="a3-export-report">${report}</metadata><defs><marker id="a3-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker></defs><style>text{font-family:${esc(workspaces[0]?.diagramStyle.fonts?.family ?? 'Arial, sans-serif')};fill:${workspaces[0]?.diagramStyle.colors?.text ?? '#1e293b'}}.workspace-label{font-size:22px;font-weight:700}.group{fill:#94a3b815;stroke:#94a3b8;stroke-dasharray:7 5}.group-label{font-size:13px;font-weight:600}.node{stroke-width:1.5}.node-title{font-size:14px;font-weight:700}.node-type,.body{font-size:11px;fill:#475569}.edge,.semantic,.drawing{fill:none;stroke-width:2}.edge{stroke-dasharray:6 4}.semantic{stroke:#475569;stroke-width:1.5}.edge-label{font-size:11px;text-anchor:middle}.drawing{stroke-linecap:round;stroke-linejoin:round}.node-title{fill:#1e293b}</style>${background}${layers.join('')}</svg>`;
  return { svg, width, height, bounds, rasterized, diagnostics };
}

/** Yields between project workspaces so a large workspace-wide export remains cancellable by the host. */
export async function renderCanvasExportSvgAsync(workspaces: readonly CanvasExportWorkspace[], options: CanvasExportOptions, signal?: AbortSignal): Promise<CanvasExportResult> {
  if (options.scope !== 'workspace' || workspaces.length <= 1) {
    if (signal?.aborted) throw new DOMException('Exportación cancelada.', 'AbortError');
    return renderCanvasExportSvg(workspaces, options);
  }
  const children: CanvasExportResult[] = [];
  for (const workspace of workspaces) {
    if (signal?.aborted) throw new DOMException('Exportación cancelada.', 'AbortError');
    children.push(renderCanvasExportSvg([workspace], { ...options, scope: 'diagram' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (signal?.aborted) throw new DOMException('Exportación cancelada.', 'AbortError');
  const gap = 32, widthUnits = children.reduce((sum, child) => sum + child.bounds.width, 0) + gap * (children.length - 1), heightUnits = Math.max(...children.map((child) => child.bounds.height));
  const width = Math.ceil(widthUnits * options.scale), height = Math.ceil(heightUnits * options.scale), parts: string[] = [];
  let offset = 0;
  children.forEach((child, index) => {
    const inner = child.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    parts.push(`<svg x="${offset}" y="0" width="${child.bounds.width}" height="${child.bounds.height}" viewBox="${child.bounds.x} ${child.bounds.y} ${child.bounds.width} ${child.bounds.height}"><text x="${child.bounds.x}" y="${child.bounds.y + 20}" class="workspace-label">${esc(workspaces[index]!.name)}</text>${inner}</svg>`);
    offset += child.bounds.width + gap;
  });
  const bounds = { x: 0, y: 0, width: widthUnits, height: heightUnits };
  const background = options.background === 'transparent' ? '' : `<rect class="export-background" x="0" y="0" width="${widthUnits}" height="${heightUnits}" fill="${options.background === 'project' ? workspaces[0]?.diagramStyle.background?.color ?? workspaces[0]?.diagramStyle.colors?.background ?? '#ffffff' : '#ffffff'}"/>`;
  const rasterized = children.flatMap((child) => child.rasterized), diagnostics = children.flatMap((child) => child.diagnostics);
  const metadata = esc(JSON.stringify({ schemaVersion: '1.0.0', rasterized, diagnostics }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${widthUnits} ${heightUnits}"><title>A3 · proyecto completo</title><metadata id="a3-export-report">${metadata}</metadata>${background}${parts.join('')}</svg>`;
  return { svg, width, height, bounds, rasterized, diagnostics };
}

export function planCanvasPdfPages(bounds: CanvasExportBounds, options: PdfPageOptions): PdfPagePlan[] {
  if (!finite(options.marginMm) || options.marginMm < 0 || options.marginMm > 40 || !finite(options.scale) || options.scale < 0.1 || options.scale > 4) throw new Error('Margen o escala PDF fuera del rango admitido.');
  const [short, long] = options.paper === 'A3' ? [297, 420] : [210, 297];
  const pageWidth = options.orientation === 'landscape' ? long : short, pageHeight = options.orientation === 'landscape' ? short : long;
  const widthMm = pageWidth - options.marginMm * 2, heightMm = pageHeight - options.marginMm * 2;
  if (widthMm <= 0 || heightMm <= 0) throw new Error('El margen supera el tamaño de página.');
  if (options.fit === 'page') return [{ index: 0, total: 1, bounds: { ...bounds } }];
  const tileWidth = widthMm / 25.4 * 96 / options.scale, tileHeight = heightMm / 25.4 * 96 / options.scale;
  const cols = Math.max(1, Math.ceil(bounds.width / tileWidth)), rows = Math.max(1, Math.ceil(bounds.height / tileHeight));
  if (cols * rows > 100) throw new Error('El PDF superaría 100 páginas; ajusta escala o exporta en modo Ajustar a página.');
  const total = cols * rows, pages: PdfPagePlan[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) pages.push({ index: pages.length, total,
    bounds: { x: bounds.x + col * tileWidth, y: bounds.y + row * tileHeight, width: Math.min(tileWidth, bounds.width - col * tileWidth), height: Math.min(tileHeight, bounds.height - row * tileHeight) } });
  return pages;
}

export function canvasPdfHtml(svg: string, pages: readonly PdfPagePlan[], options: PdfPageOptions): string {
  const pageSize = options.paper, landscape = options.orientation === 'landscape' ? 'landscape' : 'portrait';
  const pageElements = pages.map((page) => {
    const cropped = svg.replace(/viewBox="[^"]+"/, `viewBox="${page.bounds.x} ${page.bounds.y} ${page.bounds.width} ${page.bounds.height}"`)
      .replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"');
    const encoded = `data:image/svg+xml;base64,${Buffer.from(cropped, 'utf8').toString('base64')}`;
    return `<section class="page"><img alt="Página ${page.index + 1} de ${page.total}" src="${encoded}"></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>@page{size:${pageSize} ${landscape};margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}.page{width:${options.paper === 'A3' ? landscape === 'landscape' ? 420 : 297 : landscape === 'landscape' ? 297 : 210}mm;height:${options.paper === 'A3' ? landscape === 'landscape' ? 297 : 420 : landscape === 'landscape' ? 210 : 297}mm;padding:${options.marginMm}mm;display:flex;align-items:center;justify-content:center;overflow:hidden;page-break-after:always}.page:last-child{page-break-after:auto}.page img{max-width:100%;max-height:100%}</style></head><body>${pageElements}</body></html>`;
}

export { canvasPdfHtml as buildCanvasPdfHtml };
