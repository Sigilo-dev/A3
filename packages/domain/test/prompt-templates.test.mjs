import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUILTIN_PROMPT_TEMPLATES, buildPromptHelperRegistry, compilePromptTemplate, parsePromptTemplate, serializePromptTemplate } from '../dist/src/index.js';
import { fixture, variableSet } from './fixture.mjs';
const cases = JSON.parse(await readFile(new URL('../../../fixtures/e4/prompts/template-cases.json', import.meta.url), 'utf8'));
const variables = JSON.parse(await readFile(new URL('../../../fixtures/e4/variables/scenario.json', import.meta.url), 'utf8'));
function snapshot() {
  const data = fixture(), projectId = data.records.find((record) => record.kind === 'project').value.projectId;
  const set = variableSet({ kind: 'project', ownerId: projectId }, structuredClone(variables.project)); set.value.schemaVersion = '1.1.0'; data.records.push(set);
  return data;
}

test('A3-019: five built-in template examples declare metadata, context rules, output and Markdown', () => {
  assert.deepEqual(BUILTIN_PROMPT_TEMPLATES.map((template) => template.id), ['a3.story', 'a3.review', 'a3.checklist', 'a3.iot-proposal', 'a3.project-summary']);
  for (const template of BUILTIN_PROMPT_TEMPLATES) {
    const serialized = serializePromptTemplate(template), parsed = parsePromptTemplate(serialized);
    assert.equal(parsed.ok, true, template.id);
    assert.equal(parsed.template.name, template.name);
    assert.ok(parsed.template.objective && parsed.template.inputs && parsed.template.contextSelection && parsed.template.outputFormat && parsed.template.descriptionMarkdown);
    assert.equal(serializePromptTemplate(parsed.template), serialized);
  }
});

test('A3-019: all built-in examples compile with declared input shapes', () => {
  const supplied = {
    'a3.story': { actor: 'persona', need: 'hacerlo', benefit: 'avanzar', criteria: [], 'open-question': '' },
    'a3.review': { text: 'Texto', focus: 'claridad' },
    'a3.checklist': { scope: 'alcance', items: [] },
    'a3.iot-proposal': { goal: 'medir', components: [], board: 'ESP32 exacta' },
    'a3.project-summary': { focus: 'estado', facts: [] }
  };
  for (const template of BUILTIN_PROMPT_TEMPLATES) {
    const compiled = compilePromptTemplate(snapshot(), serializePromptTemplate(template), supplied[template.id]);
    assert.deepEqual(compiled.templateDiagnostics, [], template.id);
    assert.ok(compiled.text.length > 0, template.id);
  }
});

test('A3-019: metadata and limited Handlebars blocks round-trip with registered helpers', () => {
  const parsed = parsePromptTemplate(cases.validBlocks); assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.template.extensions['fixture.future'], { preserve: true });
  assert.equal(parsePromptTemplate(serializePromptTemplate(parsed.template)).ok, true);
  const result = compilePromptTemplate(snapshot(), cases.validBlocks, { show: true, name: 'a3 seguro', items: ['Uno', 'Dos'] });
  assert.equal(result.canSendAutomatically, true, JSON.stringify(result.templateDiagnostics));
  assert.equal(result.text.trim(), 'A3 SEGURO\n\n\n- 0: Uno\n\n- 1: Dos');
  assert.deepEqual(result.helpersUsed, ['upper']); assert.deepEqual(result.inputsUsed, ['items', 'name', 'show']);
});

test('A3-019: unregistered helpers and JavaScript-looking expressions fail closed without evaluation', () => {
  const before = snapshot();
  const helper = compilePromptTemplate(before, cases.unknownHelper, { path: 'C:\\private\\file' });
  assert.equal(helper.canSendAutomatically, false); assert.equal(helper.templateDiagnostics[0].detail, 'template-helper-unregistered');
  assert.match(helper.markedExport, /readFile/); assert.equal(helper.inputsUsed.length, 0);
  const expression = compilePromptTemplate(before, cases.expressionAttempt, {});
  assert.equal(expression.canSendAutomatically, false); assert.ok(expression.templateDiagnostics.length);
  assert.ok(expression.templateDiagnostics.some((item) => ['template-helper-unregistered', 'template-expression-unsupported'].includes(item.detail)));
});

test('A3-019: parse errors have locations and invalid metadata never becomes an empty template', () => {
  for (const fixture of [cases.invalidJson, cases.unclosedBlock]) {
    const parsed = parsePromptTemplate(fixture); assert.equal(parsed.ok, fixture === cases.unclosedBlock);
  }
  const unclosed = compilePromptTemplate(snapshot(), cases.unclosedBlock, { show: true });
  assert.equal(unclosed.canSendAutomatically, false);
  assert.equal(unclosed.templateDiagnostics[0].detail, 'template-block-unclosed');
  assert.ok(unclosed.templateDiagnostics[0].line && unclosed.templateDiagnostics[0].column);
  const original = 'not a template'; const invalid = compilePromptTemplate(snapshot(), original, {});
  assert.equal(invalid.text, original); assert.match(invalid.markedExport, /plantilla no compilada/);
});

test('A3-018/A3-019: variables resolve in the derived output and input text is not re-parsed as a token', () => {
  const data = snapshot(), before = structuredClone(data);
  const source = serializePromptTemplate({ ...BUILTIN_PROMPT_TEMPLATES[4], requiredVariables: [], markdown: 'Input: {{input.focus}}\nProject: {{demo.name}}' });
  const result = compilePromptTemplate(data, source, { focus: 'literal {{demo.name}}', facts: [] }, {});
  assert.equal(result.text, 'Input: literal {{demo.name}}\nProject: project label');
  assert.deepEqual(result.variables.map((item) => item.name), ['demo.name']); assert.deepEqual(data, before);
});

test('A3-019: only declarative registered helper operations are accepted', () => {
  assert.throws(() => buildPromptHelperRegistry([{ name: 'custom', operation: 'eval' }]), /registro de helpers/i);
  assert.throws(() => buildPromptHelperRegistry([{ name: 'constructor', operation: 'json' }]), /registro de helpers/i);
  const helper = buildPromptHelperRegistry([{ name: 'custom-json', operation: 'json' }]); assert.equal(helper.get('custom-json'), 'json');
});

test('A3-018/A3-019: required variables and invalid declared input types block automatic use', () => {
  const project = BUILTIN_PROMPT_TEMPLATES.find((template) => template.id === 'a3.project-summary');
  const serialized = serializePromptTemplate({ ...project, markdown: 'Nombre: {{proyecto.ausente}}' });
  const required = compilePromptTemplate(snapshot(), serialized, { focus: 'estado', facts: [] });
  assert.equal(required.canSendAutomatically, false); assert.equal(required.unresolved.find((item) => item.name === 'proyecto.nombre')?.required, true);
  const sample = serializePromptTemplate(BUILTIN_PROMPT_TEMPLATES[0]);
  const invalidInput = compilePromptTemplate(snapshot(), sample, { actor: 22, need: 'medir', benefit: 'trazar', criteria: [] });
  assert.equal(invalidInput.canSendAutomatically, false);
  assert.ok(invalidInput.templateDiagnostics.some((item) => item.detail === 'template-input-type-invalid'));
});
