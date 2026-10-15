import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MIN_ZOOM, MAX_ZOOM, fitContent, fromVisualViewport, gridOffset, renderOrigin, screenToWorld, toVisualViewport, worldToScreen, zoomAt, wheelViewport } from '../src/shared/world-viewport.ts';
const near = (a, b, tolerance = 0.001) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

test('A3-006/007: world/screen round trip and floating origin retain subpixel precision at extensive coordinates', () => {
  for (const zoom of [MIN_ZOOM, 0.73, 1, MAX_ZOOM]) for (const distance of [0, 1e6, -1e9, 1e12]) {
    const v = { x: -distance * zoom, y: distance * zoom, zoom };
    const point = { x: distance + 123.25, y: -distance + 65.5 };
    const screen = worldToScreen(point, v);
    near(screen.x, 123.25 * zoom); near(screen.y, 65.5 * zoom);
    const restored = screenToWorld(screen, v); near(restored.x, point.x); near(restored.y, point.y);
    const local = toVisualViewport(v, renderOrigin(v));
    assert.ok(Math.abs(local.x) < 1 && Math.abs(local.y) < 1);
    const source = fromVisualViewport(local, renderOrigin(v)); near(source.x, v.x); near(source.y, v.y);
  }
  assert.deepEqual(gridOffset({ x: -21.5, y: 42.25 }), [18.5, 2.25]);
});
test('zoom is anchored to the cursor, clamps to 5–800% and repeated gestures do not accumulate visible drift', () => {
  let v = { x: -1234.125, y: 9234.75, zoom: 0.73 };
  const cursor = { x: 371.5, y: 219.25 }; const expected = screenToWorld(cursor, v);
  for (let index = 0; index < 1000; index++) { v = zoomAt(v, cursor, v.zoom * 1.2); v = zoomAt(v, cursor, v.zoom / 1.2); }
  const actual = screenToWorld(cursor, v); near(actual.x, expected.x, 1e-8); near(actual.y, expected.y, 1e-8);
  assert.equal(zoomAt(v, cursor, 1e-9).zoom, MIN_ZOOM); assert.equal(zoomAt(v, cursor, 1000).zoom, MAX_ZOOM);
});
test('wheel and trackpad share pixel/line/page normalization; Ctrl or pinch zooms at the pointer', () => {
  const v = { x: 0, y: 0, zoom: 1 }; const cursor = { x: 123, y: 234 }; const size = { width: 800, height: 600 };
  const input = { deltaX: 12.5, deltaY: -8.25, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.deepEqual(wheelViewport(v, input, cursor, size), { x: -12.5, y: 8.25, zoom: 1 });
  assert.equal(wheelViewport(v, { ...input, deltaMode: 1 }, cursor, size).x, -200);
  assert.equal(wheelViewport(v, { ...input, deltaMode: 2 }, cursor, size).x, -7500);
  const pinch = wheelViewport(v, { ...input, ctrlKey: true }, cursor, size);
  assert.ok(pinch.zoom > 1); near(screenToWorld(cursor, pinch).x, cursor.x); near(screenToWorld(cursor, pinch).y, cursor.y);
});
test('explicit fit contains isolated bounds and can exceed the interactive zoom range without rewriting geometry', () => {
  const bounds = { x: -1e9, y: 1e9, width: 4e6, height: 2e6 }; const copy = structuredClone(bounds);
  const v = fitContent(bounds, { width: 1000, height: 600 }); assert.ok(v.zoom < MIN_ZOOM);
  const top = worldToScreen(bounds, v); const bottom = worldToScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, v);
  assert.ok(top.x >= 47.999 && top.y >= 47.999); assert.ok(bottom.x <= 952.001 && bottom.y <= 552.001);
  assert.deepEqual(bounds, copy);
});
test('nonfinite or unrenderable camera values fail explicitly without clipping saved source data', () => {
  for (const x of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) assert.throws(() => renderOrigin({ x, y: 0, zoom: 1 }));
  assert.throws(() => zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, Infinity));
});
test('React Flow and its resolved production dependency subtree declare permissive licenses', async () => {
  for (const [name, license] of [['@xyflow/react', 'MIT'], ['@xyflow/system', 'MIT'], ['zustand', 'MIT'], ['classcat', 'MIT'], ['d3-zoom', 'ISC'], ['d3-drag', 'ISC']]) {
    const file = new URL(`../../../node_modules/${name}/package.json`, import.meta.url);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).license, license, name);
  }
});
