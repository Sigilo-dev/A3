import { diagnostic, isObject, UUID_PATTERN } from './data.js';
import type { Diagnostic, DomainSnapshot, Entity, ExtensionMap, JsonValue, Outcome, Point } from './models.js';
import { iotData, isIotComponent, type IotKnown, type IotPort } from './iot.js';

/** A circuit is stored as a versioned namespace extension on its A3 Entity. */
export const IOT_CIRCUIT_TYPE = 'a3.iot.circuit';
export const IOT_CIRCUIT_KEY = 'a3.iot.circuit';
export const IOT_CIRCUIT_VERSION = '1.0.0';

export type IotNetKind = 'signal' | 'bus' | 'power' | 'ground';
export interface IotCircuitInstance {
  /** The component Entity ID is the stable instance identity. */
  entityId: string;
  reference: string;
  parameters: Record<string, IotKnown<JsonValue>>;
}
export interface IotNetEndpoint { entityId: string; portId: string; }
export interface IotJunction { id: string; label?: string; position?: Point; }
export interface IotBusLane { id: string; name: string; endpoints: IotNetEndpoint[]; junctions: IotJunction[]; }
export interface IotNet {
  id: string;
  name: string;
  kind: IotNetKind;
  endpoints: IotNetEndpoint[];
  junctions: IotJunction[];
  /** A bus groups independent electrical lanes (e.g. SDA and SCL); lanes are never shorted together. */
  bus?: { protocol: IotKnown<string>; members: IotBusLane[] };
  notes: string[];
  extensions: ExtensionMap;
}
export interface IotCircuitParameter { id: string; name: string; value: IotKnown<JsonValue>; unit?: string; source?: string; }
export interface IotCircuitConstraint { id: string; statement: string; state: 'known' | 'unknown'; source?: string; }
export interface IotCircuitNote { id: string; markdown: string; }
export interface IotCircuitData {
  schemaVersion: typeof IOT_CIRCUIT_VERSION;
  instances: IotCircuitInstance[];
  nets: IotNet[];
  parameters: IotCircuitParameter[];
  requirements: string[];
  constraints: IotCircuitConstraint[];
  notes: IotCircuitNote[];
  questions: string[];
  /** Generated code is retained only as a reviewable proposal; A3 never executes it here. */
  codeProposals: { id: string; language: string; content: string; sourceNetIds: string[]; state: 'proposal' }[];
  extensions: ExtensionMap;
}
export type IotCircuitOperation = { kind: 'replace-model'; model: IotCircuitData };
export interface CreateIotCircuit { workspaceId: string; entityId: string; placementId: string; title: string; position: Point; }
export interface ChangeIotCircuit { entityId: string; operation: IotCircuitOperation; }
export interface IotCircuitIssue {
  state: 'invalid' | 'incomplete' | 'unknown'; code: string; message: string; entityId?: string; netId?: string; endpoint?: IotNetEndpoint;
}
export interface IotCircuitExports {
  manifest: { entityIds: string[]; sources: { entityId: string; title: string; sources: { title: string; url: string; documentRevision?: string }[] }[]; omitted: string[] };
  bomCsv: string;
  connectionsJson: string;
  pinTableCsv: string;
  contextMarkdown: string;
  issues: IotCircuitIssue[];
}
export type IotCircuitEntitySummary = Pick<Entity, 'id' | 'title' | 'type' | 'typeVersion' | 'properties' | 'ports'>;

const uuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
const known = (value: unknown): value is IotKnown<JsonValue> => isObject(value) &&
  (value.state === 'known' && isJsonValue(value.value) || value.state === 'unknown' && typeof value.reason === 'string' && !!value.reason.trim());
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const namedIdsUnique = (items: readonly { id: string }[]): boolean => items.every((item) => uuid(item.id)) && new Set(items.map(({ id }) => id.toLowerCase())).size === items.length;
const point = (value: unknown): value is Point => isObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
const extensionMap = (value: unknown): value is ExtensionMap => isObject(value) && Object.values(value).every(isJsonValue);
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}
function validModel(value: unknown): value is IotCircuitData {
  if (!isObject(value) || value.schemaVersion !== IOT_CIRCUIT_VERSION || !Array.isArray(value.instances) || !Array.isArray(value.nets) ||
      !Array.isArray(value.parameters) || !stringList(value.requirements) || !Array.isArray(value.constraints) || !Array.isArray(value.notes) ||
      !stringList(value.questions) || !Array.isArray(value.codeProposals) || !extensionMap(value.extensions)) return false;
  if (!value.instances.every((instance) => isObject(instance) && uuid(instance.entityId) && typeof instance.reference === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(instance.reference) && isObject(instance.parameters) && Object.values(instance.parameters).every(known)) ||
      new Set(value.instances.map((item) => String(item.entityId).toLowerCase())).size !== value.instances.length ||
      new Set(value.instances.map((item) => String(item.reference).toLowerCase())).size !== value.instances.length) return false;
  if (!value.nets.every((net) => isObject(net) && uuid(net.id) && typeof net.name === 'string' && !!net.name.trim() &&
    ['signal', 'bus', 'power', 'ground'].includes(String(net.kind)) && Array.isArray(net.endpoints) && net.endpoints.every((endpoint) =>
      isObject(endpoint) && uuid(endpoint.entityId) && typeof endpoint.portId === 'string' && !!endpoint.portId) &&
    Array.isArray(net.junctions) && net.junctions.every((junction) => isObject(junction) && uuid(junction.id) &&
      (junction.label === undefined || typeof junction.label === 'string') && (junction.position === undefined || point(junction.position))) &&
    (net.kind !== 'bus' || net.endpoints.length === 0 && net.junctions.length === 0 && isObject(net.bus) && known(net.bus.protocol) && Array.isArray(net.bus.members) &&
      net.bus.members.every((lane) => isObject(lane) && uuid(lane.id) && typeof lane.name === 'string' && !!lane.name.trim() && Array.isArray(lane.endpoints) &&
        lane.endpoints.every((endpoint) => isObject(endpoint) && uuid(endpoint.entityId) && typeof endpoint.portId === 'string' && !!endpoint.portId) &&
        Array.isArray(lane.junctions) && lane.junctions.every((junction) => isObject(junction) && uuid(junction.id) &&
          (junction.label === undefined || typeof junction.label === 'string') && (junction.position === undefined || point(junction.position))) && namedIdsUnique(lane.junctions)) &&
      namedIdsUnique(net.bus.members) && new Set(net.bus.members.map((lane) => String(lane.name).toLowerCase())).size === net.bus.members.length) && (net.kind === 'bus' || net.bus === undefined) &&
    stringList(net.notes) && extensionMap(net.extensions) && namedIdsUnique(net.junctions)) || !namedIdsUnique(value.nets)) return false;
  if (!value.parameters.every((item) => isObject(item) && uuid(item.id) && typeof item.name === 'string' && !!item.name.trim() && known(item.value) &&
      (item.unit === undefined || typeof item.unit === 'string') && (item.source === undefined || typeof item.source === 'string')) || !namedIdsUnique(value.parameters)) return false;
  if (!value.constraints.every((item) => isObject(item) && uuid(item.id) && typeof item.statement === 'string' && !!item.statement.trim() &&
      ['known', 'unknown'].includes(String(item.state)) && (item.source === undefined || typeof item.source === 'string')) || !namedIdsUnique(value.constraints)) return false;
  if (!value.notes.every((item) => isObject(item) && uuid(item.id) && typeof item.markdown === 'string') || !namedIdsUnique(value.notes)) return false;
  if (!value.codeProposals.every((item) => isObject(item) && uuid(item.id) && typeof item.language === 'string' && !!item.language.trim() &&
    typeof item.content === 'string' && stringList(item.sourceNetIds) && item.state === 'proposal' && item.sourceNetIds.every(uuid)) || !namedIdsUnique(value.codeProposals)) return false;
  const checked = value as unknown as IotCircuitData;
  const localIds = [...checked.nets.map((net) => net.id), ...checked.nets.flatMap((net) => net.kind === 'bus' ? [
    ...net.bus!.members.map((lane) => lane.id), ...net.bus!.members.flatMap((lane) => lane.junctions.map((junction) => junction.id))
  ] : net.junctions.map((junction) => junction.id)), ...value.parameters.map((item) => item.id), ...value.constraints.map((item) => item.id),
    ...value.notes.map((item) => item.id), ...value.codeProposals.map((item) => item.id)];
  return new Set(localIds.map((id) => id.toLowerCase())).size === localIds.length &&
    new Set(checked.nets.map((net) => net.name.toLowerCase())).size === checked.nets.length;
}

