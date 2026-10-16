import { isObject } from './data.js';
import type { JsonValue } from './models.js';

export type StructurizrCategory = 'person' | 'software-system' | 'container' | 'component' | 'deployment-node' | 'instance';
export type StructurizrViewKind = 'context' | 'containers' | 'components' | 'deployment';
export interface StructurizrImportIssue { line: number; source: string; reason: string; code?: 'unsupported' | 'missing-resource' | 'conflict'; }
export interface StructurizrImportElement {
  key: string; externalId: string; category: StructurizrCategory; title: string; description: string; technology: string;
  url: string; external: boolean; parentKey?: string; instanceOfKey?: string; environment?: string;
}
export interface StructurizrImportRelation { key: string; externalId: string; sourceKey: string; targetKey: string; description: string; technology: string; }
export interface StructurizrImportView {
  key: string; kind: StructurizrViewKind; title: string; scopeKey?: string; environment?: string;
  elements: string[]; relations: string[]; positions: Record<string, { x: number; y: number }>;
}
export interface StructurizrImportGraph {
  format: 'structurizr-dsl' | 'structurizr-json'; name: string; description: string;
  elements: StructurizrImportElement[]; relations: StructurizrImportRelation[]; views: StructurizrImportView[];
  unconverted: StructurizrImportIssue[]; missingResources: StructurizrImportIssue[]; idConflicts: StructurizrImportIssue[];
}

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_LINES = 4000;
const MAX_LINE_LENGTH = 1000;
const MAX_ELEMENTS = 1000;
const MAX_RELATIONS = 2000;
const MAX_VIEWS = 100;
const issue = (line: number, source: string, reason: string, code: StructurizrImportIssue['code'] = 'unsupported'): StructurizrImportIssue => ({ line, source, reason, code });
function utf8ByteLength(value: string): number { return encodeURIComponent(value).replace(/%[\da-f]{2}/gi, 'x').length; }

function base(format: StructurizrImportGraph['format'], name = '', description = ''): StructurizrImportGraph {
  return { format, name, description, elements: [], relations: [], views: [], unconverted: [], missingResources: [], idConflicts: [] };
}
function cleanText(value: unknown, max = 20000): string { return typeof value === 'string' ? value.slice(0, max) : ''; }
function lineAt(source: string, position: number): number { return source.slice(0, position).split(/\r\n|\r|\n/).length; }
function mismatchedJsonDelimiterLine(source: string): number | undefined {
  const stack: { char: string; position: number }[] = [];
  let quote = false, escaped = false;
  for (let position = 0; position < source.length; position += 1) {
    const char = source[position]!;
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quote = false; continue; }
    if (char === '"') { quote = true; continue; }
    if (char === '{' || char === '[') stack.push({ char, position });
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop()?.char !== expected) return lineAt(source, position);
    }
  }
  return undefined;
}
function decodeJsonString(value: string): string { try { return JSON.parse(`"${value}"`) as string; } catch { return value; } }
function stableKey(category: string, id: unknown, properties?: unknown): string {
  const property = isObject(properties) ? properties['structurizr.dsl.identifier'] : undefined;
  const stable = typeof property === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(property) ? property : String(id ?? '');
  return `${category}:${stable}`;
}

