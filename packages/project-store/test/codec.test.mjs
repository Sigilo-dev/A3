import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeDocument, encodeDocument, serializeRecord, sha256 } from '../dist/index.js';
import { entity, entityPath, fixtureRoot, id, location } from './fixture.mjs';

const bytes = (value) => Buffer.from(JSON.stringify(value), 'utf8');
const load = async (overrides = {}) => decodeDocument(location, bytes({ ...await entity(), ...overrides }));
const reject = (result, detail) => {
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.detail === detail), JSON.stringify(result.diagnostics));
};
test('fixture bytes round-trip exactly and copies cannot mutate the source', async () => {
  const source = await readFile(join(fixtureRoot, entityPath));
  const doc = decodeDocument(location, source);
  source.fill(0);
  const retained = doc.originalBytes();
  assert.equal(doc.status, 'valid');
  assert.equal(doc.sha256, sha256(retained));
  retained.fill(0);
  assert.notDeepEqual(doc.originalBytes(), retained);
  const result = encodeDocument(doc);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.bytes, doc.originalBytes());
  assert.ok(Object.isFrozen(doc.value));
});
test('no-op preserves BOM, CRLF, whitespace, escapes and key order', async () => {
  const value = await entity();
  const source = Buffer.from('\uFEFF' + JSON.stringify(value, null, '\t').replaceAll('\n', '\r\n') + '\r\n\r\n');
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'valid');
  const result = encodeDocument(doc, [{ op: 'set', pointer: '/title', value: value.title }]);
  assert.equal(result.changed, false);
  assert.deepEqual(Buffer.from(result.bytes), source);
});
test('explicit edit preserves unknown top-level, nested, namespaced and prototype-looking data', async () => {
  const value = await entity();
  value.future = { '2': 'two', '10': 'ten', unknown: [{ nested: true }] };
  value.extensions['community.future'] = { opaque: ['a', 'b'], revision: 99 };
  Object.defineProperty(value, '__proto__', { value: { untouched: 'yes' }, enumerable: true });
  value.ports[0] = { id: 'reference', extra: 'preserved' };
  const doc = decodeDocument(location, bytes(value));
  const result = encodeDocument(doc, [
    { op: 'set', pointer: '/title', value: 'Visión nueva' },
    { op: 'set', pointer: '/revision', value: 2 }
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const decoded = decodeDocument(location, result.bytes);
  assert.equal(decoded.value.title, 'Visión nueva');
  assert.deepEqual(decoded.value.future, value.future);
  assert.deepEqual(decoded.value.extensions, value.extensions);
  assert.deepEqual(decoded.value.ports, value.ports);
  assert.deepEqual(decoded.value.__proto__, { untouched: 'yes' });
  assert.equal({}.untouched, undefined);
  assert.equal(decoded.value.id, value.id);
  assert.equal(doc.value.revision, 1);
  const text = Buffer.from(result.bytes).toString('utf8');
  assert.ok(text.endsWith('\n') && !text.includes('\r') && !text.startsWith('\uFEFF'));
  assert.ok(text.indexOf('"10":') < text.indexOf('"2":'));
  assert.deepEqual(Buffer.from(encodeDocument(decoded).bytes), Buffer.from(result.bytes));
});
test('new-record canonical bytes are independent of insertion order, with stable arrays', async () => {
  const value = { ...await entity(), future: { z: 1, a: 2, list: [3, 2, 1] } };
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  reversed.future = { list: [3, 2, 1], a: 2, z: 1 };
  const a = serializeRecord(location, { kind: 'entity', value });
  const b = serializeRecord(location, { kind: 'entity', value: reversed });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.bytes, b.bytes);
  assert.deepEqual(JSON.parse(Buffer.from(a.bytes).toString()).future.list, [3, 2, 1]);
});
test('schema validation is localized and does not coerce an invalid revision', async () => {
  const doc = decodeDocument(location, Buffer.from(JSON.stringify({ ...await entity(), revision: '1' }, null, 2)));
  assert.equal(doc.status, 'invalid');
  assert.equal(doc.record, undefined);
  const error = doc.diagnostics.find((d) => d.pointer === '/revision');
  assert.equal(error.stage, 'schema');
  assert.ok(error.line > 1 && error.column > 0 && error.byteOffset > 0);
  reject(encodeDocument(doc), 'document-not-writable');
});
for (const [name, text] of [
  ['truncated JSON', '{\n "title": "á",\n "bad":'],
  ['trailing comma', '{"x":1,}'], ['comment', '{/*x*/"x":1}'],
  ['invalid escape', '{"x":"\\q"}'], ['unclosed string', '{"x":"a'],
  ['leading zero', '{"x":01}'], ['multiple values', '{} {}'],
  ['non JSON whitespace', '{}\u00a0'], ['control character', '{"x":"\n"}'],
  ['incomplete exponent', '{"x":1e}']
]) test(`${name}: localized syntax error, original bytes, no empty record`, () => {
  const source = Buffer.from(text);
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'invalid');
  assert.equal(doc.value, undefined);
  assert.equal(doc.record, undefined);
  assert.equal(doc.diagnostics[0].stage, 'syntax');
  assert.ok(doc.diagnostics[0].line >= 1 && doc.diagnostics[0].column >= 1);
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
  reject(encodeDocument(doc), 'document-not-writable');
});
test('invalid UTF-8 is retained without replacement characters', () => {
  const source = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]);
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'invalid');
  assert.equal(doc.diagnostics[0].detail, 'invalid-utf8');
  assert.equal(doc.diagnostics[0].byteOffset, 6);
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
});
for (const version of ['2.0.0', '1.1.0', '1.0.1', '0.9.0', '1.0.0-next.1']) test(`${version}: inspected without schema coercion or downgrade`, async () => {
  const doc = await load({ schemaVersion: version, future: { important: true } });
  assert.equal(doc.status, 'read-only');
  assert.equal(doc.value.schemaVersion, version);
  assert.equal(doc.record, undefined);
  assert.ok(doc.diagnostics.every((d) => d.stage === 'compatibility'));
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/schemaVersion', value: '1.0.0' }]), 'document-not-writable');
  reject(serializeRecord(location, { kind: 'entity', value: doc.value }), version === '2.0.0' ? 'unsupported-major' : 'unsupported-version');
});
for (const token of ['9007199254740993', '0.123456789012345678901', '1e999', '1e-999', '-0']) test(`${token}: no numeric data loss`, async () => {
  const source = Buffer.from(JSON.stringify(await entity()).slice(0, -1) + ',"future":' + token + '}');
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'read-only');
  assert.equal(doc.value, undefined);
  assert.equal(doc.record, undefined);
  assert.equal(doc.diagnostics[0].detail, 'number-not-lossless');
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
});
test('safe decimal spellings are supported and retain original bytes in no-op', async () => {
  const source = Buffer.from(JSON.stringify(await entity()).slice(0, -1) + ',"future":[1.00,1e+2,0.125,0e999]}');
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'valid');
  assert.deepEqual(doc.value.future, [1, 100, 0.125, 0]);
  assert.deepEqual(Buffer.from(encodeDocument(doc).bytes), source);
});
test('duplicate keys including escaped aliases are quarantined rather than last-wins', async () => {
  const source = Buffer.from(JSON.stringify(await entity()).slice(0, -1) + ',"future":1,"futu\\u0072e":2}');
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'read-only');
  assert.equal(doc.value, undefined);
  assert.equal(doc.diagnostics[0].detail, 'duplicate-json-key');
  assert.ok(doc.diagnostics[0].byteOffset > 0);
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
});
test('identity, version, location and revision safeguards reject unsafe edits', async () => {
  const doc = await load({ revision: 3 });
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/id', value: id(999) }]), 'file-identity-mismatch');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/revision', value: 2 }]), 'identity-or-revision-changed');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/schemaVersion', value: '2.0.0' }]), 'unsupported-major');
  reject(serializeRecord({ ...location, workspaceId: id(9) }, doc.record), 'record-location-mismatch');
  reject(encodeDocument({ ...doc }), 'document-not-writable');
});
test('JSON pointers edit explicitly and cannot traverse inherited prototypes', async () => {
  const doc = await load({ future: { 'a/b~c': [1, 2], keep: true } });
  const result = encodeDocument(doc, [{ op: 'set', pointer: '/future/a~1b~0c/0', value: 3 }, { op: 'remove', pointer: '/future/a~1b~0c/1' }, { op: 'set', pointer: '/revision', value: 2 }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.value.future, { 'a/b~c': [3], keep: true });
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/__proto__/polluted', value: true }]), 'invalid-edit');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/future/~3', value: true }]), 'invalid-edit');
  assert.equal({}.polluted, undefined);
});
test('non JSON edits and records fail without executing getters', async () => {
  const doc = await load();
  let calls = 0;
  const getter = Object.defineProperty({}, 'boom', { enumerable: true, get() { calls++; return true; } });
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/future', value: getter }]), 'non-json-edit');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/future', value: Infinity }]), 'non-json-edit');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/future', value: -0 }]), 'number-not-lossless');
  reject(serializeRecord(location, { kind: 'entity', value: { ...await entity(), future: -0 } }), 'number-not-lossless');
  const unsafe = Object.defineProperty({ ...await entity() }, 'schemaVersion', { enumerable: true, get() { calls++; return '1.0.0'; } });
  reject(serializeRecord(location, { kind: 'entity', value: unsafe }), 'invalid-record');
  const wrapper = Object.defineProperty({ value: await entity() }, 'kind', { enumerable: true, get() { calls++; return 'entity'; } });
  reject(serializeRecord(location, wrapper), 'invalid-record');
  assert.equal(calls, 0);
});
test('edits require exactly the next revision; exhaustion still permits no-op', async () => {
  const doc = await load({ revision: 3 });
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/title', value: 'new' }]), 'revision-not-next');
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/revision', value: 5 }]), 'revision-not-next');
  const exhausted = await load({ revision: Number.MAX_SAFE_INTEGER });
  assert.equal(encodeDocument(exhausted).changed, false);
  reject(encodeDocument(exhausted, [{ op: 'set', pointer: '/revision', value: Number.MAX_SAFE_INTEGER + 1 }]), 'schema-invalid');
});
test('string and scalar grammar agrees with JSON.parse without altering source', async () => {
  const value = await entity();
  for (const future of [null, false, true, '" \\ \b \f \n \r \t', '\uD800', '\uDC00', 'á😀\u2028', [], {}, [null, 'x', { '': 'empty key', 'a/b': true }]]) {
    const source = Buffer.from(JSON.stringify({ ...value, future }, null, 2));
    const doc = decodeDocument(location, source);
    assert.equal(doc.status, 'valid', JSON.stringify(doc.diagnostics));
    assert.deepEqual(doc.value, JSON.parse(source));
    assert.deepEqual(Buffer.from(encodeDocument(doc).bytes), source);
  }
});
test('depth limit is inspection-only, not a claim that valid JSON is corrupt', async () => {
  const source = Buffer.from(JSON.stringify(await entity()).slice(0, -1) + ',"future":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}');
  assert.doesNotThrow(() => JSON.parse(source));
  const doc = decodeDocument(location, source);
  assert.equal(doc.status, 'read-only');
  assert.equal(doc.diagnostics[0].stage, 'compatibility');
  assert.equal(doc.diagnostics[0].detail, 'json-depth-limit');
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
});
test('encoder cannot emit a tree its own reader cannot load, or recurse without a bound', async () => {
  let future = 0;
  for (let i = 0; i < 2000; i++) future = [future];
  reject(serializeRecord(location, { kind: 'entity', value: { ...await entity(), future } }), 'json-depth-limit');
  const doc = await load();
  reject(encodeDocument(doc, [{ op: 'set', pointer: '/future', value: future }]), 'json-depth-limit');
  let boundary = 0;
  for (let i = 0; i < 127; i++) boundary = [boundary];
  const valid = serializeRecord(location, { kind: 'entity', value: { ...await entity(), future: boundary } });
  assert.equal(valid.ok, true);
  assert.equal(decodeDocument(location, valid.bytes).status, 'valid');
  reject(serializeRecord(location, { kind: 'entity', value: { ...await entity(), future: [boundary] } }), 'json-depth-limit');
});
test('E4 VariableSet 1.1 is supported only for its document family; later versions retain exact source in read-only mode', () => {
  const ownerId = id(400), location = { kind: 'variable-set', path: '.a3/variables/project.json', expectedId: ownerId, variableScope: 'project' };
  const value = { schemaVersion: '1.1.0', revision: 1, extensions: { 'future.keep': true }, scope: { kind: 'project', ownerId }, variables: [{ name: 'demo.choice', valueType: 'enum', enumValues: ['one'], source: { kind: 'literal', value: 'one' } }] };
  const input = Buffer.from('\ufeff' + JSON.stringify(value, null, 2).replaceAll('\n', '\r\n'));
  const decoded = decodeDocument(location, input); assert.equal(decoded.status, 'valid'); assert.deepEqual(Buffer.from(encodeDocument(decoded, []).bytes), input);
  for (const schemaVersion of ['1.2.0', '2.0.0']) { const original = bytes({ ...value, schemaVersion }), unknown = decodeDocument(location, original); assert.equal(unknown.status, 'read-only'); assert.deepEqual(Buffer.from(unknown.originalBytes()), original); }
});