export function emptyIotCircuit(): IotCircuitData {
  return { schemaVersion: IOT_CIRCUIT_VERSION, instances: [], nets: [], parameters: [], requirements: [], constraints: [], notes: [], questions: [], codeProposals: [], extensions: {} };
}
export function createIotCircuitEntity(id: string, title: string): Entity {
  return { schemaVersion: '1.0.0', id, revision: 1, type: IOT_CIRCUIT_TYPE, typeVersion: IOT_CIRCUIT_VERSION,
    title, tags: ['iot', 'circuit'], properties: { [IOT_CIRCUIT_KEY]: emptyIotCircuit() as unknown as JsonValue }, ports: [], bindings: {}, extensions: {} };
}
export function iotCircuitData(entity: Pick<Entity, 'type' | 'typeVersion' | 'properties'>): IotCircuitData | undefined {
  const value = entity.properties[IOT_CIRCUIT_KEY];
  return entity.type === IOT_CIRCUIT_TYPE && entity.typeVersion === IOT_CIRCUIT_VERSION && validModel(value) ? value : undefined;
}
export function isIotCircuit(entity: Pick<Entity, 'type' | 'typeVersion' | 'properties'>): boolean { return iotCircuitData(entity) !== undefined; }
export function validIotCircuitOperation(value: unknown): value is IotCircuitOperation {
  return isObject(value) && Object.keys(value).length === 2 && value.kind === 'replace-model' && validModel(value.model);
}
export function validateIotCircuitModel(model: unknown, entities: readonly IotCircuitEntitySummary[], circuitEntityId?: string): IotCircuitIssue[] {
  if (!validModel(model)) return [{ state: 'invalid', code: 'circuit-model-invalid', message: 'El modelo IoT no cumple el esquema versionado.' }];
  const issues: IotCircuitIssue[] = [];
  const byId = new Map(entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const instanceIds = new Set(model.instances.map((instance) => instance.entityId.toLowerCase()));
  for (const instance of model.instances) {
    const entity = byId.get(instance.entityId.toLowerCase());
    if (!entity || !isIotComponent(entity)) issues.push({ state: 'invalid', code: 'circuit-instance-missing', entityId: instance.entityId,
      message: `La instancia ${instance.reference} no resuelve a un componente IoT válido.` });
    for (const [name, value] of Object.entries(instance.parameters)) if (value.state === 'unknown') issues.push({ state: 'unknown', code: 'instance-parameter-unknown', entityId: instance.entityId,
      message: `El parámetro ${name} de ${instance.reference} es desconocido: ${value.reason}` });
  }
  for (const parameter of model.parameters) if (parameter.value.state === 'unknown') issues.push({ state: 'unknown', code: 'circuit-parameter-unknown',
    message: `El parámetro ${parameter.name} es desconocido: ${parameter.value.reason}` });
  for (const constraint of model.constraints) if (constraint.state === 'unknown') issues.push({ state: 'unknown', code: 'constraint-unknown',
    message: `La restricción pendiente sigue desconocida: ${constraint.statement}` });
  const netIds = new Set(model.nets.map((net) => net.id.toLowerCase()));
  for (const proposal of model.codeProposals) for (const sourceNetId of proposal.sourceNetIds) if (!netIds.has(sourceNetId.toLowerCase())) {
    issues.push({ state: 'invalid', code: 'proposal-net-missing', message: `La propuesta ${proposal.id} referencia la red fuente inexistente ${sourceNetId}.` });
  }
  const usedPins = new Map<string, string>();
  for (const net of model.nets) {
    const groups = net.kind === 'bus' ? net.bus!.members.map((lane) => ({ id: lane.id, name: `${net.name}/${lane.name}`, endpoints: lane.endpoints })) :
      [{ id: net.id, name: net.name, endpoints: net.endpoints }];
    if (!groups.length) issues.push({ state: 'incomplete', code: 'bus-no-lanes', netId: net.id, message: `El bus ${net.name} aún no tiene carriles eléctricos.` });
    if (net.kind === 'bus' && net.bus?.protocol.state === 'unknown') issues.push({ state: 'unknown', code: 'bus-protocol-unknown', netId: net.id,
      message: `El protocolo del bus ${net.name} permanece desconocido.` });
    for (const group of groups) {
      if (group.endpoints.length < 2) issues.push({ state: 'incomplete', code: 'net-incomplete', netId: net.id,
        message: `La red ${group.name} tiene ${group.endpoints.length} extremos; todavía no forma una conexión completa.` });
      const endpointPorts: { endpoint: IotNetEndpoint; port: IotPort }[] = [];
      for (const endpoint of group.endpoints) {
      if (!instanceIds.has(endpoint.entityId.toLowerCase())) {
        issues.push({ state: 'invalid', code: 'net-instance-not-in-circuit', netId: net.id, endpoint, message: `La red ${net.name} referencia una instancia que no está incluida en el circuito.` });
        continue;
      }
      const entity = byId.get(endpoint.entityId.toLowerCase());
      const port = entity?.ports.find((candidate) => candidate.id === endpoint.portId) as IotPort | undefined;
      if (!port) { issues.push({ state: 'invalid', code: 'net-pin-missing', netId: net.id, endpoint, message: `No existe el pin ${endpoint.portId} en la instancia ${endpoint.entityId}.` }); continue; }
      const pinKey = `${endpoint.entityId.toLowerCase()}\u0000${endpoint.portId}`;
      const usedIn = usedPins.get(pinKey);
      if (usedIn) issues.push({ state: 'invalid', code: 'pin-multiple-nets', netId: net.id, endpoint, message: `El pin ${endpoint.portId} ya pertenece a otra red o carril (${usedIn}).` });
      else usedPins.set(pinKey, group.name);
      endpointPorts.push({ endpoint, port });
      if (port.signalType.state === 'unknown') issues.push({ state: 'unknown', code: 'pin-signal-unknown', netId: net.id, endpoint,
        message: `El tipo de señal del pin ${endpoint.portId} no está documentado; no se valida compatibilidad.` });
      if (net.kind === 'bus' && net.bus?.protocol.state === 'known') {
        if (port.bus.state === 'unknown') issues.push({ state: 'unknown', code: 'pin-bus-support-unknown', netId: net.id, endpoint,
          message: `El soporte del protocolo ${net.bus.protocol.value} no está documentado para el pin ${endpoint.portId}.` });
        else if (!port.bus.value.includes(net.bus.protocol.value)) issues.push({ state: 'invalid', code: 'bus-protocol-incompatible', netId: net.id, endpoint,
          message: `El pin ${endpoint.portId} no declara soporte para ${net.bus.protocol.value} entre sus funciones alternativas conocidas.` });
      }
    }
    const outputs = endpointPorts.filter(({ port }) => port.direction === 'output');
    if (outputs.length > 1) for (const { endpoint } of outputs.slice(1)) issues.push({ state: 'invalid', code: 'multiple-output-drivers', netId: net.id, endpoint,
      message: `La red ${net.name} une varias salidas conocidas; revisa los pines antes de considerar válida la conexión.` });
    const ground = endpointPorts.filter(({ port }) => port.signalType.state === 'known' && port.signalType.value === 'ground');
    const power = endpointPorts.filter(({ port }) => port.signalType.state === 'known' && port.signalType.value === 'power');
    if (ground.length && power.length) issues.push({ state: 'invalid', code: 'power-ground-short', netId: net.id,
      message: `La red ${net.name} une pines documentados como alimentación y tierra.` });
    const unknownVoltage = endpointPorts.some(({ port }) => {
      const value = port.limits.voltage;
      return value?.state === 'unknown' || value?.state === 'known' && !['v', 'v dc', 'vdc', 'volt', 'volts', 'mv', 'mv dc', 'mvdc'].includes(value.value.unit.trim().toLowerCase());
    });
    const voltages = endpointPorts.flatMap(({ endpoint, port }) => {
      const limit = port.limits.voltage;
      if (limit?.state !== 'known') return [];
      const unit = limit.value.unit.trim().toLowerCase();
      const factor = ['mv', 'mv dc', 'mvdc'].includes(unit) ? 0.001 : 1;
      if (!['v', 'v dc', 'vdc', 'volt', 'volts', 'mv', 'mv dc', 'mvdc'].includes(unit)) return [];
      const { min, max, nominal } = limit.value;
      const low = min ?? nominal, high = max ?? nominal;
      return low !== undefined && high !== undefined ? [{ endpoint, low: low * factor, high: high * factor }] : [];
    });
    if (voltages.length > 1 && Math.max(...voltages.map((voltage) => voltage.low)) > Math.min(...voltages.map((voltage) => voltage.high))) {
      issues.push({ state: 'invalid', code: 'known-voltage-conflict', netId: net.id,
        message: `Los rangos de voltaje documentados para la red ${group.name} no se intersectan.` });
    } else if (unknownVoltage || endpointPorts.some(({ port }) => port.limits.voltage?.state === 'known' && port.limits.voltage.value.min === undefined &&
      port.limits.voltage.value.max === undefined && port.limits.voltage.value.nominal === undefined)) {
      issues.push({ state: 'unknown', code: 'voltage-compatibility-unknown', netId: net.id,
        message: `Al menos un límite de voltaje de ${group.name} es desconocido; no se afirma compatibilidad.` });
    }
    if (endpointPorts.length && endpointPorts.every(({ port }) => port.direction === 'input' || port.direction === 'passive')) {
      issues.push({ state: 'incomplete', code: 'net-no-known-driver', netId: net.id,
        message: `La red ${group.name} no tiene una salida conocida; se marca incompleta, no se presupone un driver.` });
    }
    }
  }
  if (circuitEntityId) for (const proposal of model.codeProposals) if (proposal.state !== 'proposal') {
    issues.push({ state: 'invalid', code: 'code-not-proposal', entityId: circuitEntityId, message: 'El código asociado debe conservarse como propuesta revisable.' });
  }
  return issues;
}
export function validateIotCircuitSnapshot(snapshot: DomainSnapshot): Diagnostic[] {
  const entities = snapshot.records.filter((record): record is Extract<DomainSnapshot['records'][number], { kind: 'entity' }> => record.kind === 'entity').map((record) => record.value);
  const diagnostics: Diagnostic[] = [];
  for (const entity of entities) {
    if (entity.type !== IOT_CIRCUIT_TYPE || entity.typeVersion !== IOT_CIRCUIT_VERSION) continue;
    const model = iotCircuitData(entity);
    if (!model) { diagnostics.push(diagnostic('iot-circuit-invalid', 'El circuito IoT tiene un modelo inválido; se conservan sus bytes/datos para reparación.', { kind: 'entity', id: entity.id })); continue; }
    for (const issue of validateIotCircuitModel(model, entities, entity.id)) diagnostics.push(diagnostic(issue.code, issue.message,
      { kind: 'entity', id: entity.id }, 'VALIDATION_FAILED', issue.state === 'invalid' ? 'error' : 'warning'));
  }
  return diagnostics;
}

const csv = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] => [...values].sort((a, b) => key(a).localeCompare(key(b), 'en'));
function issueQuestions(issues: readonly IotCircuitIssue[]): string[] {
  return [...new Set(issues.filter((issue) => issue.state !== 'invalid').map((issue) => issue.message))];
}
function issueMarkdown(issues: readonly IotCircuitIssue[]): string {
  if (!issues.length) return '- Sin diagnósticos de reglas conocidas.';
  return (['invalid', 'incomplete', 'unknown'] as const).flatMap((state) => {
    const items = issues.filter((issue) => issue.state === state);
    return items.length ? [`### ${state}`, ...items.map((issue) => `- ${issue.message}`)] : [];
  }).join('\n');
}
/** Pure, deterministic serializer. It does not contact an AI provider or omit data by size. */
export function serializeIotCircuitContext(circuitEntity: IotCircuitEntitySummary, entities: readonly IotCircuitEntitySummary[]): Outcome<IotCircuitExports> {
  const model = iotCircuitData(circuitEntity);
  if (!model) return { ok: false, diagnostics: [diagnostic('iot-circuit-invalid', 'No se puede exportar un modelo de circuito IoT inválido.', { kind: 'entity', id: circuitEntity.id })] };
  const issues = validateIotCircuitModel(model, entities, circuitEntity.id);
  const byId = new Map(entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const rows = model.instances.flatMap((instance) => {
    const entity = byId.get(instance.entityId.toLowerCase()), metadata = entity && iotData(entity);
    return entity && metadata ? [{ instance, entity, metadata, ports: entity.ports as IotPort[] }] : [];
  });
  const bomCounts = new Map<string, { name: string; model: string; manufacturer: string; quantity: number; refs: string[]; entityIds: string[]; status: string }>();
  for (const instance of model.instances) {
    const entity = byId.get(instance.entityId.toLowerCase()), metadata = entity && iotData(entity);
    const key = metadata?.catalogId ?? `unresolved:${instance.entityId}`;
    const entry = bomCounts.get(key) ?? { name: metadata?.catalogId ?? 'unknown', model: metadata?.model ?? 'unknown',
      manufacturer: !metadata ? 'unknown: component Entity is missing or unsupported' : metadata.manufacturer.state === 'known' ? metadata.manufacturer.value : `unknown: ${metadata.manufacturer.reason}`,
      quantity: 0, refs: [], entityIds: [], status: metadata ? 'resolved' : 'unresolved' };
    entry.quantity++; entry.refs.push(instance.reference); entry.entityIds.push(instance.entityId); bomCounts.set(key, entry);
  }
  const bom = sorted([...bomCounts.values()], (item) => item.name + item.entityIds.join()).map((item) => [item.status, item.name, item.manufacturer, item.model, item.quantity, item.refs.sort().join('|'), item.entityIds.sort().join('|')].map(csv).join(','));
  const pinRows = rows.flatMap(({ instance, entity, ports }) => ports.map((port) => {
    const nets = model.nets.flatMap((net) => {
      const names = net.kind === 'bus' ? net.bus!.members.filter((lane) => lane.endpoints.some((endpoint) => endpoint.entityId.toLowerCase() === entity.id.toLowerCase() && endpoint.portId === port.id)).map((lane) => `${net.id}:${net.name}/${lane.id}:${lane.name}`) :
        net.endpoints.some((endpoint) => endpoint.entityId.toLowerCase() === entity.id.toLowerCase() && endpoint.portId === port.id) ? [`${net.id}:${net.name}`] : [];
      return names;
    });
    const evidence = port.signalType.state === 'known' ? port.signalType.value : `unknown: ${port.signalType.reason}`;
    return [instance.reference, entity.id, port.id, port.label ?? '', port.direction, evidence, port.bus.state === 'known' ? port.bus.value.join('|') : `unknown: ${port.bus.reason}`,
      nets.sort().join('|')].map(csv).join(',');
  }));
  const connections = sorted(model.nets, (net) => net.id).map((net) => ({ id: net.id, name: net.name, kind: net.kind,
    bus: net.bus ?? null, endpoints: sorted(net.endpoints, (endpoint) => `${endpoint.entityId}:${endpoint.portId}`),
    junctions: sorted(net.junctions, (junction) => junction.id), notes: [...net.notes] }));
  const openQuestions = [...new Set([...model.questions, ...issueQuestions(issues)])].sort((a, b) => a.localeCompare(b, 'en'));
  const sources = rows.map(({ instance, entity, metadata }) => ({ entityId: entity.id, title: instance.reference,
    sources: metadata.sources.map((source) => ({ ...source })) })).sort((a, b) => a.entityId.localeCompare(b.entityId, 'en'));
  const sourceManifest = sources.flatMap((item) => item.sources.map((source) => `- ${item.title} (${item.entityId}): ${source.title} — ${source.url}${source.documentRevision ? ` [${source.documentRevision}]` : ''}`));
  const params = [
    ...model.parameters.map((param) => `- ${param.name}: ${param.value.state === 'known' ? JSON.stringify(param.value.value) : `desconocido (${param.value.reason})`}${param.unit ? ` ${param.unit}` : ''}`),
    ...model.instances.flatMap((instance) => Object.entries(instance.parameters).map(([name, value]) => `- ${instance.reference}.${name}: ${value.state === 'known' ? JSON.stringify(value.value) : `desconocido (${value.reason})`}`))
  ].join('\n');
  const constraints = model.constraints.map((item) => `- [${item.state}] ${item.statement}${item.source ? ` (fuente: ${item.source})` : ''}`).join('\n');
  const requirements = model.requirements.map((item) => `- ${item}`).join('\n');
  const notes = model.notes.map((item) => `### Nota ${item.id}\n\n${item.markdown}`).join('\n\n');
  const omitted = model.instances.filter((instance) => !rows.some((row) => row.entity.id.toLowerCase() === instance.entityId.toLowerCase())).map((instance) => instance.entityId).sort();
  const manifestIds = [circuitEntity.id, ...model.instances.map((instance) => instance.entityId)].sort();
  const markdown = [`# Contexto de circuito: ${circuitEntity.title}`, `Circuit entity ID: ${circuitEntity.id}`,
    '\n## Manifiesto de alcance\n\n' + `Entity IDs incluidos: ${manifestIds.join(', ') || 'ninguno'}.\nFuentes de componente resueltas: ${sources.reduce((sum, item) => sum + item.sources.length, 0)}.\nEntidades referenciadas sin fuente incluida: ${omitted.join(', ') || 'ninguna'}.\nOmisiones por límite de tamaño: ninguna.\n\n${sourceManifest.join('\n') || '- Sin fuentes resueltas.'}`,
    '\n## BOM\n\n' + [['status', 'catalog_id', 'manufacturer', 'model', 'quantity', 'references', 'entity_ids'].map(csv).join(','), ...bom].join('\n'),
    '\n## Redes y conexiones\n\n' + JSON.stringify(connections, null, 2),
    '\n## Tabla de pines\n\n' + [['reference', 'entity_id', 'port_id', 'label', 'direction', 'signal', 'bus', 'nets'].map(csv).join(','), ...pinRows].join('\n'),
    '\n## Parámetros\n\n' + (params || '- Sin parámetros definidos.'), '\n## Requisitos\n\n' + (requirements || '- Sin requisitos registrados.'),
    '\n## Restricciones\n\n' + (constraints || '- Sin restricciones registradas.'), '\n## Preguntas pendientes\n\n' + (openQuestions.map((item) => `- ${item}`).join('\n') || '- Ninguna registrada; los valores desconocidos se listan donde aparecen.'),
    '\n## Diagnósticos de reglas conocidas\n\n' + issueMarkdown(issues),
    '\n## Notas\n\n' + (notes || '- Sin notas.'),
    '\n## Propuestas de código\n\n' + (model.codeProposals.map((item) => `### Propuesta ${item.id} (${item.language})\n\nEstado: propuesta no ejecutada. Redes fuente: ${item.sourceNetIds.join(', ') || 'ninguna'}.\n\n\`\`\`${item.language}\n${item.content}\n\`\`\``).join('\n\n') || '- No hay propuestas de código.'),
    '\n## Alcance y confianza\n\nEste contexto es una serialización de datos y reglas conocidas; no ejecuta simulación eléctrica ni certifica el circuito. No se aplicó un límite de tamaño y no se omitieron fuentes por truncamiento.'
  ].join('\n');
  return { ok: true, diagnostics: [], value: { manifest: { entityIds: manifestIds, sources, omitted },
    bomCsv: [['status', 'catalog_id', 'manufacturer', 'model', 'quantity', 'references', 'entity_ids'].map(csv).join(','), ...bom].join('\n') + '\n',
    connectionsJson: JSON.stringify({ circuitEntityId: circuitEntity.id, nets: connections }, null, 2) + '\n',
    pinTableCsv: [['reference', 'entity_id', 'port_id', 'label', 'direction', 'signal', 'bus', 'nets'].map(csv).join(','), ...pinRows].join('\n') + '\n',
    contextMarkdown: markdown.replace(/\n{3,}/g, '\n\n') + '\n', issues } };
}
