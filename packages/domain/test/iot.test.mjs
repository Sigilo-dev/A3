import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { IOT_CATALOG, IOT_COLLECTIONS, IOT_VERSION, createIotEntity, iotCatalogEntry, isIotComponent, prepareCommand, validateSnapshot } from '../dist/src/index.js';
import { IOT_CIRCUIT_KEY, IOT_CIRCUIT_TYPE, createIotCircuitEntity, emptyIotCircuit, serializeIotCircuitContext, validateIotCircuitModel, validIotCircuitOperation } from '../dist/src/iot-circuit.js';
import { context, fixture, find, id, request, success, rejection, W1 } from './fixture.mjs';

const catalogFixture = JSON.parse(readFileSync(new URL('../../../fixtures/e3/iot/catalog.json', import.meta.url), 'utf8'));
const circuitFixture = JSON.parse(readFileSync(new URL('../../../fixtures/e3/iot/circuit.json', import.meta.url), 'utf8'));
let sequence = 24000;

test('A3-014 catalogue fixture covers the eight initial collections and exact identified components', () => {
  assert.deepEqual(IOT_COLLECTIONS.map((item) => item.id), catalogFixture.collections);
  assert.equal(IOT_CATALOG.length, catalogFixture.entries.length);
  for (const expected of catalogFixture.entries) {
    const entry = IOT_CATALOG.find((item) => item.catalogId === expected.catalogId);
    assert.ok(entry, `${expected.catalogId} exists`);
    assert.equal(entry.collectionId, expected.collectionId);
    assert.equal(entry.model, expected.model);
    assert.equal(entry.manufacturer.state, expected.manufacturerState);
    assert.equal(entry.revision.state, expected.revisionState);
    if (entry.manufacturer.state === 'known') assert.ok(entry.manufacturer.value.trim());
    if (entry.revision.state === 'known') assert.ok(entry.revision.value.trim());
    assert.equal(entry.ports.length, expected.portCount);
    assert.ok(entry.sources.length > 0 && entry.sources.every((source) => source.title && source.url));
    assert.ok(entry.ports.every((port) => port.id && port.label && port.function && port.direction && port.signalType && port.bus && port.limits && port.sourceIds.length));
    assert.equal(new Set(entry.ports.map((port) => port.id)).size, entry.ports.length);
    for (const port of entry.ports) assert.ok(port.sourceIds.every((sourceId) => sourceId < entry.sources.length));
    for (const portId of expected.mustContain ?? []) assert.ok(entry.ports.some((port) => port.id === portId), `${expected.catalogId} has documented port ${portId}`);
    for (const portId of expected.mustBeReserved ?? []) assert.equal(entry.ports.find((port) => port.id === portId)?.availability, 'reserved');
    if (expected.revisionState === 'unknown') assert.equal(entry.revision.state, 'unknown');
    if (expected.manufacturerState === 'unknown') assert.equal(entry.manufacturer.state, 'unknown');
    if (expected.template) assert.equal(entry.template, true);
  }
  const esp = IOT_CATALOG.find((item) => item.catalogId === 'espressif.esp32-devkitc-v4-32e');
  assert.equal(esp.model, 'ESP32-DevKitC-32E / ESP32-WROOM-32E');
  assert.match(esp.ports.find((port) => port.id === 'j2.16').function, /SPI flash/);
  const pico = IOT_CATALOG.find((item) => item.catalogId === 'raspberry-pi.pico-w-sc0918');
  assert.deepEqual(pico.ports.find((port) => port.id === 'header.1').bus, { state: 'known', value: ['UART0', 'I2C0', 'SPI0'] });
  assert.equal(pico.ports.find((port) => port.id === 'header.1').limits.electrical.state, 'unknown');
  assert.deepEqual(IOT_CATALOG.find((item) => item.catalogId === 'bosch.bme280').ports.find((port) => port.id === 'package.8').limits.voltage,
    { state: 'known', value: { min: 1.71, max: 3.6, unit: 'V' } });
  const uno = IOT_CATALOG.find((item) => item.catalogId === 'arduino.uno-r3-a000066');
  assert.deepEqual(uno.ports.find((port) => port.id === 'jdigital.01').limits.current, { state: 'known', value: { max: 20, unit: 'mA' } });
  assert.deepEqual(uno.ports.find((port) => port.id === 'janalog.04').limits.current, { state: 'known', value: { max: 50, unit: 'mA' } });
  assert.equal(uno.ports.find((port) => port.id === 'jdigital.16').limits.electrical.state, 'unknown', 'AREF is not an I/O current limit');
  assert.equal(uno.ports.find((port) => port.id === 'janalog.03').limits.electrical.state, 'unknown', 'RESET has no inferred GPIO limit');
  assert.deepEqual(IOT_CATALOG.find((item) => item.catalogId === 'yageo.rc0603fr-0710kl').ports[0].limits.electrical,
    { state: 'unknown', reason: 'No se publicaron límites por puerto en la fuente consultada.' });
});

