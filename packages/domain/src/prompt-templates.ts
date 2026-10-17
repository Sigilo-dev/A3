import { isJson, isObject, NAMESPACE_PATTERN } from './data.js';
import type { DomainSnapshot, JsonValue } from './models.js';
import { resolveVariableText } from './variables.js';
import type { VariableContext, VariableTextIssue, VariableTextResolution, EffectiveVariable } from './variables.js';

export type PromptInputType = 'string' | 'number' | 'boolean' | 'enum' | 'list';
export type PromptContextSource = 'project-memory' | 'workspace' | 'explicit-selection' | 'requirements' | 'tasks' | 'resources';
export type PromptOutputFormat = 'markdown' | 'text' | 'json' | 'code';

export interface PromptTemplateInput {
  name: string;
  label: string;
  valueType: PromptInputType;
  required: boolean;
  description?: string;
  options?: string[];
  multiline?: boolean;
}
export interface PromptContextRule {
  source: PromptContextSource;
  required: boolean;
  description: string;
}
export interface PromptTemplate {
  schemaVersion: '1.0.0';
  id: string;
  name: string;
  objective: string;
  inputs: PromptTemplateInput[];
  requiredVariables: string[];
  contextSelection: PromptContextRule[];
  outputFormat: PromptOutputFormat;
  descriptionMarkdown: string;
  markdown: string;
  extensions: Record<string, JsonValue>;
  [key: string]: unknown;
}
export interface PromptTemplateIssue {
  detail: string;
  message: string;
  offset?: number;
  line?: number;
  column?: number;
}
export type PromptTemplateParseResult = { ok: true; template: PromptTemplate } | { ok: false; diagnostics: PromptTemplateIssue[] };
export interface PromptTemplateCompilationResult {
  templateId: string;
  templateName: string;
  outputFormat?: PromptOutputFormat;
  text: string;
  markedExport: string;
  variables: EffectiveVariable[];
  unresolved: VariableTextIssue[];
  templateDiagnostics: PromptTemplateIssue[];
  helpersUsed: string[];
  inputsUsed: string[];
  canSendAutomatically: boolean;
}
export type PromptHelperOperation = 'uppercase' | 'lowercase' | 'join' | 'json' | 'default' | 'eq' | 'not';
export interface PromptHelperRegistration { name: string; operation: PromptHelperOperation; }

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TOKENS = 10_000;
const MAX_BLOCK_DEPTH = 16;
const MAX_ITERATIONS = 10_000;
const SAFE_NAME = /^[a-z][a-z0-9-]*$/;
const TEMPLATE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const CONTEXT_SOURCES = new Set<PromptContextSource>(['project-memory', 'workspace', 'explicit-selection', 'requirements', 'tasks', 'resources']);
const OUTPUT_FORMATS = new Set<PromptOutputFormat>(['markdown', 'text', 'json', 'code']);
const HELPER_OPERATIONS = new Set<PromptHelperOperation>(['uppercase', 'lowercase', 'join', 'json', 'default', 'eq', 'not']);
const BUILTIN_HELPERS: PromptHelperRegistration[] = [
  { name: 'upper', operation: 'uppercase' }, { name: 'lower', operation: 'lowercase' },
  { name: 'join', operation: 'join' }, { name: 'json', operation: 'json' },
  { name: 'default', operation: 'default' }, { name: 'eq', operation: 'eq' }, { name: 'not', operation: 'not' }
];

