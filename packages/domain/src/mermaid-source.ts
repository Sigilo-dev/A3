import type { ExtensionMap } from './models.js';

export const MERMAID_SOURCE_TYPE = 'a3.diagram.mermaid';
export const MERMAID_RENDERER = 'mermaid';
export const MERMAID_RENDERER_VERSION = '12.2.0';
export const MERMAID_SOURCE_LIMIT = 128_000;

/** Persisted metadata makes clear that Mermaid text, rather than an extracted A3 model, is authoritative. */
export function mermaidSourceProperties(): ExtensionMap {
  return {
    'a3.diagram.authority': 'source',
    'a3.diagram.format': 'mermaid',
    'a3.diagram.renderer': `${MERMAID_RENDERER}@${MERMAID_RENDERER_VERSION}`
  };
}

export function hasMermaidSourceAuthority(properties: ExtensionMap): boolean {
  return properties['a3.diagram.authority'] === 'source' && properties['a3.diagram.format'] === 'mermaid' &&
    properties['a3.diagram.renderer'] === `${MERMAID_RENDERER}@${MERMAID_RENDERER_VERSION}`;
}

export function supportsMermaidSourceRenderer(type: string, typeVersion: string, properties: ExtensionMap): boolean {
  return type === MERMAID_SOURCE_TYPE && typeVersion === '1.0.0' && hasMermaidSourceAuthority(properties);
}

export interface MermaidEngine {
  configure?(configuration: Record<string, unknown>): void;
  parse(source: string): Promise<false | { diagramType?: string }> | false | { diagramType?: string };
  render(id: string, source: string): Promise<{ svg: string }> | { svg: string };
}
let mermaidRenderQueue: Promise<void> = Promise.resolve();

export type MermaidRenderResult =
  | { state: 'rendered'; svg: string; diagramType: string }
  | { state: 'invalid'; message: string; line?: number; column?: number }
  | { state: 'unavailable'; message: string }
  | { state: 'too-large'; message: string };

function locationFrom(error: unknown): { line?: number; column?: number } {
  if (!error || typeof error !== 'object') return {};
  const record = error as { line?: unknown; column?: unknown; hash?: { line?: unknown; loc?: { first_line?: unknown; first_column?: unknown } } };
  const message = error instanceof Error ? error.message : '';
  const lineFromMessage = message.match(/(?:parse\s+error\s+on\s+line|line)\s+(\d+)/i)?.[1];
  const columnFromMessage = message.match(/(?:column|col)\s+(\d+)/i)?.[1];
  const line = Number(record.hash?.loc?.first_line ?? record.hash?.line ?? record.line ?? lineFromMessage);
  const column = Number(record.hash?.loc?.first_column ?? record.column ?? columnFromMessage);
  return { ...(Number.isInteger(line) && line > 0 ? { line } : {}), ...(Number.isInteger(column) && column > 0 ? { column } : {}) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 1200);
  return 'La fuente Mermaid no pudo interpretarse.';
}

/**
 * Runs a renderer supplied by the caller. This domain adapter never loads a package,
 * executes source as JavaScript/HTML, edits it, or converts it to an A3 model.
 */
export async function renderMermaidSource(source: string, renderId: string, loadEngine: () => Promise<MermaidEngine>, configuration?: Record<string, unknown>): Promise<MermaidRenderResult> {
  if (source.length > MERMAID_SOURCE_LIMIT) return { state: 'too-large', message: `La vista Mermaid está limitada a ${MERMAID_SOURCE_LIMIT.toLocaleString('es')} caracteres; la fuente original permanece intacta.` };
  let engine: MermaidEngine;
  try { engine = await loadEngine(); }
  catch { return { state: 'unavailable', message: `El motor Mermaid ${MERMAID_RENDERER_VERSION} no está disponible; la fuente original permanece intacta.` }; }
  let release!: () => void;
  const previous = mermaidRenderQueue;
  mermaidRenderQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (configuration) engine.configure?.(configuration);
    const parsed = await engine.parse(source);
    if (parsed === false) return { state: 'invalid', message: 'Mermaid rechazó la fuente; la fuente original permanece intacta.' };
    const output = await engine.render(renderId, source);
    return { state: 'rendered', svg: output.svg, diagramType: parsed.diagramType ?? 'desconocido' };
  } catch (error) {
    return { state: 'invalid', message: errorMessage(error), ...locationFrom(error) };
  } finally { release(); }
}
