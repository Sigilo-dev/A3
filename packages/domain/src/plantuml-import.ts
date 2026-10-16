import type { MermaidImportGraph, MermaidImportGraphNode, MermaidImportGraphRelation, MermaidImportIssue } from './mermaid-import.js';

const simpleType = /^[A-Za-z_][A-Za-z0-9_.<>\[\]]{0,99}$/;
const simpleLabel = /^[^\r\n<>|`"\\]{1,160}$/;
const relationPattern = /^([A-Za-z_][A-Za-z0-9_]{0,63})\s+(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|\.\.>|-->|\.\.|--)\s+([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*:\s*(.+))?$/;

function issue(line: number, source: string, reason: string): MermaidImportIssue { return { line, source, reason }; }
function visibility(symbol: string | undefined): 'public' | 'protected' | 'private' | 'package' {
  return symbol === '+' ? 'public' : symbol === '#' ? 'protected' : symbol === '-' ? 'private' : 'package';
}
function typeName(value: string): boolean { return simpleType.test(value); }

/** A conservative, non-executing PlantUML parser. Unrecognized syntax remains in the original resource. */
export function parsePlantUmlClassImport(source: string): MermaidImportGraph {
  const result: MermaidImportGraph = { family: null, nodes: [], relations: [], unconverted: [], missingResources: [], idConflicts: [] };
  if (typeof source !== 'string' || source.length > 128_000) {
    result.unconverted.push(issue(1, '', 'La fuente supera el límite de 128000 caracteres o no es texto.'));
    return result;
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 4000) {
    result.unconverted.push(issue(4001, '', 'El subconjunto admite hasta 4000 líneas.'));
    return result;
  }
  const startLines = lines.map((line, index) => /^\s*@startuml\s*$/.test(line) ? index : -1).filter((index) => index >= 0);
  const endLines = lines.map((line, index) => /^\s*@enduml\s*$/.test(line) ? index : -1).filter((index) => index >= 0);
  if (startLines.length !== 1 || endLines.length !== 1 || startLines[0]! >= endLines[0]!) {
    result.unconverted.push(issue(1, lines[0] ?? '', 'Se requiere un único bloque delimitado exactamente por @startuml y @enduml.'));
    for (const [index, line] of lines.entries()) if (line.trim()) result.unconverted.push(issue(index + 1, line.trim(), 'La línea no pertenece a un bloque PlantUML de clases reconocido.'));
    return result;
  }
  const start = startLines[0]!, end = endLines[0]!;
  result.family = 'class';
  for (let index = 0; index < start; index++) if (lines[index]!.trim()) result.unconverted.push(issue(index + 1, lines[index]!.trim(), 'Se conserva texto fuera del bloque PlantUML.'));
  for (let index = end + 1; index < lines.length; index++) if (lines[index]!.trim()) result.unconverted.push(issue(index + 1, lines[index]!.trim(), 'Se conserva texto fuera del bloque PlantUML.'));

  const nodes = new Map<string, MermaidImportGraphNode>();
  const explicitKinds = new Map<string, 'class' | 'interface'>();
  const relationKeys = new Set<string>();
  const relationLines = new Map<string, number>();
  const conflicted = new Set<string>();
  let current: MermaidImportGraphNode | null = null;
  let opaqueBlockDepth = 0;
  let insideNote = false;
  let currentLine = 1;
  let currentText = '';
  const unsupported = (line: number, text: string, reason: string): void => { result.unconverted.push(issue(line, text, reason)); };
  const conflict = (line: number, text: string, reason: string): void => { result.idConflicts.push(issue(line, text, reason)); };
  const ensureNode = (id: string): MermaidImportGraphNode => {
    const key = id.toLowerCase();
    let node = nodes.get(key);
    if (!node) {
      node = { id, title: id, family: 'class', umlKind: 'class', attributes: [], methods: [] };
      nodes.set(key, node);
    } else if (node.id !== id && !conflicted.has(key)) {
      conflicted.add(key);
      conflict(currentLine, currentText, `El identificador «${id}» cambia mayúsculas/minúsculas respecto a «${node.id}»; se conserva sin combinarlo.`);
    }
    return node;
  };
  const addRelation = (left: string, symbol: string, right: string, label: string): void => {
    let kind: NonNullable<MermaidImportGraphRelation['kind']>;
    let from = left, to = right;
    switch (symbol) {
      case '<|--': kind = 'generalization'; from = right; to = left; break;
      case '--|>': kind = 'generalization'; break;
      case '<|..': kind = 'realization'; from = right; to = left; break;
      case '..|>': kind = 'realization'; break;
      case '*--': kind = 'composition'; break;
      case '--*': kind = 'composition'; from = right; to = left; break;
      case 'o--': kind = 'aggregation'; break;
      case '--o': kind = 'aggregation'; from = right; to = left; break;
      case '..>': case '..': kind = 'dependency'; break;
      default: kind = 'association';
    }
    ensureNode(left); ensureNode(right);
    const id = `${kind}:${from}->${to}:${label}`;
    const key = id.toLowerCase();
    if (relationKeys.has(key)) { conflict(currentLine, currentText, 'La relación aparece más de una vez y no se puede mapear de forma estable.'); return; }
    relationKeys.add(key);
    result.relations.push({ id, source: from, target: to, label, family: 'class', kind });
    relationLines.set(key, currentLine);
  };

  for (let index = start + 1; index < end; index++) {
    currentLine = index + 1;
    const text = lines[index]!.trim();
    currentText = text;
    if (!text || text.startsWith("'")) continue;
    if (text.length > 1000) { unsupported(currentLine, text, 'La línea supera el límite de 1000 caracteres.'); continue; }
    if (text === '@enduml' || text === '@startuml') { unsupported(currentLine, text, 'No se admiten bloques PlantUML anidados.'); continue; }
    if (insideNote) {
      unsupported(currentLine, text, 'Las notas y su contenido permanecen en la fuente; no se modelan en esta conversión.');
      if (/^end\s+note\b/i.test(text)) insideNote = false;
      continue;
    }
    const include = text.match(/^!(include\w*)\s+(.+)$/i);
    if (include) {
      unsupported(currentLine, text, 'El importador no sigue ni ejecuta includes; la directiva completa permanece en la fuente.');
      result.missingResources.push(issue(currentLine, text, `Include «${include[2]!.trim()}» no resuelto por el importador; no se lee ni se descarga.`));
      continue;
    }
    if (/%load_json\s*\(/i.test(text)) {
      unsupported(currentLine, text, 'La carga de JSON no se ejecuta durante la importación; la directiva permanece en la fuente.');
      result.missingResources.push(issue(currentLine, text, 'Recurso JSON no resuelto por el importador; no se lee ni se descarga.'));
      continue;
    }
    if (/^note\b/i.test(text)) {
      const inlineNote = /:\s*\S/.test(text);
      insideNote = !inlineNote && !/\bend\s+note\b/i.test(text);
      unsupported(currentLine, text, 'Las notas permanecen en la fuente; no se modelan en esta conversión.');
      continue;
    }
    if (opaqueBlockDepth > 0) {
      unsupported(currentLine, text, 'El contenido de un bloque no admitido permanece en la fuente y no se convierte por separado.');
      opaqueBlockDepth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
      if (opaqueBlockDepth < 0) opaqueBlockDepth = 0;
      continue;
    }
    if (current) {
      if (text === '}') { current = null; continue; }
      const member = text.match(/^([+#~-])?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^()]*)\)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]{0,99})|:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]{0,99}))$/);
      if (!member) { unsupported(currentLine, text, 'El compartimento solo admite atributos y métodos simples con tipo explícito.'); continue; }
      const [, access, name, rawParameters, returnType, attributeType] = member;
      if (rawParameters !== undefined) {
        const params: { id: string; name: string; type: { name: string }; direction: 'in'; defaultValue: string }[] = [];
        let valid = !!returnType && typeName(returnType);
        if (rawParameters.trim()) for (const parameterText of rawParameters.split(',')) {
          const parameter = parameterText.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>\[\]]{0,99})$/);
          if (!parameter || params.some((item) => item.name === parameter[1])) { valid = false; break; }
          params.push({ id: '', name: parameter[1]!, type: { name: parameter[2]! }, direction: 'in', defaultValue: '' });
        }
        if (!valid) { unsupported(currentLine, text, 'El método exige parámetros con nombre/tipo y retorno simple o una firma sin ambigüedad.'); continue; }
        if (current.methods!.some((item) => item.name === name)) { conflict(currentLine, text, `Método duplicado o sobrecargado «${current.id}.${name}»; el subconjunto no puede mapearlo de forma estable.`); continue; }
        current.methods!.push({ id: `method:${current.id}:${name}`, name: name!, returnType: { name: returnType! }, visibility: visibility(access), static: false, abstract: false,
          parameters: params.map((item) => ({ ...item, id: `parameter:${current!.id}:${name}:${item.name}` })) });
      } else {
        if (current.attributes!.some((item) => item.name === name)) { conflict(currentLine, text, `Atributo duplicado «${current.id}.${name}»; no se asigna una identidad ambigua.`); continue; }
        current.attributes!.push({ id: `attribute:${current.id}:${name}`, name: name!, type: { name: attributeType! }, visibility: visibility(access), static: false, readOnly: false, defaultValue: '' });
      }
      continue;
    }
    const declaration = text.match(/^(class|interface)\s+([A-Za-z_][A-Za-z0-9_]{0,63})\s*(\{)?$/i);
    if (declaration) {
      const kind = declaration[1]!.toLowerCase() as 'class' | 'interface';
      const id = declaration[2]!;
      const node = ensureNode(id);
      const oldKind = explicitKinds.get(id.toLowerCase());
      if (oldKind && oldKind !== kind) conflict(currentLine, text, `«${id}» se declara como ${oldKind} y ${kind}; no se elige un tipo automáticamente.`);
      else { explicitKinds.set(id.toLowerCase(), kind); node.umlKind = kind; }
      if (declaration[3]) current = node;
      continue;
    }
    if (text.includes('{')) {
      unsupported(currentLine, text, 'Este bloque estructurado de PlantUML no pertenece al subconjunto; su contenido se conserva sin convertirlo.');
      opaqueBlockDepth = Math.max(1, (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length);
      continue;
    }
    const relation = text.match(relationPattern);
    if (relation) {
      const [, left, symbol, right, rawLabel] = relation;
      const label = rawLabel?.trim() ?? '';
      if (label && !simpleLabel.test(label)) { unsupported(currentLine, text, 'La etiqueta de relación debe ser texto simple en una sola línea, sin sintaxis PlantUML.'); continue; }
      addRelation(left!, symbol!, right!, label);
      continue;
    }
    unsupported(currentLine, text, 'Fuera del subconjunto: solo class/interface, atributos y métodos simples, y relaciones básicas UML. La sintaxis se conserva en la fuente.');
  }
  if (current) unsupported(currentLine, '', `El compartimento de «${current.id}» no se cerró.`);
  const byId = new Map([...nodes.values()].map((node) => [node.id.toLowerCase(), node]));
  const inheritance = new Map<string, string[]>();
  for (const relation of result.relations) {
    const sourceNode = byId.get(relation.source.toLowerCase()), targetNode = byId.get(relation.target.toLowerCase());
    const line = relationLines.get(relation.id.toLowerCase()) ?? 1;
    const text = lines[line - 1]?.trim() ?? '';
    if (relation.kind === 'generalization') {
      if (!sourceNode || !targetNode || sourceNode.umlKind !== targetNode.umlKind) {
        conflict(line, text, 'La generalización debe conectar dos clases o dos interfaces; no se adivina el clasificador.');
      }
      const parents = inheritance.get(relation.source.toLowerCase()) ?? [];
      parents.push(relation.target.toLowerCase()); inheritance.set(relation.source.toLowerCase(), parents);
    } else if (relation.kind === 'realization' && (sourceNode?.umlKind !== 'class' || targetNode?.umlKind !== 'interface')) {
      conflict(line, text, 'La realización básica exige clase implementadora e interfaz destino explícitas.');
    } else if (['aggregation', 'composition'].includes(relation.kind ?? '') && sourceNode?.umlKind !== 'class') {
      conflict(line, text, 'El extremo con diamante debe ser un todo de tipo class; la interfaz no puede ocupar ese extremo.');
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const parent of inheritance.get(id) ?? []) if (hasCycle(parent)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if ([...inheritance.keys()].some(hasCycle)) conflict(1, '@startuml', 'La jerarquía de generalización no puede contener ciclos.');
  if (nodes.size > 500 || result.relations.length > 500) {
    result.unconverted.push(issue(1, '@startuml', 'El subconjunto admite hasta 500 clasificadores y 500 relaciones.'));
    result.nodes = []; result.relations = [];
  } else result.nodes = [...nodes.values()];
  return result;
}