function issue(detail: string, message: string, source?: string, offset?: number): PromptTemplateIssue {
  if (source === undefined || offset === undefined) return { detail, message };
  const before = source.slice(0, offset), parts = before.split('\n');
  return { detail, message, offset, line: parts.length, column: parts.at(-1)!.length + 1 };
}
function validJsonObject(value: unknown): value is Record<string, JsonValue> { return isJson(value) && isObject(value); }
function stableMetadata(template: PromptTemplate): Record<string, unknown> {
  const { markdown, ...metadata } = template;
  return metadata;
}
function validTemplate(value: unknown): value is PromptTemplate {
  if (!validJsonObject(value) || value.schemaVersion !== '1.0.0' || typeof value.id !== 'string' || !TEMPLATE_ID.test(value.id) ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 2000 ||
    !Array.isArray(value.inputs) || value.inputs.length > 64 || !Array.isArray(value.requiredVariables) || value.requiredVariables.length > 256 ||
    !Array.isArray(value.contextSelection) || value.contextSelection.length > 32 || !OUTPUT_FORMATS.has(value.outputFormat as PromptOutputFormat) ||
    typeof value.descriptionMarkdown !== 'string' || value.descriptionMarkdown.length > 32_000 || typeof value.markdown !== 'string' || value.markdown.length > MAX_TEMPLATE_BYTES ||
    !validJsonObject(value.extensions)) return false;
  if (new Set(value.inputs.map((input) => isObject(input) ? input.name : undefined)).size !== value.inputs.length) return false;
  for (const input of value.inputs) {
    if (!isObject(input) || typeof input.name !== 'string' || !SAFE_NAME.test(input.name) || typeof input.label !== 'string' || !input.label.trim() ||
      !['string', 'number', 'boolean', 'enum', 'list'].includes(String(input.valueType)) || typeof input.required !== 'boolean' ||
      input.description !== undefined && typeof input.description !== 'string' || input.multiline !== undefined && typeof input.multiline !== 'boolean' ||
      input.valueType === 'enum' && (!Array.isArray(input.options) || !input.options.length || input.options.length > 128 || input.options.some((option) => typeof option !== 'string')) ||
      input.valueType !== 'enum' && input.options !== undefined) return false;
  }
  if (value.requiredVariables.some((name) => typeof name !== 'string' || !NAMESPACE_PATTERN.test(name)) || new Set(value.requiredVariables).size !== value.requiredVariables.length) return false;
  for (const rule of value.contextSelection) if (!isObject(rule) || !CONTEXT_SOURCES.has(rule.source as PromptContextSource) || typeof rule.required !== 'boolean' || typeof rule.description !== 'string') return false;
  return true;
}

/** Markdown template files use a small JSON comment header so metadata stays portable and lossless. */
export function parsePromptTemplate(source: string): PromptTemplateParseResult {
  if (typeof source !== 'string' || source.length > MAX_TEMPLATE_BYTES) return { ok: false, diagnostics: [issue('template-size-limit', 'La plantilla supera el límite de 2 MiB.')] };
  const header = /^<!-- a3-template\/1\r?\n([\s\S]*?)\r?\n-->\r?\n?/.exec(source);
  if (!header) return { ok: false, diagnostics: [issue('template-header-missing', 'Falta el encabezado JSON <!-- a3-template/1 ... -->.')] };
  if (header[1]!.length > 128 * 1024) return { ok: false, diagnostics: [issue('template-metadata-limit', 'Los metadatos superan 128 KiB.')] };
  let metadata: unknown;
  try { metadata = JSON.parse(header[1]!); }
  catch { return { ok: false, diagnostics: [issue('template-metadata-json-invalid', 'Los metadatos de plantilla no son JSON válido.', source, header[0].indexOf('\n') + 1)] }; }
  const template = isObject(metadata) ? { ...metadata, markdown: source.slice(header[0].length) } : metadata;
  if (!validTemplate(template)) return { ok: false, diagnostics: [issue('template-schema-invalid', 'Los metadatos no cumplen el esquema A3 de plantilla v1.')] };
  return { ok: true, template: template as PromptTemplate };
}

export function serializePromptTemplate(template: PromptTemplate): string {
  if (!validTemplate(template)) throw new TypeError('La plantilla no cumple el esquema A3 v1.');
  const json = JSON.stringify(stableMetadata(template), null, 2).replace(/</g, '\\u003c');
  return `<!-- a3-template/1\n${json}\n-->\n${template.markdown}`;
}

type Expr = { kind: 'literal'; value: JsonValue } | { kind: 'path'; value: string } | { kind: 'variable'; name: string } |
  { kind: 'helper'; name: string; args: Expr[] };
type Node = { kind: 'text'; value: string } | { kind: 'expression'; expression: Expr; offset: number } |
  { kind: 'if'; path: string; yes: Node[]; no: Node[]; offset: number } | { kind: 'each'; path: string; children: Node[]; offset: number };
interface ParseTreeResult { nodes: Node[]; stop?: { kind: 'else' | 'close'; name?: string; offset: number }; }