test('component command atomically creates one identified Entity and Placement with canonical source and port IDs', () => {
  const state = fixture(), entry = IOT_CATALOG.find((item) => item.catalogId === 'bosch.bme280');
  const entityId = id(++sequence), placementId = id(++sequence), payload = { workspaceId: W1, entityId, placementId,
    catalogId: entry.catalogId, title: 'BME280 interior', position: { x: 430, y: 180 } };
  const req = request(state, 'a3.iot.create-component', payload, [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId: W1 }]);
  req.scope.entityIds.push(entityId);
  const plan = success(prepareCommand(state, req, context()));
  const next = plan.nextSnapshot, entity = find(next, 'entity', entityId).value, placement = find(next, 'placement', placementId, W1).value;
  assert.equal(entity.type, 'a3.iot.component'); assert.equal(entity.typeVersion, IOT_VERSION); assert.equal(entity.title, 'BME280 interior');
  assert.deepEqual(entity.ports.map((port) => port.id), entry.ports.map((port) => port.id));
  assert.deepEqual(entity.properties['a3.iot.component'].sources, entry.sources);
  assert.equal(entity.properties['a3.iot.component'].revision.state, 'unknown');
  assert.equal(placement.entityId, entityId); assert.deepEqual(placement.position, payload.position);
  assert.equal(next.records.filter((record) => ['entity', 'placement'].includes(record.kind) &&
    (record.kind === 'entity' ? record.value.id === entityId : record.value.id === placementId)).length, 2);
  assert.equal(next.records.some((record) => record.kind === 'relation' && record.value.type.startsWith('a3.iot.')), false);
  assert.equal(isIotComponent(entity), true);
  assert.deepEqual(validateSnapshot(next, context().registry).filter((item) => item.severity === 'error'), []);
});

test('catalogued entities preserve unknown extensions and validation rejects ambiguous port identities', () => {
  const entity = createIotEntity(id(++sequence), 'UNO', iotCatalogEntry('arduino.uno-r3-a000066'));
  entity.properties['a3.iot.component'].futureSourceMetadata = { keep: ['byte-preserving', 3] };
  const state = fixture(); state.records.push({ kind: 'entity', value: entity });
  assert.equal(isIotComponent(entity), true);
  assert.deepEqual(entity.properties['a3.iot.component'].futureSourceMetadata, { keep: ['byte-preserving', 3] });
  const duplicate = structuredClone(entity); duplicate.id = id(++sequence); duplicate.ports.push({ ...structuredClone(duplicate.ports[0]), label: 'mismo ID con etiqueta distinta' });
  const broken = fixture(); broken.records.push({ kind: 'entity', value: duplicate });
  assert.ok(validateSnapshot(broken, context().registry).some((item) => item.detail === 'iot-port-id-duplicate'));
});

test('domain command refuses unknown and generic-template catalogue IDs without modifying the project', () => {
  const state = fixture(), payload = { workspaceId: W1, entityId: id(++sequence), placementId: id(++sequence),
    catalogId: 'not.installed.part', title: 'Invented', position: { x: 0, y: 0 } };
  const req = request(state, 'a3.iot.create-component', payload, [{ kind: 'entity', id: payload.entityId }, { kind: 'placement', id: payload.placementId, workspaceId: W1 }]);
  req.scope.entityIds.push(payload.entityId);
  rejection(prepareCommand(state, req, context()), 'iot-component-command-invalid');
  const template = { ...payload, catalogId: 'a3.generic.connector' }, templateRequest = request(state, 'a3.iot.create-component', template,
    [{ kind: 'entity', id: template.entityId }, { kind: 'placement', id: template.placementId, workspaceId: W1 }]);
  templateRequest.scope.entityIds.push(template.entityId);
  rejection(prepareCommand(state, templateRequest, context()), 'iot-component-command-invalid');
});

