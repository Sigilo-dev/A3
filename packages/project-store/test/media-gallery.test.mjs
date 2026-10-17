import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildMediaGalleryCatalog, filterMediaGalleryItems, LocalProjectManager } from '../dist/index.js';
import { fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/media-gallery.json', import.meta.url)), 'utf8'));

test('A3-025 fixture: catalog deduplicates resources, sorts images before videos and resolves nested groups/collections', () => {
  const catalog = buildMediaGalleryCatalog(fixture);
  assert.deepEqual(catalog.items.map((item) => item.kind), ['image', 'image', 'video', 'video']);
  assert.equal(catalog.items.filter((item) => item.resourceId === '00000000-0000-4000-8000-000000000201').length, 1);
  const photo = catalog.items.find((item) => item.resourceId === '00000000-0000-4000-8000-000000000201');
  assert.equal(photo.representations.length, 2, 'one resource exposes both entity representations');
  const nested = photo.representations.find((item) => item.title === 'Foto A');
  assert.ok(nested.groupIds.includes('00000000-0000-4000-8000-000000000401'));
  assert.equal(nested.collectionIds[0], '00000000-0000-4000-8000-000000000501');
  assert.deepEqual(filterMediaGalleryItems(catalog.items, { groupId: '00000000-0000-4000-8000-000000000401' }).map((item) => item.label), ['photo.png', 'clip.mp4']);
  assert.deepEqual(filterMediaGalleryItems(catalog.items, { collectionId: '00000000-0000-4000-8000-000000000501' }).map((item) => item.label), ['photo.png', 'YouTube']);
  assert.deepEqual(filterMediaGalleryItems(catalog.items, { workspaceId: '00000000-0000-4000-8000-000000000009' }).map((item) => item.label), ['photo.png']);
  assert.deepEqual(filterMediaGalleryItems(catalog.items, { tag: 'referencia', kind: 'video' }).map((item) => item.label), ['clip.mp4', 'YouTube']);
  assert.equal(catalog.items.some((item) => item.resourceId === '00000000-0000-4000-8000-000000000204'), true, 'unrepresented media stays in the resource catalog');
});

test('project gallery loads media and previews by resource ID without creating file copies', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'gallery-test');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, active.workspaces[0].id);
  canvas = await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision, { kind: 'image', title: 'Foto', position: { x: 120, y: 80 },
    bytes: Uint8Array.from([1, 2, 3, 4]), mediaType: 'image/png' });
  const image = canvas.entities.find((entity) => entity.title === 'Foto');
  assert.ok(image?.contentResourceId);
  canvas = await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision, { kind: 'image', title: 'Otra referencia', position: { x: 500, y: 80 }, resourceId: image.contentResourceId });
  canvas = await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision, { kind: 'video', title: 'Clip', position: { x: 800, y: 80 },
    bytes: Uint8Array.from([9, 8, 7]), mediaType: 'video/mp4' });
  canvas = await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision, { kind: 'youtube', title: 'Referencia', position: { x: 1100, y: 80 }, url: 'https://youtu.be/dQw4w9WgXcQ' });
  const catalog = await manager.loadMediaGallery(active.sessionId);
  assert.deepEqual(catalog.items.map((item) => item.kind), ['image', 'video', 'video']);
  const photo = catalog.items.find((item) => item.resourceId === image.contentResourceId);
  assert.equal(photo.representations.length, 2);
  const filesBeforePreview = await readdir(root, { recursive: true });
  assert.equal((await manager.loadMediaGalleryPreview(active.sessionId, image.contentResourceId)).state, 'binary');
  assert.deepEqual(await readdir(root, { recursive: true }), filesBeforePreview, 'preview only reads the catalogued resource and adds no copy');
  const video = catalog.items.find((item) => item.kind === 'video' && item.representations.some((rep) => rep.type === 'a3.content.video'));
  assert.equal((await manager.loadMediaGalleryPreview(active.sessionId, video.resourceId)).state, 'unavailable', 'listing does not load video bytes');
  assert.equal((await manager.loadMediaGalleryPreview(active.sessionId, video.resourceId, 'playback')).state, 'binary', 'video bytes load only after explicit playback');
  const youtube = catalog.items.find((item) => item.url?.includes('youtu.be'));
  assert.equal(youtube.availability, 'remote');
  assert.equal((await manager.loadMediaGalleryPreview(active.sessionId, youtube.resourceId)).state, 'remote', 'remote URLs are not fetched');
});

test('mounted media requires explicit mount.index and mount.read plus the local binding; the gallery never scans folders', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'gallery-mount-test');
  const external = join(tempRoot, 'external-media'); await mkdir(external); await writeFile(join(external, 'photo.png'), Buffer.from([1, 2, 3]));
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' }), true);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const mountId = id(970), resourceId = id(971);
  assert.equal(await manager.approveCanvasDropMount(active.sessionId, mountId, external), true);
  const canvas = await manager.loadCanvasWorkspace(active.sessionId, active.workspaces[0].id);
  await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision, { kind: 'image', title: 'Mount image', position: { x: 100, y: 100 },
    resourceId, mediaType: 'image/png', dropMode: 'reference', dropMountId: mountId, dropPath: 'photo.png' });
  assert.equal(await manager.setMountCapability(active.sessionId, mountId, 'index', true), true);
  let catalog = await manager.loadMediaGallery(active.sessionId);
  assert.equal(catalog.items.find((item) => item.resourceId === resourceId).availability, 'available');
  assert.equal(await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' }), true);
  catalog = await manager.loadMediaGallery(active.sessionId);
  assert.equal(catalog.items.find((item) => item.resourceId === resourceId).availability, 'permission-denied');
  assert.equal(await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'trabajar' }), true);
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' }), true);
  catalog = await manager.loadMediaGallery(active.sessionId);
  assert.equal(catalog.items.find((item) => item.resourceId === resourceId).availability, 'available');
  assert.deepEqual(await readFile(join(external, 'photo.png')), Buffer.from([1, 2, 3]));
});