function lexArguments(value: string): string[] | undefined {
  const words: string[] = []; let i = 0;
  while (i < value.length) {
    while (/\s/.test(value[i] ?? '')) i++;
    if (i >= value.length) break;
    const quote = value[i] === '"' || value[i] === "'" ? value[i] : undefined;
    if (quote) {
      const start = i++, chars: string[] = []; let closed = false;
      while (i < value.length) {
        const char = value[i++]!;
        if (char === '\\') { if (i >= value.length) return undefined; const escaped = value[i++]!; if (escaped !== quote && escaped !== '\\') return undefined; chars.push(escaped); }
        else if (char === quote) { closed = true; break; } else chars.push(char);
      }
      if (!closed || i < value.length && !/\s/.test(value[i]!)) return undefined;
      words.push(`\u0000${start}:${chars.join('')}`);
    } else {
      const start = i; while (i < value.length && !/\s/.test(value[i]!)) i++; words.push(value.slice(start, i));
    }
  }
  return words;
}

function parseExpression(raw: string, source: string, offset: number, helpers: ReadonlyMap<string, PromptHelperOperation>, diagnostics: PromptTemplateIssue[]): Expr | undefined {
  const tokens = lexArguments(raw.trim());
  if (!tokens || !tokens.length) { diagnostics.push(issue('template-expression-invalid', 'Expresión vacía o con comillas/escapes no admitidos.', source, offset)); return; }
  const parseAtom = (token: string): Expr | undefined => {
    if (token.startsWith('\u0000')) return { kind: 'literal', value: token.slice(token.indexOf(':') + 1) };
    if (token === 'true' || token === 'false' || token === 'null') return { kind: 'literal', value: token === 'null' ? null : token === 'true' };
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(token)) { const value = Number(token); return Number.isFinite(value) ? { kind: 'literal', value } : undefined; }
    if (/^(?:input\.[a-z][a-z0-9-]*|this|@index)$/.test(token)) return { kind: 'path', value: token };
    if (NAMESPACE_PATTERN.test(token)) return { kind: 'variable', name: token };
    return undefined;
  };
  const head = tokens[0]!;
  if (tokens.length === 1) {
    const atom = parseAtom(head);
    if (atom) return atom;
    diagnostics.push(issue('template-path-unsupported', `Ruta o token no permitido: ${head}.`, source, offset)); return;
  }
  const operation = helpers.get(head);
  if (!operation) { diagnostics.push(issue('template-helper-unregistered', `Helper «${head}» no registrado por A3.`, source, offset)); return; }
  const args: Expr[] = [];
  for (const token of tokens.slice(1)) {
    const atom = parseAtom(token);
    if (!atom) { diagnostics.push(issue('template-helper-argument-invalid', `Argumento no permitido para «${head}»: ${token}.`, source, offset)); return; }
    args.push(atom);
  }
  const arity = operation === 'eq' ? [2] : operation === 'join' || operation === 'default' ? [1, 2] : [1];
  if (!arity.includes(args.length)) { diagnostics.push(issue('template-helper-arity-invalid', `El helper «${head}» acepta ${arity.join(' o ')} argumento(s).`, source, offset)); return; }
  return { kind: 'helper', name: head, args };
}

