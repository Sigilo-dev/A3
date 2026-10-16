import { memo } from 'react';
import { getStroke } from 'perfect-freehand';
import rough from 'roughjs';
import type { CanvasDrawingView } from '../../shared/desktop-api';
import type { DrawingParameters, DrawingPoint } from '@a3/domain';

export interface StrokePreview { points: DrawingPoint[]; parameters: DrawingParameters; color: string; }

function strokePath(points: readonly DrawingPoint[], parameters: DrawingParameters, origin: { x: number; y: number }): string {
  if (!points.length) return '';
  const input = points.map((point) => point.pressure === undefined
    ? [point.x - origin.x, point.y - origin.y]
    : [point.x - origin.x, point.y - origin.y, point.pressure]);
  const outline = getStroke(input, parameters);
  if (!outline.length) return '';
  return `M ${outline.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

function colorOf(drawing: CanvasDrawingView): string {
  const color = drawing.style['a3.ui.stroke.color'];
  return typeof color === 'string' && /^#[\da-f]{6}$/i.test(color) ? color : '#c3ed82';
}

function roughSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) || 1;
}

function renderPaths(drawing: CanvasDrawingView, d: string, color: string): { d: string; fill?: string; stroke: string; strokeWidth: number }[] {
  if (drawing.style['a3.ui.stroke.rendering'] !== 'rough') return [{ d, fill: color, stroke: 'none', strokeWidth: 0 }];
  const storedRoughness = Number(drawing.style['a3.ui.stroke.roughness']);
  const roughness = Number.isFinite(storedRoughness) ? Math.max(0.1, Math.min(4, storedRoughness)) : 1.25;
  const generator = rough.generator();
  return generator.toPaths(generator.path(d, {
    fill: color, fillStyle: 'solid', stroke: color, strokeWidth: 0.65,
    roughness, bowing: 1.2, seed: roughSeed(drawing.id),
  }));
}

export const CanvasDrawingLayer = memo(function CanvasDrawingLayer({ drawings, origin, tool, selectedIds, preview, onSelect }: {
  drawings: readonly CanvasDrawingView[]; origin: { x: number; y: number }; tool: string; selectedIds: readonly string[];
  preview: StrokePreview | null; onSelect: (id: string, event: React.MouseEvent<SVGElement> | React.KeyboardEvent<SVGElement>) => void;
}): React.JSX.Element {
  const selected = new Set(selectedIds);
  return <svg className="canvas-drawing-layer" width="1" height="1" overflow="visible" aria-label="Trazos del workspace">
    {drawings.map((drawing) => {
      const d = strokePath(drawing.points, drawing.parameters, origin);
      if (!d) return null;
      const active = selected.has(drawing.id), color = colorOf(drawing), paths = renderPaths(drawing, d, color);
      return <g key={drawing.id} data-drawing-id={drawing.id} data-drawing-selected={active || undefined}
        data-drawing-rendering={drawing.style['a3.ui.stroke.rendering'] === 'rough' ? 'rough' : 'clean'} className="canvas-drawing-path"
        pointerEvents={tool === 'draw' ? 'none' : 'visiblePainted'} role="button" tabIndex={tool === 'select' ? 0 : -1}
        aria-label={`Trazo ${drawing.id}`} aria-pressed={active} onPointerDown={(event) => { event.stopPropagation(); }}
        onClick={(event) => { event.stopPropagation(); onSelect(drawing.id, event); }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(drawing.id, event); } }}>
        {paths.map((path, index) => <path key={index} d={path.d} fill={path.fill && path.fill !== 'none' ? path.fill : 'none'}
          stroke={path.stroke && path.stroke !== 'none' ? path.stroke : 'none'} strokeWidth={path.strokeWidth} pointerEvents="none" />)}
        {active && <path d={d} fill="none" stroke="#ffffff" strokeOpacity="0.78" strokeWidth="1.5" pointerEvents="none" />}
      </g>;
    })}
    {preview && <path data-drawing-preview="true" d={strokePath(preview.points, preview.parameters, origin)} fill={preview.color} opacity="0.82" pointerEvents="none" />}
  </svg>;
});