function fixtureComponents() {
  return [
    createIotEntity('90000000-0000-4000-8000-000000000201', 'ESP32', iotCatalogEntry('espressif.esp32-devkitc-v4-32e')),
    createIotEntity('90000000-0000-4000-8000-000000000202', 'BME280', iotCatalogEntry('bosch.bme280'))
  ];
}

test('E3-C2 models instances and a multi-pin bus/power/ground networks with stable IDs and junctions', () => {
  const components = fixtureComponents(), circuit = createIotCircuitEntity(id(++sequence), 'Sensor controller');
  const issues = validateIotCircuitModel(circuitFixture, [...components, circuit], circuit.id);
  assert.equal(issues.some((issue) => issue.state === 'invalid'), false, JSON.stringify(issues));
  assert.equal(circuit.type, IOT_CIRCUIT_TYPE);
  assert.deepEqual(circuit.properties[IOT_CIRCUIT_KEY], emptyIotCircuit());
  assert.equal(circuitFixture.instances.length, 2);
  const i2c = circuitFixture.nets.find((net) => net.kind === 'bus');
  assert.equal(i2c.endpoints.length, 0, 'the bus bundle is not one electrical net');
  assert.equal(i2c.bus.members.length, 2, 'SDA and SCL remain independent lanes');
  assert.equal(i2c.bus.members[0].endpoints.length, 2);
  assert.equal(i2c.bus.members[0].junctions[0].id, '90000000-0000-4000-8000-000000000401');
  assert.deepEqual(i2c.bus.members.map((lane) => lane.name), ['SDA', 'SCL']);
  assert.equal(validIotCircuitOperation({ kind: 'replace-model', model: circuitFixture }), true);
});

test('E3-C2 distinguishes known conflicts, incomplete networks and unknown limits', () => {
  const [esp, bme] = fixtureComponents();
  const bad = structuredClone(circuitFixture);
  bad.nets[1].endpoints[0].portId = 'j2.19'; // documented 5 V rail connected to BME VDD (known max 3.6 V)
  bad.nets[2].endpoints.push({ entityId: esp.id, portId: 'j2.19' }); // known ground and power pins share a net
  bad.nets[0].bus.members[0].endpoints.pop(); bad.nets[0].bus.protocol = { state: 'unknown', reason: 'protocol not selected' };
  bad.parameters[0].value = { state: 'unknown', reason: 'frequency not selected' };
  bad.nets.push({ id: '90000000-0000-4000-8000-000000000304', name: 'pending', kind: 'signal', endpoints: [
    { entityId: esp.id, portId: 'j3.04' }], junctions: [], notes: [], extensions: {} });
  const issues = validateIotCircuitModel(bad, [esp, bme]);
  assert.ok(issues.some((issue) => issue.state === 'invalid' && issue.code === 'known-voltage-conflict'));
  assert.ok(issues.some((issue) => issue.state === 'invalid' && issue.code === 'power-ground-short'));
  assert.ok(issues.some((issue) => issue.state === 'incomplete' && issue.code === 'net-incomplete'));
  assert.ok(issues.some((issue) => issue.state === 'unknown' && issue.code === 'bus-protocol-unknown'));
  assert.ok(issues.some((issue) => issue.state === 'unknown' && issue.code === 'circuit-parameter-unknown'));
});

test('E3-C2 rejects missing pins and duplicate pin membership without changing any canonical records', () => {
  const [esp, bme] = fixtureComponents(), bad = structuredClone(circuitFixture);
  bad.nets[0].bus.members[0].endpoints[0].portId = 'not-a-real-pin';
  bad.nets[1].endpoints.push({ entityId: esp.id, portId: 'j2.01' });
  const issues = validateIotCircuitModel(bad, [esp, bme]);
  assert.ok(issues.some((issue) => issue.code === 'net-pin-missing' && issue.state === 'invalid'));
  assert.ok(issues.some((issue) => issue.code === 'pin-multiple-nets' && issue.state === 'invalid'));
});