function parseTree(source: string, helpers: ReadonlyMap<string, PromptHelperOperation>): { nodes: Node[]; diagnostics: PromptTemplateIssue[] } {
  const diagnostics: PromptTemplateIssue[] = [], tokens: { value: string; start: number; end: number }[] = [];
  const tokenPattern = /\{\{[\s\S]*?\}\}/g; let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source))) tokens.push({ value: match[0], start: match.index, end: tokenPattern.lastIndex });
  const tokenCount = tokens.length; let cursor = 0, tokenIndex = 0;
  if (tokenCount > MAX_TOKENS) return { nodes: [], diagnostics: [issue('template-token-limit', 'La plantilla supera el límite de 10 000 bloques/expresiones.', source, tokens[MAX_TOKENS]!.start)] };
  let sourceCursor = 0;
  for (const token of tokens) {
    const unexpected = source.indexOf('{{', sourceCursor);
    if (unexpected >= 0 && unexpected < token.start) { diagnostics.push(issue('template-token-malformed', 'Bloque {{...}} incompleto o triple mustache no permitido.', source, unexpected)); break; }
    if (token.value.startsWith('{{{')) { diagnostics.push(issue('template-token-malformed', 'Triple mustache no está permitido.', source, token.start)); break; }
    sourceCursor = token.end;
  }
  const trailingUnexpected = source.indexOf('{{', sourceCursor);
  if (!diagnostics.length && trailingUnexpected >= 0) diagnostics.push(issue('template-token-malformed', 'Bloque {{...}} incompleto.', source, trailingUnexpected));
  const safeHelpers = new Map(helpers);
  function parseUntil(expected?: 'if' | 'each', depth = 0): ParseTreeResult {
    const nodes: Node[] = [];
    while (tokenIndex < tokens.length) {
      const token = tokens[tokenIndex++]!;
      // Cursor is shared by nested blocks so source text is represented exactly once.
      if (token.start < cursor) continue;
      if (token.start > cursor) nodes.push({ kind: 'text', value: source.slice(cursor, token.start) });
      const body = token.value.slice(2, -2).trim(); cursor = token.end;
      if (body === 'else') {
        if (!expected) diagnostics.push(issue('template-block-unexpected-else', '{{else}} aparece fuera de {{#if}}.', source, token.start));
        return { nodes, stop: { kind: 'else', offset: token.start } };
      }
      if (body.startsWith('/')) {
        const name = body.slice(1).trim();
        if (!expected) diagnostics.push(issue('template-block-unexpected-close', `Cierre inesperado {{/${name}}}.`, source, token.start));
        return { nodes, stop: { kind: 'close', name, offset: token.start } };
      }
      const block = /^#(if|each)\s+(.+)$/.exec(body);
      if (block) {
        const type = block[1] as 'if' | 'each', path = block[2]!.trim();
        if (depth >= MAX_BLOCK_DEPTH) { diagnostics.push(issue('template-block-depth-limit', 'Se excede el máximo de 16 bloques anidados.', source, token.start)); return { nodes }; }
        if (!/^(?:input\.[a-z][a-z0-9-]*|this|@index)$/.test(path)) diagnostics.push(issue('template-block-path-invalid', `La ruta «${path}» no se admite en #${type}.`, source, token.start));
        const first = parseUntil(type, depth + 1); let yes = first.nodes, no: Node[] = [];
        if (type === 'if' && first.stop?.kind === 'else') { const second = parseUntil(type, depth + 1); no = second.nodes; if (second.stop?.kind !== 'close' || second.stop.name !== type) diagnostics.push(issue(second.stop?.kind === 'close' ? 'template-block-mismatch' : 'template-block-unclosed', `Se esperaba {{/${type}}}.`, source, token.start)); }
        else if (first.stop?.kind !== 'close' || first.stop.name !== type) diagnostics.push(issue(first.stop?.kind === 'close' ? 'template-block-mismatch' : 'template-block-unclosed', `Se esperaba {{/${type}}}.`, source, token.start));
        if (type === 'if') nodes.push({ kind: 'if', path, yes, no, offset: token.start }); else nodes.push({ kind: 'each', path, children: yes, offset: token.start });
        continue;
      }
      if (body.startsWith('#')) { diagnostics.push(issue('template-block-unsupported', `Bloque no admitido: ${body}.`, source, token.start)); continue; }
      if (body.startsWith('!')) continue;
      if (body.includes('(') || body.includes(')') || body.includes('~')) { diagnostics.push(issue('template-expression-unsupported', 'Subexpresiones, whitespace control y expresiones Handlebars dinámicas no están admitidas.', source, token.start)); continue; }
      const expression = parseExpression(body, source, token.start, safeHelpers, diagnostics);
      if (expression) nodes.push({ kind: 'expression', expression, offset: token.start });
    }
    if (!expected && cursor < source.length) { nodes.push({ kind: 'text', value: source.slice(cursor) }); cursor = source.length; }
    return { nodes };
  }
  const tree = parseUntil();
  if (tree.stop) diagnostics.push(issue('template-block-unexpected-close', 'Cierre de bloque fuera de lugar.', source, tree.stop.offset));
  return { nodes: tree.nodes, diagnostics };
}