/** Parse the supported static subset from an already decoded Structurizr workspace JSON. */
export function parseStructurizrJsonImport(source: string): StructurizrImportGraph {
  const graph = base('structurizr-json');
  if (utf8ByteLength(source) > MAX_SOURCE_BYTES) { graph.unconverted.push(issue(1, '', `El workspace supera ${MAX_SOURCE_BYTES} bytes.`)); return graph; }
  let root: unknown;
  try { root = JSON.parse(source) as unknown; }
  catch (error) {
    const message = error instanceof Error ? error.message : 'JSON no válido.';
    const position = Number(message.match(/position\s+(\d+)/i)?.[1] ?? 0);
    const reportedLine = Number(message.match(/\bline\s+(\d+)\s+column\s+\d+/i)?.[1] ?? 0);
    const delimiterLine = mismatchedJsonDelimiterLine(source);
    graph.unconverted.push(issue(reportedLine > 0 ? reportedLine : delimiterLine ?? lineAt(source, Number.isFinite(position) ? position : 0), '', `JSON de Structurizr inválido: ${message.slice(0, 180)}`, 'conflict'));
    return graph;
  }
  if (!isObject(root) || !isObject(root.model)) { graph.unconverted.push(issue(1, '', 'Se requiere un workspace JSON con un objeto model.')); return graph; }
  graph.name = cleanText(root.name, 200) || 'Structurizr workspace';
  graph.description = cleanText(root.description);
  const model = root.model;
  const elementsByExternalId = new Map<string, StructurizrImportElement>();
  const relationExternalIds = new Map<string, StructurizrImportRelation>();
  const addElement = (raw: unknown, category: StructurizrCategory, parentKey?: string, environment?: string): void => {
    if (!isObject(raw) || raw.id === undefined || typeof raw.name !== 'string') return;
    const externalId = String(raw.id), key = stableKey(category, externalId, raw.properties);
    if (elementsByExternalId.has(externalId)) { graph.idConflicts.push(issue(1, externalId, `El ID Structurizr «${externalId}» está repetido.`, 'conflict')); return; }
    const item: StructurizrImportElement = { key, externalId, category, title: raw.name.slice(0, 200), description: cleanText(raw.description),
      technology: cleanText(raw.technology, 1000), url: cleanText(raw.url, 2000), external: String(raw.tags ?? '').split(',').includes('External'),
      ...(parentKey ? { parentKey } : {}), ...(environment ? { environment } : {}) };
    if (category === 'instance' && typeof raw.softwareSystemId === 'string') item.instanceOfKey = `software-system:${raw.softwareSystemId}`;
    elementsByExternalId.set(externalId, item); graph.elements.push(item);
    const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];
    for (const relation of relationships) {
      if (!isObject(relation) || relation.id === undefined || relation.destinationId === undefined) continue;
      const relationId = String(relation.id), relationKey = `relation:${relationId}`;
      if (relationExternalIds.has(relationId)) { graph.idConflicts.push(issue(1, relationId, `El ID de relación Structurizr «${relationId}» está repetido.`, 'conflict')); continue; }
      const parsed: StructurizrImportRelation = { key: relationKey, externalId: relationId, sourceKey: item.key,
        targetKey: `${elementsByExternalId.get(String(relation.destinationId))?.category ?? 'unknown'}:${relation.destinationId}`,
        description: cleanText(relation.description, 20000), technology: cleanText(relation.technology, 1000) };
      // The canonical target key is repaired after all nested elements are indexed.
      (parsed as { targetKey: string }).targetKey = String(relation.destinationId);
      relationExternalIds.set(relationId, parsed); graph.relations.push(parsed);
    }
  };
  const people = Array.isArray(model.people) ? model.people : [];
  for (const item of people) addElement(item, 'person');
  const systems = Array.isArray(model.softwareSystems) ? model.softwareSystems : [];
  for (const rawSystem of systems) {
    if (!isObject(rawSystem)) continue;
    addElement(rawSystem, 'software-system');
    const systemKey = stableKey('software-system', rawSystem.id, rawSystem.properties);
    for (const rawContainer of Array.isArray(rawSystem.containers) ? rawSystem.containers : []) {
      addElement(rawContainer, 'container', systemKey);
      if (!isObject(rawContainer)) continue;
      const containerKey = stableKey('container', rawContainer.id, rawContainer.properties);
      for (const rawComponent of Array.isArray(rawContainer.components) ? rawContainer.components : []) addElement(rawComponent, 'component', containerKey);
    }
  }
  const addDeployment = (nodes: unknown, parentKey: string | undefined, inheritedEnvironment: string): void => {
    if (!Array.isArray(nodes)) return;
    for (const rawNode of nodes) {
      if (!isObject(rawNode)) continue;
      const environment = cleanText(rawNode.environment, 100) || inheritedEnvironment;
      addElement(rawNode, 'deployment-node', parentKey, environment);
      const nodeKey = stableKey('deployment-node', rawNode.id, rawNode.properties);
      for (const instance of Array.isArray(rawNode.instances) ? rawNode.instances : []) addElement(instance, 'instance', nodeKey, environment);
      addDeployment(rawNode.children ?? rawNode.deploymentNodes, nodeKey, environment);
    }
  };
  addDeployment(model.deploymentNodes, undefined, '');
  if (graph.elements.length > MAX_ELEMENTS || graph.relations.length > MAX_RELATIONS) {
    graph.unconverted.push(issue(1, '', 'El workspace supera el límite de elementos o relaciones del importador.')); return graph;
  }
  const byExternalId = new Map(graph.elements.map((item) => [item.externalId, item]));
  for (const relation of graph.relations) {
    const sourceElement = graph.elements.find((item) => item.key === relation.sourceKey);
    const target = byExternalId.get(relation.targetKey);
    if (!sourceElement || !target) { graph.missingResources.push(issue(1, relation.externalId, `La relación «${relation.externalId}» apunta a un elemento ausente.` , 'missing-resource')); continue; }
    relation.targetKey = target.key;
  }

  const viewsRoot = isObject(root.views) ? root.views : {};
  const definitions: [string, StructurizrViewKind][] = [['systemContextViews', 'context'], ['containerViews', 'containers'], ['componentViews', 'components'], ['deploymentViews', 'deployment']];
  for (const [field, kind] of definitions) {
    const entries = Array.isArray(viewsRoot[field]) ? viewsRoot[field] as unknown[] : [];
    for (const rawView of entries) {
      if (!isObject(rawView)) continue;
      const scopeExternal = rawView.softwareSystemId ?? rawView.containerId;
      const scope = scopeExternal === undefined ? undefined : byExternalId.get(String(scopeExternal));
      const key = `${kind}:${cleanText(rawView.key, 100) || String(rawView.id ?? graph.views.length + 1)}`;
      const view: StructurizrImportView = { key, kind, title: cleanText(rawView.title, 200) || cleanText(rawView.description, 200) || graph.name || kind,
        elements: [], relations: [], positions: {}, ...(scope ? { scopeKey: scope.key } : {}) };
      if (kind === 'deployment') view.environment = cleanText(rawView.environment, 100) || 'Unknown';
      const rawElements = Array.isArray(rawView.elements) ? rawView.elements : [];
      for (const rawPlacement of rawElements) {
        if (!isObject(rawPlacement) || rawPlacement.id === undefined) continue;
        const item = byExternalId.get(String(rawPlacement.id));
        if (!item) { graph.missingResources.push(issue(1, String(rawPlacement.id), `La vista «${key}» referencia un elemento no reconocido.`, 'missing-resource')); continue; }
        if (!view.elements.includes(item.key)) view.elements.push(item.key);
        const x = Number(rawPlacement.x), y = Number(rawPlacement.y);
        if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1_000_000 && Math.abs(y) < 1_000_000) view.positions[item.key] = { x, y };
      }
      for (const rawRelation of Array.isArray(rawView.relationships) ? rawView.relationships : []) {
        if (!isObject(rawRelation) || rawRelation.id === undefined) continue;
        const relation = relationExternalIds.get(String(rawRelation.id));
        if (!relation) { graph.missingResources.push(issue(1, String(rawRelation.id), `La vista «${key}» referencia una relación no reconocida.`, 'missing-resource')); continue; }
        if (view.elements.includes(relation.sourceKey) && view.elements.includes(relation.targetKey)) view.relations.push(relation.key);
      }
      if (view.elements.length === 0) graph.unconverted.push(issue(1, key, 'La vista estática no incluye elementos convertibles.'));
      else graph.views.push(view);
      for (const fieldName of ['animations']) if (Array.isArray(rawView[fieldName]) && (rawView[fieldName] as unknown[]).length) graph.unconverted.push(issue(1, key, `La vista contiene ${fieldName} que A3 no convierte.`));
    }
  }
  if (Array.isArray(viewsRoot.dynamicViews) && viewsRoot.dynamicViews.length) graph.unconverted.push(issue(1, 'dynamicViews', 'Las vistas dinámicas ordenadas permanecen en la fuente y no se convierten en esta etapa.'));
  if (graph.views.length > MAX_VIEWS) { graph.views = []; graph.unconverted.push(issue(1, '', 'El workspace supera el límite de 100 vistas estáticas.')); }
  if (isObject(viewsRoot.configuration) && (viewsRoot.configuration.styles || viewsRoot.configuration.themes)) graph.unconverted.push(issue(1, 'views.configuration', 'Temas y estilos originales permanecen en la fuente; la vista A3 usa su estilo C4 incorporado.'));
  if (isObject(root.properties) && typeof root.properties['structurizr.dsl'] === 'string') {
    graph.unconverted.push(issue(1, 'properties.structurizr.dsl', 'La copia DSL codificada en el JSON se conserva; se importa el modelo JSON sin volver a ejecutar DSL.'));
  }
  return graph;
}

