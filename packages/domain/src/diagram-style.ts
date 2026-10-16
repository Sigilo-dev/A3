import type { JsonValue } from './models.js';

export const DIAGRAM_STYLE_EXTENSION = 'a3.diagrams.style';
export type DiagramEngine = 'a3-native' | 'mermaid' | 'plantuml' | 'structurizr';
export type DiagramOrientation = 'top-down' | 'left-right' | 'bottom-up' | 'right-left';
export interface DiagramStyleValues {
  fonts?: { family?: string; size?: number };
  colors?: { background?: string; primary?: string; secondary?: string; text?: string; line?: string };
  borders?: { color?: string; width?: number; radius?: number };
  orientation?: DiagramOrientation;
  spacing?: { nodes?: number; ranks?: number };
  background?: { color?: string; resourceId?: string };
  scale?: number;
}
export interface DiagramStyleProfile extends DiagramStyleValues {
  schemaVersion: '1.0.0';
  engine: DiagramEngine;
  theme: string;
}
export interface DiagramStyleLayers {
  typeBase?: DiagramStyleValues;
  projectTheme?: DiagramStyleValues;
  entity?: DiagramStyleValues;
  view?: DiagramStyleValues;
}
export interface DiagramStyleAdaptation {
  engine: DiagramEngine;
  applied: DiagramStyleValues;
  unsupported: string[];
  mermaidConfig?: Record<string, unknown>;
  plantUmlSkinparam?: string;
  structurizrTheme?: Record<string, unknown>;
}