function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}
function display(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}
interface EvalFrame { current?: JsonValue; index?: number; }
interface RenderState {
  template: PromptTemplate; inputs: Record<string, JsonValue>; diagnostics: PromptTemplateIssue[]; helpersUsed: Set<string>; inputsUsed: Set<string>;
  variables: Map<string, EffectiveVariable>; variableResolutions: Map<string, VariableTextResolution>; unresolved: VariableTextIssue[]; snapshot: DomainSnapshot; context: VariableContext; requiredVariables: Set<string>; iterations: number; outputLength: number;
}
function pathValue(path: string, state: RenderState, frame: EvalFrame): JsonValue | undefined {
  if (path === '@index') return frame.index;
  const parts = path.split('.'); let value: JsonValue | undefined;
  if (parts[0] === 'input') { parts.shift(); value = state.inputs; if (parts[0]) state.inputsUsed.add(parts[0]); }
  else if (parts[0] === 'this') { parts.shift(); value = frame.current; }
  else return undefined;
  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') return undefined;
    if (Array.isArray(value) && /^(?:0|[1-9]\d*)$/.test(part)) value = value[Number(part)];
    else if (isObject(value)) value = value[part] as JsonValue | undefined;
    else return undefined;
  }
  return value;
}
function evalExpression(expression: Expr, state: RenderState, frame: EvalFrame, offset: number): JsonValue | undefined {
  if (expression.kind === 'literal') return expression.value;
  if (expression.kind === 'path') return pathValue(expression.value, state, frame);
  if (expression.kind === 'variable') {
    let resolved = state.variableResolutions.get(expression.name);
    if (!resolved) { resolved = resolveVariableText(state.snapshot, `{{${expression.name}}}`, state.context, []); state.variableResolutions.set(expression.name, resolved); }
    const before = state.template.markdown.slice(0, offset), parts = before.split('\n');
    for (const item of resolved.variables) state.variables.set(`${item.scope.kind}:${item.scope.kind === 'execution' ? '' : item.scope.ownerId}:${item.name}`, item);
    for (const item of resolved.unresolved) state.unresolved.push({ ...item, required: state.requiredVariables.has(expression.name), offset, line: parts.length, column: parts.at(-1)!.length + 1 });
    return resolved.text;
  }
  const args = expression.args.map((arg) => evalExpression(arg, state, frame, offset));
  state.helpersUsed.add(expression.name);
  const [first, second] = args;
  const typeError = (): undefined => { state.diagnostics.push(issue('template-helper-type-invalid', `Los argumentos no cumplen el tipo del helper «${expression.name}».`, state.template.markdown, offset)); return undefined; };
  switch (expression.name) {
    case 'upper': return typeof first === 'string' ? first.toLocaleUpperCase('en-US') : typeError();
    case 'lower': return typeof first === 'string' ? first.toLocaleLowerCase('en-US') : typeError();
    case 'json': return first === undefined ? undefined : JSON.stringify(first);
    case 'join': return Array.isArray(first) && (second === undefined || typeof second === 'string') ? first.map((value) => display(value)).join(typeof second === 'string' ? second : ', ') : typeError();
    case 'default': return truthy(first) ? first : second;
    case 'eq': return JSON.stringify(first) === JSON.stringify(second);
    case 'not': return !truthy(first);
  }
}
function renderNodes(nodes: Node[], state: RenderState, frame: EvalFrame = {}): string {
  let result = '';
  const append = (text: string, offset: number): void => {
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - state.outputLength), accepted = text.slice(0, remaining);
    result += accepted; state.outputLength += accepted.length;
    if (accepted.length < text.length && !state.diagnostics.some((item) => item.detail === 'template-output-limit')) state.diagnostics.push(issue('template-output-limit', 'La salida de la plantilla supera 4 MiB.', state.template.markdown, offset));
  };
  for (const node of nodes) {
    if (node.kind === 'text') append(node.value, 0);
    else if (node.kind === 'expression') append(display(evalExpression(node.expression, state, frame, node.offset)), node.offset);
    else if (node.kind === 'if') result += renderNodes(truthy(pathValue(node.path, state, frame)) ? node.yes : node.no, state, frame);
    else {
      const collection = pathValue(node.path, state, frame);
      if (Array.isArray(collection)) {
        if (collection.length > MAX_ITERATIONS) state.diagnostics.push(issue('template-iteration-limit', 'Un bloque #each supera 10 000 elementos.', state.template.markdown, node.offset));
        else for (let index = 0; index < collection.length; index++) {
          if (state.outputLength >= MAX_OUTPUT_BYTES) { if (index < collection.length - 1) state.diagnostics.push(issue('template-output-limit', 'La salida de la plantilla supera 4 MiB.', state.template.markdown, node.offset)); break; }
          if (++state.iterations > MAX_ITERATIONS) { state.diagnostics.push(issue('template-iteration-limit', 'La plantilla supera 10 000 iteraciones totales.', state.template.markdown, node.offset)); break; }
          result += renderNodes(node.children, state, { current: collection[index]!, index });
        }
      } else if (collection !== undefined && collection !== null) state.diagnostics.push(issue('template-each-type-invalid', '#each solo itera listas, no objetos ni texto.', state.template.markdown, node.offset));
    }
  }
  return result;
}