function stripDslComment(line: string): string {
  let quote = false, escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote) { escaped = true; continue; }
    if (char === '"') quote = !quote;
    if (!quote && line.slice(index, index + 2) === '//' && line[index - 1] !== ':') return line.slice(0, index);
  }
  return line;
}
function unquote(value: string | undefined): string { return value ? decodeJsonString(value.slice(1, -1)) : ''; }
function dslElementMatch(line: string): RegExpMatchArray | null {
  return line.match(/^(?:([A-Za-z][A-Za-z0-9_]*)\s*=\s*)?(person|softwareSystem|container|component|deploymentNode)\s+("(?:\\.|[^"\\])*")(?:\s+("(?:\\.|[^"\\])*")?\s*("(?:\\.|[^"\\])*")?)?/);
}

/** Parse only the no-execution static DSL subset. Includes, plugins and scripts are diagnostics, never evaluated. */
export function parseStructurizrDslImport(source: string): StructurizrImportGraph {
  const graph = base('structurizr-dsl');
  if (utf8ByteLength(source) > 256 * 1024) { graph.unconverted.push(issue(1, '', 'La fuente DSL supera 256 KiB.')); return graph; }
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length > MAX_LINES) { graph.unconverted.push(issue(1, '', `La fuente supera ${MAX_LINES} líneas.`)); return graph; }
  const trimmed = lines.map((line) => stripDslComment(line).trim());
  const elementByAlias = new Map<string, StructurizrImportElement>();
  const rawRelations: { line: number; source: string; target: string; description: string; technology: string }[] = [];
  const stack: { type: 'model' | 'views' | 'element' | 'view' | 'other'; key?: string; view?: StructurizrImportView; category?: StructurizrCategory }[] = [];
  let sawWorkspace = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const line = trimmed[index]!;
    if (line.length > MAX_LINE_LENGTH) { graph.unconverted.push(issue(index + 1, line.slice(0, 120), 'La línea supera 1000 caracteres.')); continue; }
    if (!line) continue;
    if (/^!include(?:url)?\b/i.test(line)) {
      const target = line.replace(/^!include(?:url)?\s*/i, '').trim();
      if (/^https?:\/\//i.test(target) || /^!includeurl\b/i.test(line)) graph.missingResources.push(issue(index + 1, line, 'Include remoto no descargado: el broker actual deniega network.access; aprueba el permiso cuando exista soporte local seguro.', 'missing-resource'));
      else graph.missingResources.push(issue(index + 1, line, 'Include local no expandido por esta versión; debe incorporarse desde una raíz de proyecto autorizada.', 'missing-resource'));
      continue;
    }
    if (/^!(?:script|plugin)\b/i.test(line)) { graph.unconverted.push(issue(index + 1, line, 'Scripts y plugins DSL nunca se ejecutan en A3; la directiva se conserva en la fuente.')); continue; }
    if (/^workspace\b/.test(line)) {
      sawWorkspace = true;
      const titleMatch = line.match(/^workspace\s+("(?:\\.|[^"\\])*")/);
      graph.name = unquote(titleMatch?.[1]) || 'Structurizr workspace';
      const descriptionMatch = line.match(/^workspace\s+"(?:\\.|[^"\\])*"\s+("(?:\\.|[^"\\])*")/);
      graph.description = unquote(descriptionMatch?.[1]);
      if (line.includes('{')) stack.push({ type: 'other' });
      continue;
    }
    if (/^model\s*\{/.test(line)) { stack.push({ type: 'model' }); continue; }
    if (/^views\s*\{/.test(line)) { stack.push({ type: 'views' }); continue; }
    const modelIndex = stack.findLastIndex((item) => item.type === 'model');
    const viewsIndex = stack.findLastIndex((item) => item.type === 'views');
    const inModel = modelIndex >= 0;
    const activeView = [...stack].reverse().find((item) => item.type === 'view')?.view;
    const relationMatch = inModel && line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*->\s*([A-Za-z][A-Za-z0-9_]*)(?:\s+("(?:\\.|[^"\\])*")?\s*("(?:\\.|[^"\\])*")?)?/);
    if (relationMatch) { rawRelations.push({ line: index + 1, source: relationMatch[1]!, target: relationMatch[2]!, description: unquote(relationMatch[3]), technology: unquote(relationMatch[4]) }); }
    else if (inModel) {
      const elementMatch = dslElementMatch(line);
      if (elementMatch) {
        const alias = elementMatch[1];
        const type = elementMatch[2]!;
        const category: StructurizrCategory = type === 'person' ? 'person' : type === 'softwareSystem' ? 'software-system' : type === 'container' ? 'container' : type === 'component' ? 'component' : 'deployment-node';
        if (!alias) graph.unconverted.push(issue(index + 1, line, 'Este subconjunto requiere alias para mantener IDs estables.'));
        else if (elementByAlias.has(alias)) graph.idConflicts.push(issue(index + 1, line, `El alias «${alias}» está repetido.`, 'conflict'));
        else {
          const parent = [...stack].reverse().find((item) => item.type === 'element' && item.key);
          const title = unquote(elementMatch[3]);
          const element: StructurizrImportElement = { key: `${category}:${alias}`, externalId: alias, category, title, description: unquote(elementMatch[4]), technology: unquote(elementMatch[5]), url: '', external: false,
            ...(parent?.key ? { parentKey: parent.key } : {}) };
          elementByAlias.set(alias, element); graph.elements.push(element);
          if (line.includes('{')) stack.push({ type: 'element', key: element.key, category });
        }
      } else if (!['{', '}'].includes(line) && !line.startsWith('workspace') && !line.startsWith('model')) {
        graph.unconverted.push(issue(index + 1, line, 'Construcción DSL fuera del subconjunto de elementos y relaciones C4; permanece intacta en el archivo.'));
      }
    } else if (viewsIndex >= 0) {
      const dynamicView = line.match(/^dynamic\s+([A-Za-z][A-Za-z0-9_]*)/);
      if (dynamicView) { graph.unconverted.push(issue(index + 1, line, 'Las vistas dinámicas ordenadas permanecen en la fuente y no se convierten en esta etapa.')); if (line.includes('{')) stack.push({ type: 'view', key: `dynamic:${dynamicView[1]}` }); continue; }
      const viewMatch = line.match(/^(systemContext|container|component|deployment)\s+([A-Za-z][A-Za-z0-9_]*)(?:\s+("(?:\\.|[^"\\])*")?)?\s*\{/);
      if (viewMatch) {
        const kind: StructurizrViewKind = viewMatch[1] === 'systemContext' ? 'context' : viewMatch[1] === 'container' ? 'containers' : viewMatch[1] === 'component' ? 'components' : 'deployment';
        const scope = elementByAlias.get(viewMatch[2]!);
        const key = `${kind}:${unquote(viewMatch[3]) || viewMatch[2]}`;
        const view: StructurizrImportView = { key, kind, title: unquote(viewMatch[3]) || key, elements: [], relations: [], positions: {}, ...(scope ? { scopeKey: scope.key } : {}) };
        if (kind === 'deployment') view.environment = viewMatch[2]!;
        graph.views.push(view); stack.push({ type: 'view', key, view }); continue;
      }
      if (activeView) {
        if (/^include\s+\*/.test(line)) { activeView.elements = graph.elements.map((item) => item.key); continue; }
        const includeIds = line.match(/^include\s+(.+)$/)?.[1]?.split(/\s+/) ?? [];
        if (includeIds.length && includeIds[0] !== '*') { for (const alias of includeIds) { const item = elementByAlias.get(alias); if (item) activeView.elements.push(item.key); else graph.missingResources.push(issue(index + 1, alias, `El alias «${alias}» no existe.`, 'missing-resource')); } continue; }
        if (/^autoLayout\b/.test(line)) { graph.unconverted.push(issue(index + 1, line, 'La dirección y los parámetros de layout se conservan en la fuente; A3 no los importa.')); continue; }
        if (/^(?:exclude|title|description|properties|styles|theme)\b/.test(line)) { graph.unconverted.push(issue(index + 1, line, 'La propiedad visual u opción de vista permanece en la fuente.')); continue; }
      }
    }
    if (line.includes('{') && !/^workspace\b|^model\s*\{|^views\s*\{|^(?:systemContext|container|component|deployment)\s/.test(line) && !(inModel && dslElementMatch(line))) stack.push({ type: 'other' });
    const closeCount = [...line].filter((char) => char === '}').length;
    for (let close = 0; close < closeCount; close += 1) stack.pop();
  }
  if (!sawWorkspace) graph.unconverted.push(issue(1, lines[0] ?? '', 'No se encontró un bloque workspace DSL.'));
  for (const raw of rawRelations) {
    const sourceElement = elementByAlias.get(raw.source), targetElement = elementByAlias.get(raw.target);
    if (!sourceElement || !targetElement) { graph.missingResources.push(issue(raw.line, `${raw.source} -> ${raw.target}`, 'La relación refiere a un alias desconocido.', 'missing-resource')); continue; }
    const key = `relation:${raw.source}->${raw.target}:${raw.line}`;
    graph.relations.push({ key, externalId: key, sourceKey: sourceElement.key, targetKey: targetElement.key, description: raw.description, technology: raw.technology });
  }
  for (const view of graph.views) {
    const scope = graph.elements.find((item) => item.key === view.scopeKey);
    const isDescendant = (item: StructurizrImportElement, ancestorKey: string): boolean => {
      let parentKey = item.parentKey;
      const visited = new Set<string>();
      while (parentKey && !visited.has(parentKey)) {
        if (parentKey === ancestorKey) return true;
        visited.add(parentKey);
        parentKey = graph.elements.find((candidate) => candidate.key === parentKey)?.parentKey;
      }
      return false;
    };
    const allowed = (item: StructurizrImportElement): boolean => view.kind === 'context'
      ? ['person', 'software-system'].includes(item.category)
      : view.kind === 'containers' ? ['person', 'software-system'].includes(item.category) || item.category === 'container' && !!scope && isDescendant(item, scope.key)
      : view.kind === 'components' ? ['person', 'software-system', 'container'].includes(item.category) || item.category === 'component' && !!scope && isDescendant(item, scope.key)
      : ['deployment-node', 'instance'].includes(item.category);
    view.elements = graph.elements.filter((item) => view.elements.includes(item.key) && allowed(item)).map((item) => item.key);
    if (!view.elements.length && view.kind !== 'deployment') {
      const defaultItems = view.kind === 'context' ? graph.elements.filter((item) => ['person', 'software-system'].includes(item.category)) :
        view.kind === 'containers' ? graph.elements.filter((item) => ['person', 'software-system'].includes(item.category) || item.category === 'container' && !!scope && isDescendant(item, scope.key)) :
        graph.elements.filter((item) => ['person', 'software-system', 'container'].includes(item.category) || item.category === 'component' && !!scope && isDescendant(item, scope.key));
      view.elements = defaultItems.map((item) => item.key);
    }
    view.relations = graph.relations.filter((rel) => view.elements.includes(rel.sourceKey) && view.elements.includes(rel.targetKey)).map((rel) => rel.key);
    if (!view.scopeKey && view.kind !== 'deployment') graph.unconverted.push(issue(1, view.key, 'No se pudo resolver el ámbito de la vista; se conserva la fuente y se omite esta vista.'));
  }
  graph.views = graph.views.filter((view) => view.elements.length > 0 && (view.kind === 'deployment' || !!view.scopeKey));
  if (graph.elements.length > MAX_ELEMENTS || graph.relations.length > MAX_RELATIONS || graph.views.length > MAX_VIEWS) {
    graph.elements = []; graph.relations = []; graph.views = []; graph.unconverted.push(issue(1, '', 'El workspace supera el límite de elementos, relaciones o vistas.'));
  }
  return graph;
}

export function structurizrGraphToJson(graph: StructurizrImportGraph): JsonValue {
  return JSON.parse(JSON.stringify(graph)) as JsonValue;
}
