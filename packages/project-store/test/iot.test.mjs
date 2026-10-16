import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalProjectManager } from '../dist/index.js';
import { IOT_CATALOG } from '@a3/domain';
import { readFileSync } from 'node:fs';
import { iotCircuitData, isIotCircuit } from '@a3/domain/iot-circuit';
import { join } from 'node:path';
import { scratch, fixtureHost, W1 } from './fixture.mjs';

test('A3-014 exact IoT component writes through broker/store and survives close/reopen with port IDs', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'iot-user', 'trabajar');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let sessionId = (await manager.openFolder(root)).active.sessionId;
  const initial = await manager.loadCanvasWorkspace(sessionId, W1);
  const component = IOT_CATALOG.find((entry) => entry.catalogId === 'espressif.esp32-devkitc-v4-32e');
  const canvas = await manager.createCanvasIotComponent(sessionId, W1, initial.revision, component.catalogId, 'ESP32 exacto', { x: 800, y: 90 });
  const entity = canvas.entities.find((item) => item.title === 'ESP32 exacto');
  const placement = canvas.placements.find((item) => item.entityId === entity.id);
  assert.ok(entity.typeAvailable); assert.equal(entity.type, 'a3.iot.component');
  assert.deepEqual(entity.ports.map((port) => port.id), component.ports.map((port) => port.id));
  assert.deepEqual(placement.position, { x: 800, y: 90 });
  assert.equal(canvas.history.canUndo, true);
  await manager.closeActive(sessionId);
  sessionId = (await manager.openFolder(root)).active.sessionId;
  const reopened = await manager.loadCanvasWorkspace(sessionId, W1), saved = reopened.entities.find((item) => item.id === entity.id);
  assert.equal(saved.typeAvailable, true); assert.equal(saved.properties['a3.iot.component'].revision.value, 'DevKitC V4; módulo WROOM-32E');
  assert.deepEqual(saved.ports.map((port) => port.id), component.ports.map((port) => port.id));
  assert.equal(reopened.placements.find((item) => item.id === placement.id).entityId, entity.id);
});

test('read-only project profile denies IoT component creation without adding an entity or placement', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'iot-reader', 'consultar');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const sessionId = (await manager.openFolder(root)).active.sessionId, initial = await manager.loadCanvasWorkspace(sessionId, W1);
  const component = IOT_CATALOG.find((entry) => entry.catalogId === 'bosch.bme280');
  await assert.rejects(manager.createCanvasIotComponent(sessionId, W1, initial.revision, component.catalogId, 'Sensor', { x: 0, y: 0 }),
    (error) => error.code === 'PERMISSION_DENIED');
  await assert.rejects(manager.createCanvasIotCircuit(sessionId, W1, initial.revision, 'Circuito denegado', { x: 100, y: 100 }),
    (error) => error.code === 'PERMISSION_DENIED');
  const unchanged = await manager.loadCanvasWorkspace(sessionId, W1);
  assert.equal(unchanged.entities.some((item) => item.type === 'a3.iot.component'), false);
  assert.equal(unchanged.entities.some((item) => item.type === 'a3.iot.circuit'), false);
  assert.equal(unchanged.placements.length, initial.placements.length);
});

test('E3-C2 A3-014 circuit networks persist through broker, store, history and project reopen', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'iot-circuit-user', 'trabajar');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let sessionId = (await manager.openFolder(root)).active.sessionId, state = await manager.loadCanvasWorkspace(sessionId, W1);
  const espEntry = IOT_CATALOG.find((entry) => entry.catalogId === 'espressif.esp32-devkitc-v4-32e');
  const bmeEntry = IOT_CATALOG.find((entry) => entry.catalogId === 'bosch.bme280');
  state = await manager.createCanvasIotComponent(sessionId, W1, state.revision, espEntry.catalogId, 'ESP32 circuito', { x: 100, y: 100 });
  state = await manager.createCanvasIotComponent(sessionId, W1, state.revision, bmeEntry.catalogId, 'BME circuito', { x: 500, y: 100 });
  const esp = state.entities.find((entity) => entity.title === 'ESP32 circuito'), bme = state.entities.find((entity) => entity.title === 'BME circuito');
  state = await manager.createCanvasIotCircuit(sessionId, W1, state.revision, 'Sensor I2C', { x: 900, y: 100 });
  const circuit = state.entities.find((entity) => entity.title === 'Sensor I2C');
  assert.ok(isIotCircuit(circuit));
  const model = JSON.parse(readFileSync(new URL('../../../fixtures/e3/iot/circuit.json', import.meta.url), 'utf8'));
  const replacements = new Map([
    ['90000000-0000-4000-8000-000000000201', esp.id],
    ['90000000-0000-4000-8000-000000000202', bme.id]
  ]);
  const rewrite = (value) => typeof value === 'string' ? replacements.get(value) ?? value : Array.isArray(value) ? value.map(rewrite) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)])) : value;
  const savedModel = rewrite(model);
  state = await manager.changeCanvasIotCircuit(sessionId, W1, circuit.id, circuit.revision, savedModel);
  const savedCircuit = state.entities.find((entity) => entity.id === circuit.id);
  assert.equal(iotCircuitData(savedCircuit).nets.find((net) => net.kind === 'bus').bus.members.length, 2);
  assert.equal(iotCircuitData(savedCircuit).nets.find((net) => net.kind === 'bus').endpoints.length, 0);
  assert.equal(state.history.canUndo, true);
  await assert.rejects(manager.changeCanvasIotCircuit(sessionId, W1, circuit.id, circuit.revision, savedModel), (error) => error.code === 'REVISION_CONFLICT');
  await manager.closeActive(sessionId);
  sessionId = (await manager.openFolder(root)).active.sessionId;
  const reopened = await manager.loadCanvasWorkspace(sessionId, W1), restored = reopened.entities.find((entity) => entity.id === circuit.id);
  assert.deepEqual(iotCircuitData(restored), savedModel);
  assert.ok(reopened.placements.some((placement) => placement.entityId === circuit.id));
});