export function defaultPromptHelperRegistry(): PromptHelperRegistration[] { return BUILTIN_HELPERS.map((entry) => ({ ...entry })); }
export function buildPromptHelperRegistry(registered: readonly PromptHelperRegistration[] = BUILTIN_HELPERS): Map<string, PromptHelperOperation> {
  const result = new Map<string, PromptHelperOperation>();
  if (registered.length > 128) throw new TypeError('Registro de helpers A3 demasiado grande.');
  for (const helper of registered) {
    if (!SAFE_NAME.test(helper.name) || ['constructor', 'prototype', '__proto__'].includes(helper.name) || !HELPER_OPERATIONS.has(helper.operation) || result.has(helper.name)) throw new TypeError('Registro de helpers A3 inválido o duplicado.');
    result.set(helper.name, helper.operation);
  }
  return result;
}

function validateInputs(template: PromptTemplate, inputs: unknown, diagnostics: PromptTemplateIssue[]): Record<string, JsonValue> {
  if (!validJsonObject(inputs) || JSON.stringify(inputs).length > MAX_INPUT_BYTES) { diagnostics.push(issue('template-inputs-invalid', 'Las entradas deben ser un objeto JSON de hasta 128 KiB.')); return {}; }
  const definitions = new Map(template.inputs.map((input) => [input.name, input]));
  for (const name of Object.keys(inputs)) if (!definitions.has(name)) diagnostics.push(issue('template-input-unknown', `Entrada no declarada: ${name}.`));
  const normalized: Record<string, JsonValue> = {};
  for (const item of template.inputs) {
    const value = inputs[item.name];
    if (value === undefined || value === null || value === '') {
      if (item.required) diagnostics.push(issue('template-input-required', `Falta la entrada obligatoria «${item.label}» (${item.name}).`));
      else normalized[item.name] = item.valueType === 'list' ? [] : '';
      continue;
    }
    const valid = item.valueType === 'string' ? typeof value === 'string' : item.valueType === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      item.valueType === 'boolean' ? typeof value === 'boolean' : item.valueType === 'enum' ? typeof value === 'string' && item.options!.includes(value) :
        Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    if (!valid) diagnostics.push(issue('template-input-type-invalid', `La entrada «${item.name}» no cumple el tipo ${item.valueType}.`));
    else normalized[item.name] = value as JsonValue;
  }
  return normalized;
}