const engines = new Set<DiagramEngine>(['a3-native', 'mermaid', 'plantuml', 'structurizr']);
const colorFields = ['background', 'primary', 'secondary', 'text', 'line'] as const;
const colors = new Set<string>(colorFields);
const hex = /^#[0-9a-f]{6}$/i;
const resourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fontFamily = /^[\p{L}\p{N} ,_'"-]{1,120}$/u;
const orientation = new Set<DiagramOrientation>(['top-down', 'left-right', 'bottom-up', 'right-left']);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate portable style data without loading or interpreting any CSS, URL, or engine source. */
export function validateDiagramStyleProfile(value: unknown): string[] {
  const issues: string[] = [];
  if (!object(value) || value.schemaVersion !== '1.0.0' || !engines.has(value.engine as DiagramEngine) ||
      typeof value.theme !== 'string' || !/^[a-z0-9][a-z0-9 ._-]{0,63}$/i.test(value.theme) ||
      !keys(value, ['schemaVersion', 'engine', 'theme', 'fonts', 'colors', 'borders', 'orientation', 'spacing', 'background', 'scale'])) {
    return ['El perfil debe usar schemaVersion 1.0.0, un motor conocido y campos declarativos permitidos.'];
  }
  if (value.fonts !== undefined && (!object(value.fonts) || !keys(value.fonts, ['family', 'size']) ||
      value.fonts.family !== undefined && (typeof value.fonts.family !== 'string' || !fontFamily.test(value.fonts.family)) ||
      value.fonts.size !== undefined && (!Number.isFinite(value.fonts.size) || Number(value.fonts.size) < 6 || Number(value.fonts.size) > 72))) issues.push('Fuente inválida; usa familia simple y tamaño entre 6 y 72 px.');
  if (value.colors !== undefined && (!object(value.colors) || !keys(value.colors, [...colors]) ||
      Object.values(value.colors).some((color) => typeof color !== 'string' || !hex.test(color)))) issues.push('Los colores deben ser hexadecimales #RRGGBB.');
  if (value.borders !== undefined && (!object(value.borders) || !keys(value.borders, ['color', 'width', 'radius']) ||
      value.borders.color !== undefined && (typeof value.borders.color !== 'string' || !hex.test(value.borders.color)) ||
      value.borders.width !== undefined && (!Number.isFinite(value.borders.width) || Number(value.borders.width) < 0 || Number(value.borders.width) > 12) ||
      value.borders.radius !== undefined && (!Number.isFinite(value.borders.radius) || Number(value.borders.radius) < 0 || Number(value.borders.radius) > 48))) issues.push('Borde inválido; ancho 0–12 px y radio 0–48 px.');
  if (value.orientation !== undefined && !orientation.has(value.orientation as DiagramOrientation)) issues.push('Orientación desconocida.');
  if (value.spacing !== undefined && (!object(value.spacing) || !keys(value.spacing, ['nodes', 'ranks']) ||
      Object.values(value.spacing).some((spacing) => !Number.isFinite(spacing) || Number(spacing) < 0 || Number(spacing) > 1000))) issues.push('El espaciado debe estar entre 0 y 1000 unidades.');
  if (value.background !== undefined && (!object(value.background) || !keys(value.background, ['color', 'resourceId']) ||
      value.background.color !== undefined && (typeof value.background.color !== 'string' || !hex.test(value.background.color)) ||
      value.background.resourceId !== undefined && (typeof value.background.resourceId !== 'string' || !resourceId.test(value.background.resourceId)))) issues.push('El fondo solo admite color hexadecimal y un resourceId A3.');
  if (value.scale !== undefined && (!Number.isFinite(value.scale) || Number(value.scale) < 0.1 || Number(value.scale) > 4)) issues.push('La escala debe estar entre 0.1 y 4.');
  return issues;
}

export function defaultDiagramStyleProfile(): DiagramStyleProfile {
  return { schemaVersion: '1.0.0', engine: 'a3-native', theme: 'default' };
}

function themeValues(theme: string): DiagramStyleValues {
  switch (theme.toLowerCase()) {
    case 'dark': return { colors: { background: '#1c2530', primary: '#314559', secondary: '#283847', text: '#f1f5f9', line: '#a5bacd' }, borders: { color: '#647b91' } };
    case 'forest': return { colors: { background: '#f3f7f0', primary: '#d7ead0', secondary: '#ecf3e8', text: '#20352a', line: '#526b57' }, borders: { color: '#66846d' } };
    case 'neutral': return { colors: { background: '#ffffff', primary: '#f0f0f0', secondary: '#fafafa', text: '#222222', line: '#555555' }, borders: { color: '#777777' } };
    default: return {};
  }
}

function mergeValues(...layers: (DiagramStyleValues | undefined)[]): DiagramStyleValues {
  const result: DiagramStyleValues = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.fonts) result.fonts = { ...result.fonts, ...layer.fonts };
    if (layer.colors) result.colors = { ...result.colors, ...layer.colors };
    if (layer.borders) result.borders = { ...result.borders, ...layer.borders };
    if (layer.spacing) result.spacing = { ...result.spacing, ...layer.spacing };
    if (layer.background) result.background = { ...result.background, ...layer.background };
    if (layer.orientation !== undefined) result.orientation = layer.orientation;
    if (layer.scale !== undefined) result.scale = layer.scale;
  }
  return result;
}

/** Field-by-field precedence: type base → project theme → entity → workspace view. */
export function resolveDiagramStyle(layers: DiagramStyleLayers): DiagramStyleValues {
  return mergeValues(layers.typeBase, layers.projectTheme, layers.entity, layers.view);
}

export function diagramStyleLayer(value: unknown): DiagramStyleValues | undefined {
  if (!object(value)) return undefined;
  const issues = validateDiagramStyleProfile({ schemaVersion: '1.0.0', engine: 'a3-native', theme: 'default', ...value });
  return issues.length ? undefined : value as DiagramStyleValues;
}

function setPath(target: Record<string, unknown>, group: string, key: string, value: unknown): void {
  const current = object(target[group]) ? target[group] as Record<string, unknown> : {};
  target[group] = { ...current, [key]: value };
}

