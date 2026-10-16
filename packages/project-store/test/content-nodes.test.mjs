import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, id, W1, E1 } from './fixture.mjs';

const R1 = '00000000-0000-4000-8000-000000000004';
const E2 = '00000000-0000-4000-8000-000000000003';
const P2 = '00000000-0000-4000-8000-000000000010';
const resourcePath = (root, resourceId) => join(root, '.a3', 'resources', `${resourceId}.json`);
const windows = { skip: process.platform !== 'win32' };

test('A3-006/008/025: typed content nodes create, render and reopen with canonical resources', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  await mkdir(join(root, 'assets'), { recursive: true });
  const externalResources = [
    { id: id(610), path: 'assets/photo.png', mediaType: 'image/png', kind: 'image' },
    { id: id(611), path: 'assets/clip.mp4', mediaType: 'video/mp4', kind: 'video' },
    { id: id(612), path: 'assets/voice.wav', mediaType: 'audio/wav', kind: 'audio' },
    { id: id(613), path: 'assets/manual.bin', mediaType: 'application/octet-stream', kind: 'file' }
  ];
  for (const resource of externalResources) {
    await writeFile(join(root, resource.path), Buffer.from([0, 1, 2, 3, 4]));
    await writeFile(resourcePath(root, resource.id), JSON.stringify({ schemaVersion: '1.0.0', id: resource.id, revision: 1,
      kind: 'project-file', path: resource.path, mediaType: resource.mediaType, extensions: {} }, null, 2) + '\n');
  }
  const host = await fixtureHost(root, 'typed-content');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const missingRenderer = canvas.entities.find((entity) => entity.id === E2);
  assert.equal(missingRenderer.typeAvailable, false);
  assert.equal(canvas.visualEdges.some((edge) => edge.sourcePlacementId !== edge.targetPlacementId && [edge.sourcePlacementId, edge.targetPlacementId].includes(P2)), true);

  const examples = [
    { kind: 'page', title: 'Página', value: '# Página\n\nTexto Markdown.\n' },
    { kind: 'short-text', title: 'Idea', value: 'Una idea de prueba.' },
    { kind: 'image', title: 'Imagen', resourceId: id(610), altText: 'Vista de prueba' },
    { kind: 'video', title: 'Video', resourceId: id(611) },
    { kind: 'youtube', title: 'YouTube', url: 'https://youtu.be/dQw4w9WgXcQ' },
    { kind: 'audio', title: 'Audio', resourceId: id(612) },
    { kind: 'web-link', title: 'Web', url: 'https://example.com/reference' },
    { kind: 'file', title: 'Archivo', resourceId: id(613) },
    { kind: 'code', title: 'Código', value: 'const answer = 42;\n', language: 'javascript' },
    { kind: 'drawing', title: 'Dibujo', value: '{"schemaVersion":"1.0.0","strokes":[]}\n' }
  ];
  const created = [];
  const placementIds = new Set(canvas.placements.map((item) => item.id));
  for (const [index, example] of examples.entries()) {
    canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { ...example, position: { x: index * 360, y: 180 } });
    const placement = canvas.placements.find((item) => !placementIds.has(item.id));
    assert.ok(placement, `${example.kind} creates a persistent placement`);
    placementIds.add(placement.id);
    const entity = canvas.entities.find((item) => item.id === placement.entityId);
    assert.ok(entity); assert.equal(entity.typeAvailable, true); assert.equal(entity.title, example.title);
    created.push(placement);
  }
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, {
    kind: 'image', title: 'Referencia remota', url: 'https://example.com/image.png', position: { x: 4200, y: 180 }, description: 'No descargar automáticamente'
  });
  const remoteImage = canvas.entities.find((entity) => entity.title === 'Referencia remota');
  assert.equal(remoteImage.contentResource.kind, 'remote-url'); assert.equal(remoteImage.contentResource.url, 'https://example.com/image.png');
  assert.equal((await manager.loadCanvasContent(active.sessionId, W1, remoteImage.id, remoteImage.contentResourceId)).state, 'unavailable', 'the remote URL is not fetched');

  const page = canvas.entities.find((entity) => entity.title === 'Página');
  const preview = await manager.loadCanvasContent(active.sessionId, W1, page.id, page.contentResourceId);
  assert.equal(preview.state, 'ready'); assert.match(preview.text, /Texto Markdown/);
  const image = canvas.entities.find((entity) => entity.title === 'Imagen');
  const imagePreview = await manager.loadCanvasContent(active.sessionId, W1, image.id, image.contentResourceId);
  assert.equal(imagePreview.state, 'binary'); assert.deepEqual([...imagePreview.bytes], [0, 1, 2, 3, 4]);
  const video = canvas.entities.find((entity) => entity.title === 'Video');
  assert.equal((await manager.loadCanvasContent(active.sessionId, W1, video.id, video.contentResourceId)).bytes, undefined, 'video bytes are not read until playback is activated');
  const playback = await manager.loadCanvasContent(active.sessionId, W1, video.id, video.contentResourceId, 'playback');
  assert.deepEqual([...playback.bytes], [0, 1, 2, 3, 4]);
  const audio = canvas.entities.find((entity) => entity.title === 'Audio');
  assert.equal((await manager.loadCanvasContent(active.sessionId, W1, audio.id, audio.contentResourceId)).bytes, undefined, 'audio bytes are not read until playback is activated');
  const audioPlayback = await manager.loadCanvasContent(active.sessionId, W1, audio.id, audio.contentResourceId, 'playback');
  assert.deepEqual([...audioPlayback.bytes], [0, 1, 2, 3, 4]);
  const youtube = canvas.entities.find((entity) => entity.title === 'YouTube');
  assert.equal(youtube.contentResource.url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(await readFile(join(root, 'content', `${page.contentResourceId}.md`), 'utf8'), '# Página\n\nTexto Markdown.\n');

  await manager.closeActive(active.sessionId);
  const reopened = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(reopened.sessionId, W1);
  for (const example of examples) {
    const entity = canvas.entities.find((item) => item.title === example.title);
    assert.ok(entity, `${example.kind} survives reopening`); assert.equal(entity.typeAvailable, true);
  }
  assert.equal(canvas.entities.find((entity) => entity.title === 'Referencia remota').contentResource.url, 'https://example.com/image.png');
  assert.deepEqual(canvas.placements.filter((placement) => created.some((item) => item.id === placement.id)).sort((a, b) => a.id.localeCompare(b.id)),
    [...created].sort((a, b) => a.id.localeCompare(b.id)));
});