export function compilePromptTemplate(snapshot: DomainSnapshot, source: string, inputs: unknown, context: VariableContext = {}, registeredHelpers: readonly PromptHelperRegistration[] = BUILTIN_HELPERS): PromptTemplateCompilationResult {
  const parsed = parsePromptTemplate(source);
  if (!parsed.ok) return { templateId: '', templateName: 'Plantilla inválida', text: source, markedExport: `> **A3: plantilla no compilada**\n> ${parsed.diagnostics.map((item) => `${item.detail}: ${item.message}`).join('\n> ')}\n\n${source}`,
    variables: [], unresolved: [], templateDiagnostics: parsed.diagnostics, helpersUsed: [], inputsUsed: [], canSendAutomatically: false };
  const template = parsed.template, diagnostics: PromptTemplateIssue[] = [], normalized = validateInputs(template, inputs, diagnostics);
  let helperRegistry: Map<string, PromptHelperOperation>;
  try { helperRegistry = buildPromptHelperRegistry(registeredHelpers); }
  catch { diagnostics.push(issue('template-helper-registry-invalid', 'El registro de helpers no está aprobado o no cumple el subconjunto A3.')); helperRegistry = new Map(); }
  const tree = parseTree(template.markdown, helperRegistry); diagnostics.push(...tree.diagnostics);
  const inputNames = new Set(template.inputs.map((entry) => entry.name));
  const inspectExpression = (expression: Expr, inEach: boolean, offset: number): void => {
    if (expression.kind === 'path') {
      const root = expression.value.split('.')[0]!;
      if (root === 'input' && !inputNames.has(expression.value.split('.')[1]!)) diagnostics.push(issue('template-input-undeclared', `La plantilla usa una entrada no declarada: ${expression.value}.`, template.markdown, offset));
      if ((root === 'this' || root === '@index') && !inEach) diagnostics.push(issue('template-each-scope-required', `${expression.value} solo se permite dentro de #each.`, template.markdown, offset));
    } else if (expression.kind === 'helper') expression.args.forEach((argument) => inspectExpression(argument, inEach, offset));
  };
  const inspectNodes = (nodes: Node[], inEach = false): void => { for (const node of nodes) {
    if (node.kind === 'expression') inspectExpression(node.expression, inEach, node.offset);
    else if (node.kind === 'if') { inspectExpression({ kind: 'path', value: node.path }, inEach, node.offset); inspectNodes(node.yes, inEach); inspectNodes(node.no, inEach); }
    else if (node.kind === 'each') { inspectExpression({ kind: 'path', value: node.path }, inEach, node.offset); inspectNodes(node.children, true); }
  } };
  inspectNodes(tree.nodes);
  const state: RenderState = { template, inputs: normalized, diagnostics, helpersUsed: new Set(), inputsUsed: new Set(), variables: new Map(), variableResolutions: new Map(), unresolved: [], snapshot, context,
    requiredVariables: new Set(template.requiredVariables), iterations: 0, outputLength: 0 };
  const rendered = diagnostics.length ? template.markdown : renderNodes(tree.nodes, state);
  for (const name of template.requiredVariables) {
    if ([...state.variables.values()].some((item) => item.name === name) || state.unresolved.some((item) => item.name === name)) continue;
    const required = resolveVariableText(snapshot, '', context, [name]);
    for (const item of required.variables) state.variables.set(`${item.scope.kind}:${item.scope.kind === 'execution' ? '' : item.scope.ownerId}:${item.name}`, item);
    state.unresolved.push(...required.unresolved);
  }
  const dedupedIssues = new Map<string, VariableTextIssue>();
  for (const item of state.unresolved) dedupedIssues.set(`${item.name ?? ''}:${item.detail}:${item.offset ?? 'required'}`, item);
  const unresolved = [...dedupedIssues.values()], failed = diagnostics.length > 0;
  const text = rendered;
  const variableHeader = unresolved.length ? `> **A3: exportación con variables sin resolver**\n> ${unresolved.map((item) => `- ${item.name ?? 'plantilla'} · ${item.detail}: ${item.message}`).join('\n> ')}\n\n` : '';
  const templateHeader = diagnostics.length ? `> **A3: plantilla no compilada**\n> ${diagnostics.map((item) => `- ${item.detail}: ${item.message}`).join('\n> ')}\n\n` : '';
  return { templateId: template.id, templateName: template.name, outputFormat: template.outputFormat, text,
    markedExport: `${templateHeader}${variableHeader}${text}`, variables: [...state.variables.values()], unresolved, templateDiagnostics: diagnostics,
    helpersUsed: [...state.helpersUsed].sort(), inputsUsed: [...state.inputsUsed].sort(), canSendAutomatically: !failed && !unresolved.some((item) => item.required) };
}

function input(name: string, label: string, valueType: PromptInputType = 'string', options?: string[], multiline = false): PromptTemplateInput {
  return { name, label, valueType, required: true, ...(options ? { options } : {}), ...(multiline ? { multiline: true } : {}) };
}
function template(id: string, name: string, objective: string, inputs: PromptTemplateInput[], contextSelection: PromptContextRule[], markdown: string, descriptionMarkdown: string, requiredVariables: string[] = []): PromptTemplate {
  return { schemaVersion: '1.0.0', id, name, objective, inputs, requiredVariables, contextSelection, outputFormat: 'markdown', descriptionMarkdown, markdown, extensions: {} };
}

