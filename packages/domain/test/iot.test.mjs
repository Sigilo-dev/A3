import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { IOT_CATALOG, IOT_COLLECTIONS, IOT_VERSION, createIotEntity, iotCatalogEntry, isIotComponent, prepareCommand, validateSnapshot } from '../dist/src/index.js';
import { context, fixture, find, id, request, success, rejection, W1 } from './fixture.mjs';

const catalogFixture = JSON.parse(readFileSync(new URL('../../../fixtures/e3/iot/catalog.json', import.meta.url), 'utf8'));
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