test('E3-C2 reports a known bus protocol mismatch only when the component documents its alternatives', () => {
  const [esp, bme] = fixtureComponents(), bad = structuredClone(circuitFixture);
  bad.nets[0].bus.members[0].endpoints[1].portId = 'package.5'; // BME SDO documents SPI, not I2C.
  const issues = validateIotCircuitModel(bad, [esp, bme]);
  assert.ok(issues.some((issue) => issue.state === 'invalid' && issue.code === 'bus-protocol-incompatible'));
  assert.ok(issues.some((issue) => issue.state === 'unknown' && issue.code === 'pin-bus-support-unknown'), 'ESP32 alternative function data remains unknown');
});

test('E3-C2 keeps code as a proposal and validates its network provenance IDs', () => {
  const [esp, bme] = fixtureComponents(), model = structuredClone(circuitFixture);
  model.codeProposals.push({ id: '90000000-0000-4000-8000-000000000801', language: 'cpp', content: 'void setup() {}', sourceNetIds: [model.nets[0].id], state: 'proposal' });
  assert.ok(!validateIotCircuitModel(model, [esp, bme]).some((issue) => issue.code === 'proposal-net-missing'));
  model.codeProposals[0].sourceNetIds = ['90000000-0000-4000-8000-000000009999'];
  assert.ok(validateIotCircuitModel(model, [esp, bme]).some((issue) => issue.state === 'invalid' && issue.code === 'proposal-net-missing'));
});

test('E3-C2 exports deterministic BOM, ID-based connection JSON, pin table and open questions with sources', () => {
  const components = fixtureComponents(), circuit = createIotCircuitEntity(id(++sequence), 'Sensor controller');
  circuit.properties[IOT_CIRCUIT_KEY] = structuredClone(circuitFixture);
  const first = serializeIotCircuitContext(circuit, [...components, circuit]);
  const second = serializeIotCircuitContext(circuit, [...components, circuit]);
  assert.equal(first.ok, true);
  assert.equal(first.value.bomCsv, second.value.bomCsv);
  assert.equal(first.value.connectionsJson, second.value.connectionsJson);
  assert.match(first.value.connectionsJson, /"entityId": "90000000-0000-4000-8000-000000000201"/);
  assert.match(first.value.pinTableCsv, /package\.8/);
  assert.match(first.value.contextMarkdown, /lista de materiales|BOM/i);
  assert.match(first.value.contextMarkdown, /pull-up value/);
  assert.match(first.value.contextMarkdown, /bme280 datasheet/i);
  assert.match(first.value.contextMarkdown, /Diagnostics|Diagnósticos/);
  assert.equal(first.value.manifest.sources.length, 2);
  assert.deepEqual(first.value.manifest.omitted, []);
  assert.match(first.value.contextMarkdown, /no ejecuta simulación eléctrica ni certifica/);
  const missingSource = serializeIotCircuitContext(circuit, [components[0], circuit]);
  assert.deepEqual(missingSource.value.manifest.omitted, [components[1].id]);
  assert.match(missingSource.value.bomCsv, /unresolved/);
  assert.match(missingSource.value.contextMarkdown, new RegExp(components[1].id));
});

test('E3-C2 domain commands create a persisted circuit entity and reject malformed model replacement', () => {
  const state = fixture(), entityId = id(++sequence), placementId = id(++sequence);
  const createPayload = { workspaceId: W1, entityId, placementId, title: 'Circuito', position: { x: 20, y: 30 } };
  const createRequest = request(state, 'a3.iot.create-circuit', createPayload, [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId: W1 }]);
  createRequest.scope.entityIds.push(entityId);
  const created = success(prepareCommand(state, createRequest, context()));
  assert.equal(find(created.nextSnapshot, 'entity', entityId).value.type, IOT_CIRCUIT_TYPE);
  const invalidUpdate = request(created.nextSnapshot, 'a3.iot.change-circuit', { entityId, operation: { kind: 'replace-model', model: { ...circuitFixture, nets: [{ ...circuitFixture.nets[0], endpoints: [{ entityId, portId: 'missing' }] }] } } });
  invalidUpdate.scope.entityIds.push(entityId);
  rejection(prepareCommand(created.nextSnapshot, invalidUpdate, context()));
});