/** Built-in prompt examples; context rules are declarative here and do not read project files. */
export const BUILTIN_PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  template('a3.story', 'Historia de usuario', 'Convertir una necesidad en una historia verificable.', [input('actor', 'Actor'), input('need', 'Necesidad', 'string', undefined, true), input('benefit', 'Beneficio', 'string', undefined, true), input('criteria', 'Criterios de aceptación', 'list'), { ...input('open-question', 'Pregunta pendiente'), required: false }],
    [{ source: 'explicit-selection', required: false, description: 'Añade solo requisitos y notas elegidos por la persona.' }],
    '# Historia de usuario\n\nComo **{{input.actor}}**, quiero {{input.need}} para {{input.benefit}}.\n\n## Criterios de aceptación\n{{#each input.criteria}}\n- {{this}}\n{{/each}}\n\n## Preguntas pendientes\n- {{default input.open-question "Ninguna indicada"}}\n',
    'Estructura una historia y criterios revisables; no selecciona información del vault por sí sola.'),
  template('a3.review', 'Revisión de texto', 'Revisar claridad, consistencia y puntos que necesitan confirmación.', [input('text', 'Texto para revisar', 'string', undefined, true), input('focus', 'Enfoque de revisión')],
    [{ source: 'explicit-selection', required: true, description: 'Usa únicamente el texto seleccionado y el enfoque declarado.' }],
    '# Revisión\n\nEnfoque: {{input.focus}}\n\n## Texto\n{{input.text}}\n\n## Hallazgos\nRevisa claridad, coherencia, supuestos y ambigüedades. Distingue hechos del texto de recomendaciones.\n',
    'Solicita una revisión razonada sin alterar el documento de origen.'),
  template('a3.checklist', 'Generar checklist', 'Transformar un alcance explícito en una lista verificable.', [input('scope', 'Alcance', 'string', undefined, true), input('items', 'Requisitos o resultados esperados', 'list')],
    [{ source: 'explicit-selection', required: true, description: 'Incluye solo el alcance y los requisitos seleccionados.' }],
    '# Checklist\n\nAlcance: {{input.scope}}\n\n## Requisitos de entrada\n{{#each input.items}}\n- [ ] {{this}}\n{{/each}}\n\n## Criterios de término\n- Cada ítem tiene una condición de verificación.\n- Los supuestos y dependencias quedan señalados.\n',
    'Produce una lista trazable; no marca elementos como completados.'),
  template('a3.iot-proposal', 'Propuesta IoT', 'Preparar una propuesta de código y conexiones IoT que requiera revisión humana.', [input('goal', 'Objetivo del circuito', 'string', undefined, true), input('components', 'Componentes conocidos', 'list'), input('board', 'Placa objetivo')],
    [{ source: 'explicit-selection', required: true, description: 'Selecciona modelo exacto, puertos y límites conocidos.' }, { source: 'requirements', required: false, description: 'Añade requisitos explícitamente elegidos.' }],
    '# Propuesta IoT (no verificada)\n\nObjetivo: {{input.goal}}\nPlaca: {{input.board}}\n\n## Componentes declarados\n{{#each input.components}}\n- {{this}}\n{{/each}}\n\n## Solicitud\nPropón conexiones y un ejemplo de código. Separa datos confirmados, supuestos y preguntas. No inventes pinout o límites eléctricos; el resultado requiere revisión y no constituye simulación ni certificación.\n',
    'Pide una propuesta de implementación a partir de componentes seleccionados; el resultado no se ejecuta ni se certifica.'),
  template('a3.project-summary', 'Resumen del proyecto', 'Resumir información elegida y dejar visibles omisiones o preguntas.', [input('focus', 'Enfoque del resumen'), input('facts', 'Hechos o notas seleccionadas', 'list')],
    [{ source: 'project-memory', required: false, description: 'La memoria del proyecto solo se agrega mediante selección explícita posterior.' }, { source: 'explicit-selection', required: false, description: 'La selección concreta se define al compilar contexto en E4-B2.' }],
    '# Resumen: {{proyecto.nombre}}\n\nEnfoque: {{input.focus}}\n\n## Información seleccionada\n{{#each input.facts}}\n- {{this}}\n{{/each}}\n\n## Síntesis\nResume objetivos, estado, decisiones y dependencias sin afirmar información que no esté en las fuentes incluidas.\n\n## Pendientes y omisiones\nDeclara datos no disponibles y preguntas abiertas.\n',
    'Da forma a un resumen; las reglas de contexto son visibles pero todavía no recopilan archivos automáticamente.', ['proyecto.nombre'])
];

export function serializeBuiltinPromptTemplate(templateId: string): string | undefined {
  const found = BUILTIN_PROMPT_TEMPLATES.find((entry) => entry.id === templateId);
  return found ? serializePromptTemplate(found) : undefined;
}
