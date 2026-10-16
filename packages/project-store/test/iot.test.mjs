import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalProjectManager } from '../dist/index.js';
import { IOT_CATALOG } from '@a3/domain';
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
  const unchanged = await manager.loadCanvasWorkspace(sessionId, W1);
  assert.equal(unchanged.entities.some((item) => item.type === 'a3.iot.component'), false);
  assert.equal(unchanged.placements.length, initial.placements.length);
});