/** Convert only known, safe fields for a pinned engine and report fields it cannot represent. */
export function adaptDiagramStyle(profile: DiagramStyleProfile, layers: DiagramStyleLayers = {}): DiagramStyleAdaptation {
  const requested = resolveDiagramStyle({ ...layers, projectTheme: mergeValues(themeValues(profile.theme), profile, layers.projectTheme) });
  const supported: string[] = profile.engine === 'a3-native'
    ? ['fonts.family', 'fonts.size', 'colors.background', 'colors.primary', 'colors.secondary', 'colors.text', 'colors.line', 'borders.color', 'borders.width', 'borders.radius', 'background.color']
    : profile.engine === 'mermaid'
      ? ['fonts.family', 'colors.background', 'colors.primary', 'colors.secondary', 'colors.text', 'colors.line', 'borders.color', 'spacing.nodes', 'spacing.ranks', 'background.color']
      : profile.engine === 'plantuml'
        ? ['fonts.family', 'fonts.size', 'colors.background', 'colors.primary', 'colors.text', 'colors.line', 'borders.color', 'background.color']
        : ['fonts.size', 'colors.primary', 'colors.text', 'colors.line', 'borders.color', 'borders.width'];
  const present: string[] = [];
  if (requested.fonts?.family) present.push('fonts.family'); if (requested.fonts?.size !== undefined) present.push('fonts.size');
  for (const key of colorFields) if (requested.colors?.[key] !== undefined) present.push(`colors.${key}`);
  if (requested.borders?.color) present.push('borders.color'); if (requested.borders?.width !== undefined) present.push('borders.width');
  if (requested.borders?.radius !== undefined) present.push('borders.radius'); if (requested.orientation) present.push('orientation');
  if (requested.spacing?.nodes !== undefined) present.push('spacing.nodes'); if (requested.spacing?.ranks !== undefined) present.push('spacing.ranks');
  if (requested.background?.color) present.push('background.color'); if (requested.background?.resourceId) present.push('background.resourceId');
  if (requested.scale !== undefined) present.push('scale');
  if (profile.engine === 'a3-native' && !['default', 'dark', 'forest', 'neutral'].includes(profile.theme) ||
      profile.engine === 'plantuml' && profile.theme !== 'default' ||
      profile.engine === 'mermaid' && !['default', 'base', 'dark', 'forest', 'neutral'].includes(profile.theme)) present.push('theme');
  const compatible = new Set(supported);
  if (profile.engine === 'structurizr' && requested.borders?.width !== undefined && (requested.borders.width < 1 || requested.borders.width > 10)) compatible.delete('borders.width');
  if (profile.engine === 'structurizr' && requested.fonts?.size !== undefined && !Number.isInteger(requested.fonts.size)) compatible.delete('fonts.size');
  const unsupported = present.filter((field) => !compatible.has(field));
  const applied: Record<string, unknown> = {};
  for (const path of present.filter((field) => compatible.has(field))) {
    const [group, key] = path.split('.');
    const value = group === 'orientation' ? requested.orientation : (requested as unknown as Record<string, Record<string, unknown>>)[group!]?.[key!];
    if (group === 'orientation') applied.orientation = value;
    else setPath(applied, group!, key!, value);
  }
  const output: DiagramStyleAdaptation = { engine: profile.engine, applied: applied as DiagramStyleValues,
    unsupported };
  if (profile.engine === 'mermaid') {
    const variables: Record<string, unknown> = {};
    const mapping = { background: 'background', primary: 'primaryColor', secondary: 'secondaryColor', text: 'primaryTextColor', line: 'lineColor' } as const;
    for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) if (requested.colors?.[key]) variables[mapping[key]] = requested.colors[key];
    if (requested.background?.color) variables.background = requested.background.color;
    if (requested.borders?.color) variables.primaryBorderColor = requested.borders.color;
    output.mermaidConfig = { theme: 'base', ...(requested.fonts?.family ? { fontFamily: requested.fonts.family } : {}),
      ...(Object.keys(variables).length ? { themeVariables: variables } : {}), ...(requested.spacing ? { flowchart: {
        ...(requested.spacing.nodes !== undefined ? { nodeSpacing: requested.spacing.nodes } : {}),
        ...(requested.spacing.ranks !== undefined ? { rankSpacing: requested.spacing.ranks } : {}) } } : {}) };
  }
  if (profile.engine === 'plantuml') {
    const quote = (value: string) => `"${value.replace(/["\\\r\n]/g, '')}"`;
    const lines: string[] = [];
    if (requested.background?.color ?? requested.colors?.background) lines.push(`skinparam backgroundColor ${requested.background?.color ?? requested.colors!.background}`);
    if (requested.fonts?.family) lines.push(`skinparam defaultFontName ${quote(requested.fonts.family)}`);
    if (requested.fonts?.size !== undefined) lines.push(`skinparam defaultFontSize ${requested.fonts.size}`);
    if (requested.colors?.primary) lines.push(`skinparam classBackgroundColor ${requested.colors.primary}`);
    if (requested.colors?.text) lines.push(`skinparam defaultFontColor ${requested.colors.text}`);
    if (requested.colors?.line) lines.push(`skinparam ArrowColor ${requested.colors.line}`);
    if (requested.borders?.color) lines.push(`skinparam classBorderColor ${requested.borders.color}`);
    if (lines.length) output.plantUmlSkinparam = lines.join('\n');
  }
  if (profile.engine === 'structurizr') {
    const elementStyle: Record<string, unknown> = { tag: 'Element' };
    if (requested.colors?.primary) elementStyle.background = requested.colors.primary;
    if (requested.colors?.text) elementStyle.color = requested.colors.text;
    if (requested.borders?.color) elementStyle.stroke = requested.borders.color;
    if (requested.borders?.width !== undefined && Number.isInteger(requested.borders.width) && requested.borders.width >= 1 && requested.borders.width <= 10) elementStyle.strokeWidth = requested.borders.width;
    if (requested.fonts?.size !== undefined && Number.isInteger(requested.fonts.size)) elementStyle.fontSize = requested.fonts.size;
    const relationshipStyle: Record<string, unknown> = { tag: 'Relationship' };
    if (requested.colors?.line) relationshipStyle.color = requested.colors.line;
    if (requested.fonts?.size !== undefined && Number.isInteger(requested.fonts.size)) relationshipStyle.fontSize = requested.fonts.size;
    output.structurizrTheme = { name: profile.theme === 'default' ? 'A3 project theme' : profile.theme,
      description: 'A3 declarative diagram style profile; rendering may differ by engine.',
      elements: [elementStyle], relationships: [relationshipStyle] };
  }
  return output;
}

/** Stable, portable JSON. This describes style intent; it does not promise pixel-identical output. */
export function serializeDiagramTheme(profile: DiagramStyleProfile): string {
  const errors = validateDiagramStyleProfile(profile);
  if (errors.length) throw new TypeError(errors.join(' '));
  const adapted = adaptDiagramStyle(profile);
  const declaration: Record<string, JsonValue> = {
    schemaVersion: '1.0.0', name: profile.theme, engine: profile.engine,
    precedence: ['type', 'project-theme', 'entity', 'view'], style: profile as unknown as JsonValue,
    unsupported: adapted.unsupported as unknown as JsonValue,
    ...(adapted.mermaidConfig ? { mermaid: adapted.mermaidConfig as unknown as JsonValue } : {}),
    ...(adapted.plantUmlSkinparam ? { plantuml: { skinparam: adapted.plantUmlSkinparam } as unknown as JsonValue } : {}),
    ...(profile.engine === 'a3-native' ? { a3Native: adapted.applied as unknown as JsonValue } : {}),
    ...(adapted.structurizrTheme ? { structurizr: adapted.structurizrTheme as unknown as JsonValue } : {})
  };
  return `${JSON.stringify(declaration, null, 2)}\n`;
}
