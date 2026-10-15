/** A3 camera: CSS-pixel translation of world origin, plus a dimensionless scale. */
export interface WorldViewport { x: number; y: number; zoom: number; }
export interface WorldPoint { x: number; y: number; }
export interface ViewSize { width: number; height: number; }
export interface WorldBounds extends WorldPoint, ViewSize {}
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const GRID_SIZE = 20;

export function validViewport(value: unknown): value is WorldViewport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as WorldViewport;
  return Object.keys(v).length === 3 && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0;
}
function finitePoint(p: WorldPoint): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Las coordenadas deben ser finitas.');
}
function camera(v: WorldViewport): void {
  if (!validViewport(v)) throw new RangeError('Viewport inválido.');
  // Refuse a view before Float64 precision exceeds a quarter CSS pixel. Never truncate source geometry.
  if (Math.max(Math.abs(v.x), Math.abs(v.y)) * Number.EPSILON > 0.25) {
    throw new RangeError('Esta cámara supera la precisión visual disponible; vuelve a una vista más cercana al origen.');
  }
}
export function screenToWorld(point: WorldPoint, v: WorldViewport): WorldPoint {
  camera(v); finitePoint(point);
  const result = { x: (point.x - v.x) / v.zoom, y: (point.y - v.y) / v.zoom }; finitePoint(result); return result;
}
/** Nearby world origin keeps browser transforms small even in a scene at 10^12 world units. */
export function renderOrigin(v: WorldViewport): WorldPoint {
  return screenToWorld({ x: 0, y: 0 }, v);
}
export function gridOffset(origin: WorldPoint): [number, number] {
  // Background expects a positive offset which it negates in its SVG transform.
  return [((origin.x % GRID_SIZE) + GRID_SIZE) % GRID_SIZE, ((origin.y % GRID_SIZE) + GRID_SIZE) % GRID_SIZE];
}
export function toVisualViewport(v: WorldViewport, origin: WorldPoint): WorldViewport {
  camera(v); finitePoint(origin);
  const result = { x: v.x + origin.x * v.zoom, y: v.y + origin.y * v.zoom, zoom: v.zoom }; camera(result); return result;
}
export function fromVisualViewport(v: WorldViewport, origin: WorldPoint): WorldViewport {
  camera(v); finitePoint(origin);
  const result = { x: v.x - origin.x * v.zoom, y: v.y - origin.y * v.zoom, zoom: v.zoom }; camera(result); return result;
}
export function worldToScreen(point: WorldPoint, v: WorldViewport): WorldPoint {
  camera(v); finitePoint(point);
  const origin = renderOrigin(v); const local = toVisualViewport(v, origin);
  const result = { x: (point.x - origin.x) * v.zoom + local.x, y: (point.y - origin.y) * v.zoom + local.y };
  finitePoint(result); return result;
}
export function panViewport(v: WorldViewport, delta: WorldPoint): WorldViewport {
  camera(v); finitePoint(delta);
  const result = { ...v, x: v.x + delta.x, y: v.y + delta.y }; camera(result); return result;
}
export function zoomAt(v: WorldViewport, cursor: WorldPoint, requestedZoom: number): WorldViewport {
  camera(v); finitePoint(cursor);
  if (!Number.isFinite(requestedZoom) || requestedZoom <= 0) throw new RangeError('Escala inválida.');
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedZoom));
  // Preserve cursor's world point without rounding or repeatedly fitting the content.
  const ratio = zoom / v.zoom;
  const result = { x: cursor.x + (v.x - cursor.x) * ratio, y: cursor.y + (v.y - cursor.y) * ratio, zoom }; camera(result); return result;
}
export function fitContent(bounds: WorldBounds, size: ViewSize, padding = 48): WorldViewport {
  finitePoint(bounds);
  if (![bounds.width, bounds.height, size.width, size.height, padding].every(Number.isFinite) ||
      bounds.width < 0 || bounds.height < 0 || size.width <= 0 || size.height <= 0 || padding < 0) throw new RangeError('Área inválida.');
  // Explicit fit may go below the interactive range; no automatic fit on mount or resize.
  const zoom = Math.min(MAX_ZOOM, Math.max(1, size.width - padding * 2) / Math.max(1, bounds.width), Math.max(1, size.height - padding * 2) / Math.max(1, bounds.height));
  const result = { x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom }; camera(result); return result;
}
export interface WheelInput { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; }
export function wheelViewport(v: WorldViewport, input: WheelInput, cursor: WorldPoint, size: ViewSize): WorldViewport {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? size.height : 1;
  const dx = input.deltaX * unit; const dy = input.deltaY * unit;
  if (![dx, dy].every(Number.isFinite)) throw new RangeError('Desplazamiento inválido.');
  if (input.ctrlKey || input.metaKey) return zoomAt(v, cursor, v.zoom * Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.01));
  return panViewport(v, input.shiftKey && dx === 0 ? { x: -dy, y: 0 } : { x: -dx, y: -dy });
}