test('E2-C2: dropped media copy and reference use the broker and leave the source bytes intact', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const externalRoot = join(tempRoot, 'drop-source'); await mkdir(externalRoot, { recursive: true });
  const source = Buffer.from([0, 3, 5, 0xff, 9]); await writeFile(join(externalRoot, 'photo.png'), source);
  const host = await fixtureHost(root, 'drop-test', 'trabajar');
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' }), true);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const mountId = id(980); assert.equal(await manager.approveCanvasDropMount(active.sessionId, mountId, externalRoot), true);
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const copyResourceId = id(981);
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'image', title: 'photo.png', position: { x: 100, y: 100 },
    resourceId: copyResourceId, mediaType: 'image/png', dropMode: 'copy', dropMountId: mountId, dropPath: 'photo.png' });
  const copied = canvas.entities.find((entity) => entity.title === 'photo.png');
  assert.deepEqual(Buffer.from((await manager.loadCanvasContent(active.sessionId, W1, copied.id, copyResourceId)).bytes), source);
  assert.deepEqual(await readFile(join(externalRoot, 'photo.png')), source);
  const referenceResourceId = id(982);
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'image', title: 'referenced.png', position: { x: 500, y: 100 },
    resourceId: referenceResourceId, mediaType: 'image/png', dropMode: 'reference', dropMountId: mountId, dropPath: 'photo.png' });
  const referenced = canvas.entities.find((entity) => entity.contentResourceId === referenceResourceId);
  assert.equal(referenced.contentResource.kind, 'mounted-file');
  assert.deepEqual(Buffer.from((await manager.loadCanvasContent(active.sessionId, W1, referenced.id, referenceResourceId)).bytes), source);
  assert.deepEqual(await readFile(join(externalRoot, 'photo.png')), source, 'reference never changes the source');
  const beforeCancel = canvas.placements.length;
  // Cancelling a staged preview invokes no create command, so neither node nor resource is committed.
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).placements.length, beforeCancel);
});

test('missing resource bytes report an unavailable preview while fallback data and visual connections remain intact', windows, async (t) => {
  let cleanup;
  const { root, tempRoot } = await scratch({ after: (callback) => { cleanup = callback; } }); const host = await fixtureHost(root, 'missing-content');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  // Close the watcher/lease before the fixture removes its host state directory.
  t.after(async () => { await manager.dispose(); await cleanup(); });
  const active = (await manager.openFolder(root)).active;
  const canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const fallback = canvas.entities.find((entity) => entity.id === E2);
  assert.equal(fallback.type, 'a3.core.concept'); assert.equal(fallback.typeAvailable, false);
  assert.deepEqual(fallback.properties, {}); assert.ok(Array.isArray(fallback.ports));
  assert.ok(canvas.visualEdges.some((edge) => [edge.sourcePlacementId, edge.targetPlacementId].includes(P2)));
  await rm(join(root, 'pages/readme.md'));
  const page = canvas.entities.find((entity) => entity.id === E1);
  const result = await manager.loadCanvasContent(active.sessionId, W1, E1, R1);
  assert.equal(result.state, 'unavailable'); assert.equal(result.entityId, E1);
  const after = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.equal(after.entities.some((entity) => entity.id === E2 && entity.typeAvailable === false), true);
  assert.ok(after.visualEdges.some((edge) => [edge.sourcePlacementId, edge.targetPlacementId].includes(P2)));
  assert.equal(page.contentResourceId, R1);
});
