import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShortcuts, validateShortcuts, matchesShortcut } from '../dist/src/shortcuts.js';
test('A3-044/052 subset: context collisions, native editing reservation, reset and exact modifier matching', () => {
  const defaults = defaultShortcuts(); assert.equal(validateShortcuts(defaults).ok, true);
  assert.match(validateShortcuts({ ...defaults, redo: 'ctrl+z' }).message, /Colisión/);
  assert.match(validateShortcuts({ ...defaults, back: 'Ctrl+D' }).message, /Colisión/);
  assert.match(validateShortcuts({ ...defaults, close: 'Delete' }).message, /requiere/);
  assert.match(validateShortcuts({ ...defaults, duplicate: 'Ctrl+C' }).message, /reservado/);
  assert.equal(validateShortcuts({ ...defaults, save: 'ctrl+alt+s', undo: '' }).bindings.save, 'Ctrl+Alt+S');
  assert.equal(validateShortcuts({ ...defaults, unknown: 'Ctrl+J' }).ok, false);
  assert.equal(matchesShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, defaults.save), true);
  assert.equal(matchesShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, defaults.save), false);
  assert.equal(matchesShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: true }, defaults.save), false);
  assert.deepEqual(defaultShortcuts(), defaults);
});
