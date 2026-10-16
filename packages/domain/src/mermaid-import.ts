import type { DomainRecord, ExtensionMap, JsonValue } from './models.js';
import type { UmlAttribute, UmlMethod, UmlRelationKind, UmlVisibility } from './uml.js';
import type { ErField, ErCardinality } from './er.js';

export type MermaidDiagramFamily = 'flowchart' | 'class' | 'er';
export interface MermaidImportIssue { line: number; source: string; reason: string; }
export interface MermaidImportGraphNode {
  id: string; title: string; family: MermaidDiagramFamily;
  attributes?: UmlAttribute[]; methods?: UmlMethod[]; fields?: ErField[];
}
export interface MermaidImportGraphRelation {
  id: string; source: string; target: string; label: string; family: MermaidDiagramFamily;
  kind?: UmlRelationKind; sourceCardinality?: ErCardinality; targetCardinality?: ErCardinality; identifying?: boolean;
}
export interface MermaidImportGraph {
  family: MermaidDiagramFamily | null; nodes: MermaidImportGraphNode[]; relations: MermaidImportGraphRelation[];
  unconverted: MermaidImportIssue[]; missingResources: MermaidImportIssue[]; idConflicts: MermaidImportIssue[];
}

const plainLabel = /^[^\[\]{}()<>|`"\r\n]{1,200}$/;
const simpleType = /^[A-Za-z_][A-Za-z0-9_.<>\[\]]{0,99}$/;
const candidateResource = /\b(?:href|img|image|icon)\s*[:=]\s*["']?([^"'\s,)]+)/i;

function issue(line: number, source: string, reason: string): MermaidImportIssue { return { line, source, reason }; }
function labelValue(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}
function splitFlowToken(raw: string): { id: string; title: string; shape: 'rect' | 'round' | 'diamond' } | undefined {
  const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_-]{0,63})(?:\[([^\]]*)\]|\(([^()]*)\)|\{([^{}]*)\})?$/);
  if (!match) return undefined;
  const candidate = match[2] ?? match[3] ?? match[4];
  if (candidate !== undefined && !plainLabel.test(labelValue(candidate, ''))) return undefined;
  return { id: match[1]!, title: labelValue(candidate, match[1]!).trim() || match[1]!, shape: match[3] !== undefined ? 'round' : match[4] !== undefined ? 'diamond' : 'rect' };
}
function parseFlowLine(line: string): { left: ReturnType<typeof splitFlowToken>; right: ReturnType<typeof splitFlowToken>; label: string } | undefined {
  const match = line.match(/^(.+?)\s+(?:--\s+([^\n-][^\n]*?)\s+)?-->\s+(.+)$/);
  if (!match) return undefined;
  const left = splitFlowToken(match[1]!); const right = splitFlowToken(match[3]!);
  const edgeLabel = match[2]?.trim() ?? '';
  if (!left || !right || edgeLabel && !plainLabel.test(labelValue(edgeLabel, ''))) return undefined;
  return { left, right, label: labelValue(edgeLabel, '').trim() };
}
function memberVisibility(prefix: string | undefined): UmlVisibility {
  return prefix === '+' ? 'public' : prefix === '#' ? 'protected' : prefix === '-' ? 'private' : 'package';
}
function uidKey(kind: string, sourceId: string): string { return `${kind}:${sourceId}`; }

/** A deliberately small line-oriented grammar. It never calls Mermaid's renderer or evaluates diagram directives. */
export function parseMermaidImport(source: string): MermaidImportGraph {
  const result: MermaidImportGraph = { family: null, nodes: [], relations: [], unconverted: [], missingResources: [], idConflicts: [] };
  if (typeof source !== 'string' || source.length > 128_000) {
    result.unconverted.push(issue(1, '', 'La fuente supera 128000 caracteres o no es texto.'));
    return result;
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 4000) {
    result.unconverted.push(issue(4001, '', 'El subconjunto admite hasta 4000 líneas.'));
    return result;
  }
  const header = lines[0]?.trim() ?? '';
  const family = /^flowchart\s+(?:TB|TD|BT|RL|LR)$/i.test(header) ? 'flowchart' :
    /^classDiagram$/i.test(header) ? 'class' : /^erDiagram$/i.test(header) ? 'er' : null;
  result.family = family;
  if (!family) {
    result.unconverted.push(issue(1, lines[0] ?? '', 'La cabecera debe ser flowchart TB/TD/BT/RL/LR, classDiagram o erDiagram.'));
    for (const [index, text] of lines.entries()) { const resource = text.match(candidateResource); if (resource) result.missingResources.push(issue(index + 1, text, `Recurso «${resource[1]}» no resuelto; la importación no carga recursos.`)); }
    return result;
  }

  const nodes = new Map<string, MermaidImportGraphNode>();
  const relationKeys = new Set<string>();
  const explicitFlowLabels = new Set<string>();
  const reportedFlowVisuals = new Set<string>();
  const conflictingIdSpellings = new Set<string>();
  const markConflict = (line: number, text: string, reason: string) => result.idConflicts.push(issue(line, text, reason));
  const markUnsupported = (line: number, text: string, reason: string) => result.unconverted.push(issue(line, text, reason));
  let currentLine = 1, currentText = '';
  const ensureNode = (id: string, title = id): MermaidImportGraphNode => {
    const key = id.toLowerCase();
    let node = nodes.get(key);
    if (node && node.id !== id && !conflictingIdSpellings.has(key)) {
      conflictingIdSpellings.add(key);
      markConflict(currentLine, currentText, `El identificador «${id}» cambia mayúsculas/minúsculas respecto a «${node.id}»; no se combinará silenciosamente.`);
    }
    if (!node) {
      node = { id, title, family, ...(family === 'class' ? { attributes: [], methods: [] } : family === 'er' ? { fields: [] } : {}) };
      nodes.set(key, node);
    }
    return node;
  };
  const addRelation = (relation: MermaidImportGraphRelation, line: number, text: string) => {
    const key = relation.id.toLowerCase();
    if (relationKeys.has(key)) { markConflict(line, text, `Relación duplicada «${relation.id}»; no se asigna una identidad ambigua.`); return; }
    relationKeys.add(key); result.relations.push(relation);
  };

  let erBlock: MermaidImportGraphNode | null = null;
  for (let index = 1; index < lines.length; index++) {
    currentLine = index + 1;
    const text = lines[index]!.trim();
    currentText = text;
    if (!text || text.startsWith('%%') && !text.startsWith('%%{')) continue;
    if (text.startsWith('%%{')) { markUnsupported(index + 1, text, 'Las directivas de configuración Mermaid se conservan en la fuente y no se aplican al modelo A3.'); continue; }
    const resource = text.match(candidateResource);
    if (resource) result.missingResources.push(issue(index + 1, text, `Recurso «${resource[1]}» no resuelto; no se descarga ni sigue durante la importación.`));
    if (text.length > 1000) { markUnsupported(index + 1, text, 'La línea supera el límite de 1000 caracteres.'); continue; }

    if (family === 'flowchart') {
      const edge = parseFlowLine(text);
      if (edge) {
        for (const endpoint of [edge.left, edge.right]) {
          if (endpoint!.shape !== 'rect' && !reportedFlowVisuals.has(`${index + 1}:${endpoint!.id}`)) {
            reportedFlowVisuals.add(`${index + 1}:${endpoint!.id}`);
            markUnsupported(index + 1, text, `La forma ${endpoint!.shape} del nodo «${endpoint!.id}» es visual y no se convierte al modelo conceptual.`);
          }
          const old = nodes.get(endpoint!.id.toLowerCase());
          const key = endpoint!.id.toLowerCase();
          if (endpoint!.title !== endpoint!.id) {
            if (explicitFlowLabels.has(key) && old?.title !== endpoint!.title) markConflict(index + 1, text, `El identificador «${endpoint!.id}» tiene etiquetas incompatibles.`);
            else { ensureNode(endpoint!.id, endpoint!.title).title = endpoint!.title; explicitFlowLabels.add(key); }
          } else ensureNode(endpoint!.id);
        }
        addRelation({ id: `${edge.left!.id}->${edge.right!.id}:${edge.label}`, source: edge.left!.id, target: edge.right!.id, label: edge.label, family }, index + 1, text);
        continue;
      }
      const token = splitFlowToken(text);
      if (token) {
        if (token.shape !== 'rect') markUnsupported(index + 1, text, `La forma ${token.shape} del nodo «${token.id}» es visual y no se convierte al modelo conceptual.`);
        const key = token.id.toLowerCase(), old = nodes.get(key);
        if (token.title !== token.id && explicitFlowLabels.has(key) && old?.title !== token.title) markConflict(index + 1, text, `El identificador «${token.id}» está declarado con etiquetas distintas.`);
        else { ensureNode(token.id, token.title).title = token.title; if (token.title !== token.id) explicitFlowLabels.add(key); }
        continue;
      }
      markUnsupported(index + 1, text, 'Fuera del subconjunto flowchart: solo declaraciones simples y aristas dirigidas -- > con etiquetas literales.');
      continue;
    }

    if (family === 'class') {
      const declaration = text.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)$/);
      if (declaration) { ensureNode(declaration[1]!); continue; }
      const member = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([+#~-])?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^()]*)\)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]*)|:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]*))$/);
      if (member) {
        const owner = ensureNode(member[1]!);
        if (member[4] !== undefined) {
          const params: { id: string; name: string; type: { name: string }; direction: 'in'; defaultValue: string }[] = [];
          let valid = true;
          if (member[4]!.trim()) for (const part of member[4]!.split(',')) {
            const parameter = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]*)$/);
            if (!parameter) { valid = false; break; }
            params.push({ id: '', name: parameter[1]!, type: { name: parameter[2]! }, direction: 'in', defaultValue: '' });
          }
          if (!valid || !simpleType.test(member[5]!)) { markUnsupported(index + 1, text, 'Los métodos solo admiten parámetros con nombre y tipo simple, y retorno simple.'); continue; }
          const existing = owner.methods!.some((item) => item.name === member[3]);
          if (existing) { markConflict(index + 1, text, `Miembro UML repetido «${member[1]}.${member[3]}»; no se puede mapear por nombre.`); continue; }
          const methodId = uidKey('method', `${member[1]}:${member[3]}`);
          owner.methods!.push({ id: methodId, name: member[3]!, returnType: { name: member[5]! }, visibility: memberVisibility(member[2]), static: false, abstract: false,
            parameters: params.map((item) => ({ ...item, id: uidKey('parameter', `${member[1]}:${member[3]}:${item.name}`) })) });
          continue;
        }
        const type = member[6]!;
        if (!simpleType.test(type)) { markUnsupported(index + 1, text, 'El tipo de atributo no pertenece a la gramática simple.'); continue; }
        if (owner.attributes!.some((item) => item.name === member[3])) { markConflict(index + 1, text, `Atributo UML repetido «${member[1]}.${member[3]}»; no se puede mapear por nombre.`); continue; }
        owner.attributes!.push({ id: uidKey('attribute', `${member[1]}:${member[3]}`), name: member[3]!, type: { name: type }, visibility: memberVisibility(member[2]), static: false, readOnly: false, defaultValue: '' });
        continue;
      }
      const relation = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|\.\.>|<\.\.|-->)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^<>|]{1,200}))?$/);
      if (relation) {
        const left = relation[1]!, symbol = relation[2]!, right = relation[3]!, label = relation[4]?.trim() ?? '';
        const kind: UmlRelationKind = symbol.includes('<|') || symbol.includes('|>') ? 'generalization' : symbol.includes('*') ? 'composition' : symbol.includes('o') ? 'aggregation' : symbol.includes('..') ? 'dependency' : 'association';
        const source = symbol.startsWith('<') || symbol.endsWith('*') || symbol.endsWith('o') ? right : left;
        const target = source === left ? right : left;
        ensureNode(left); ensureNode(right);
        addRelation({ id: `${kind}:${source}->${target}:${label}`, source, target, label, family, kind }, index + 1, text);
        continue;
      }
      markUnsupported(index + 1, text, 'Fuera del subconjunto classDiagram: class, atributos, métodos simples y relaciones enumeradas.');
      continue;
    }

    // ER grammar: one table block at a time, scalar field type/name/marker, and the six standard cardinality markers.
    if (erBlock) {
      if (text === '}') { erBlock = null; continue; }
      const field = text.match(/^([A-Za-z][A-Za-z0-9_]*(?:\([0-9]+(?:,[0-9]+)?\))?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:(PK|FK|UK))?$/i);
      if (!field) { markUnsupported(index + 1, text, 'El campo ER solo admite tipo escalar, nombre y un marcador PK/FK/UK.'); continue; }
      if (erBlock.fields!.some((item) => item.name.toLowerCase() === field[2]!.toLowerCase())) { markConflict(index + 1, text, `Campo ER duplicado «${erBlock.id}.${field[2]}».`); continue; }
      const marker = field[3]?.toUpperCase();
      if (marker === 'FK') { markUnsupported(index + 1, text, 'FK no se convierte porque Mermaid no aporta una referencia de campo destino verificable.'); continue; }
      erBlock.fields!.push({ id: uidKey('field', `${erBlock.id}:${field[2]}`), name: field[2]!, type: field[1]!, nullable: marker !== 'PK', primaryKey: marker === 'PK', unique: marker === 'UK' });
      continue;
    }
    const table = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\{$/);
    if (table) { erBlock = ensureNode(table[1]!); continue; }
    const relation = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(\|\||o\||\}\||\}o)(--|\.\.)(\|\||\|o|\|\{|o\{)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^\r\n]{1,200}))?$/);
    if (relation) {
      const card = (value: string): ErCardinality => value === '||' ? 'one' : value === 'o|' || value === '|o' ? 'zero-or-one' : value === '}|' || value === '|{' ? 'many' : 'zero-or-many';
      const left = relation[1]!, right = relation[5]!, label = relation[6]?.trim() ?? '';
      ensureNode(left); ensureNode(right);
      addRelation({ id: `relation:${left}->${right}:${label}`, source: left, target: right, label, family,
        sourceCardinality: card(relation[2]!), targetCardinality: card(relation[4]!), identifying: relation[3] === '--' }, index + 1, text);
      continue;
    }
    markUnsupported(index + 1, text, 'Fuera del subconjunto erDiagram: bloques de campos escalares y relaciones con cardinalidades explícitas.');
  }
  if (erBlock) markUnsupported(lines.length, '', `Bloque de entidad «${erBlock.id}» sin cierre.`);
  if (nodes.size > 500 || result.relations.length > 500) {
    result.unconverted.push(issue(1, header, 'El subconjunto admite hasta 500 nodos y 500 relaciones; reduzca el diagrama antes de importar.'));
    result.nodes = []; result.relations = [];
  } else {
    result.nodes = [...nodes.values()];
  }
  return result;
}

export interface MermaidImportIdentityMap { [sourceKey: string]: string; }
export interface MermaidImportRecords { records: DomainRecord[]; mapping: MermaidImportIdentityMap; }
function marker(sourceEntityId: string, key: string): ExtensionMap { return { 'a3.mermaid.import': { sourceEntityId, sourceKey: key } }; }
function mapId(mapping: MermaidImportIdentityMap, key: string): string {
  const value = mapping[key];
  if (!value) throw new TypeError(`Falta identidad mapeada para ${key}.`);
  return value;
}
function position(index: number): { x: number; y: number } { return { x: (index % 4) * 360, y: Math.floor(index / 4) * 280 }; }
function baseEntity(id: string, type: string, title: string, properties: ExtensionMap, extensions: ExtensionMap) {
  return { schemaVersion: '1.0.0', id, revision: 1, type, typeVersion: '1.0.0', title, tags: [], properties, ports: [], bindings: {}, extensions };
}

/** Builds native, typed records from the accepted subset without rewriting the source Resource. */
export function buildMermaidImportRecords(graph: MermaidImportGraph, workspaceId: string, sourceEntityId: string, mapping: MermaidImportIdentityMap): MermaidImportRecords {
  if (!graph.family || graph.idConflicts.length) throw new TypeError('La fuente contiene conflictos de identidad o no tiene una familia admitida.');
  const records: DomainRecord[] = [];
  const entityFor = new Map<string, string>(), placementFor = new Map<string, string>();
  for (const node of graph.nodes) {
    const key = `node:${node.id}`;
    entityFor.set(node.id.toLowerCase(), mapId(mapping, `entity:${key}`));
    placementFor.set(node.id.toLowerCase(), mapId(mapping, `placement:${key}`));
  }
  graph.nodes.forEach((node, index) => {
    const key = `node:${node.id}`; const entityId = mapId(mapping, `entity:${key}`), placementId = mapId(mapping, `placement:${key}`);
    let type: string, properties: ExtensionMap;
    if (graph.family === 'flowchart') {
      type = 'a3.conceptual.idea'; properties = {};
    } else if (graph.family === 'class') {
      type = 'a3.uml.class';
      const attrs = node.attributes ?? [], methods = node.methods ?? [];
      for (const attr of attrs) {
        const target = entityFor.get(attr.type.name.toLowerCase());
        if (target) attr.type.entityId = target;
        attr.id = mapId(mapping, `member:attribute:${node.id}:${attr.name}`);
      }
      for (const method of methods) for (const item of [method.returnType, ...method.parameters.map((parameter) => parameter.type)]) {
        const target = entityFor.get(item.name.toLowerCase());
        if (target) item.entityId = target;
      }
      for (const method of methods) {
        method.id = mapId(mapping, `member:method:${node.id}:${method.name}`);
        for (const parameter of method.parameters) parameter.id = mapId(mapping, `member:parameter:${node.id}:${method.name}:${parameter.name}`);
      }
      properties = { 'a3.uml': { description: '', abstract: false, visibility: 'public', stereotypes: [], constraints: [], attributes: attrs as unknown as JsonValue, methods: methods as unknown as JsonValue, literals: [] } };
    } else {
      type = 'a3.er.table'; properties = { 'a3.er': { description: '', fields: (node.fields ?? []) as unknown as JsonValue } };
      for (const field of node.fields ?? []) field.id = mapId(mapping, `member:field:${node.id}:${field.name}`);
    }
    records.push({ kind: 'entity', value: baseEntity(entityId, type, node.title, properties, marker(sourceEntityId, key)) });
    records.push({ kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id: placementId, revision: 1, entityId, position: position(index), size: { width: 340, height: 240 }, style: {}, extensions: marker(sourceEntityId, key) } });
  });
  graph.relations.forEach((relation) => {
    const key = `relation:${relation.id}`, relationId = mapId(mapping, `relation:${key}`), relationViewId = mapId(mapping, `relationView:${key}`);
    const sourceId = entityFor.get(relation.source.toLowerCase()), targetId = entityFor.get(relation.target.toLowerCase());
    const sourcePlacementId = placementFor.get(relation.source.toLowerCase()), targetPlacementId = placementFor.get(relation.target.toLowerCase());
    if (!sourceId || !targetId || !sourcePlacementId || !targetPlacementId) throw new TypeError(`Relación ${relation.id} apunta a un nodo no convertido.`);
    if (graph.family === 'flowchart') {
      records.push({ kind: 'relation', value: { schemaVersion: '1.0.0', id: relationId, revision: 1, type: 'a3.conceptual.relationship', typeVersion: '1.0.0', source: { entityId: sourceId }, target: { entityId: targetId },
        properties: { 'a3.conceptual.label': relation.label || 'conecta', 'a3.conceptual.kind': 'association' }, extensions: marker(sourceEntityId, key) } });
    } else if (graph.family === 'class') {
      const kind = relation.kind ?? 'association';
      records.push({ kind: 'relation', value: { schemaVersion: '1.0.0', id: relationId, revision: 1, type: `a3.uml.${kind}`, typeVersion: '1.0.0', source: { entityId: sourceId }, target: { entityId: targetId },
        properties: { 'a3.uml': { label: relation.label, source: { role: '', multiplicity: { lower: 0, upper: kind === 'composition' ? 1 : '*' }, navigable: false }, target: { role: '', multiplicity: { lower: 0, upper: '*' }, navigable: false }, stereotypes: [], constraints: [] } }, extensions: marker(sourceEntityId, key) } });
    } else {
      records.push({ kind: 'relation', value: { schemaVersion: '1.0.0', id: relationId, revision: 1, type: 'a3.er.relationship', typeVersion: '1.0.0', source: { entityId: sourceId }, target: { entityId: targetId },
        properties: { 'a3.er': { label: relation.label, sourceCardinality: relation.sourceCardinality ?? 'one', targetCardinality: relation.targetCardinality ?? 'many', identifying: relation.identifying ?? true } }, extensions: marker(sourceEntityId, key) } });
    }
    records.push({ kind: 'relation-view', workspaceId, value: { schemaVersion: '1.0.0', id: relationViewId, revision: 1, relationId, sourcePlacementId, targetPlacementId, waypoints: [], style: {}, extensions: marker(sourceEntityId, key) } });
  });
  return { records, mapping: { ...mapping } };
}

export function requiredMermaidMapping(graph: MermaidImportGraph): string[] {
  const keys = graph.nodes.flatMap((node) => {
    const key = `node:${node.id}`;
    const members = graph.family === 'class' ? [
      ...(node.attributes ?? []).map((item) => `member:attribute:${node.id}:${item.name}`),
      ...(node.methods ?? []).flatMap((item) => [`member:method:${node.id}:${item.name}`, ...item.parameters.map((parameter) => `member:parameter:${node.id}:${item.name}:${parameter.name}`)])
    ] : graph.family === 'er' ? (node.fields ?? []).map((item) => `member:field:${node.id}:${item.name}`) : [];
    return [`entity:${key}`, `placement:${key}`, ...members];
  });
  return [...keys, ...graph.relations.flatMap((relation) => { const key = `relation:${relation.id}`; return [`relation:${key}`, `relationView:${key}`]; })];
}
