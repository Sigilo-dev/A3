import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adaptDiagramStyle, renderMermaidSource, resolveDiagramStyle, serializeDiagramTheme, validateDiagramStyleProfile } from '../dist/src/index.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/diagram-style-mermaid.json', import.meta.url), 'utf8'));

test('E3-F1: a Mermaid profile adapts only the pinned engine subset and reports the rest', () => {
  assert.deepEqual(validateDiagramStyleProfile(fixture), []);
  const result = adaptDiagramStyle(fixture);
  assert.deepEqual(result.unsupported.sort(), ['background.resourceId', 'borders.radius', 'borders.width', 'fonts.size', 'orientation', 'scale'].sort());
  assert.equal(result.mermaidConfig.theme, 'base');
  assert.equal(result.mermaidConfig.fontFamily, 'Segoe UI');
  assert.deepEqual(result.mermaidConfig.themeVariables, {
    background: '#1c2530', primaryColor: '#314559', secondaryColor: '#283847', primaryTextColor: '#f1f5f9', lineColor: '#a5bacd', primaryBorderColor: '#647b91'
  });
  assert.deepEqual(result.mermaidConfig.flowchart, { nodeSpacing: 48, rankSpacing: 64 });
});

test('style precedence merges each field from type through project, entity and view', () => {
  const result = resolveDiagramStyle({
    typeBase: { fonts: { family: 'type', size: 10 }, colors: { primary: '#111111', text: '#111111' }, borders: { width: 1 } },
    projectTheme: { fonts: { size: 14 }, colors: { primary: '#222222', line: '#333333' } },
    entity: { colors: { primary: '#444444' }, borders: { width: 3 } },
    view: { colors: { text: '#555555' } }
  });
  assert.deepEqual(result, { fonts: { family: 'type', size: 14 }, colors: { primary: '#444444', text: '#555555', line: '#333333' }, borders: { width: 3 } });
});

test('Structurizr theme JSON stays declarative, stable, and states engine limitations', () => {
  const profile = { ...fixture, engine: 'structurizr' };
  const json = serializeDiagramTheme(profile);
  const theme = JSON.parse(json);
  assert.equal(json.endsWith('\n'), true);
  assert.deepEqual(theme.precedence, ['type', 'project-theme', 'entity', 'view']);
  assert.ok(theme.unsupported.includes('orientation'));
  assert.equal(theme.structurizr.elements[0].tag, 'Element');
  assert.equal(theme.structurizr.elements[0].background, '#314559');
  assert.equal(theme.structurizr.relationships[0].color, '#a5bacd');
  assert.ok(theme.unsupported.includes('fonts.family'));
  assert.equal(validateDiagramStyleProfile({ ...fixture, colors: { primary: 'red' } }).length > 0, true);
  assert.equal(validateDiagramStyleProfile({ ...fixture, background: { resourceId: '../outside.png' } }).length > 0, true);
  assert.equal(validateDiagramStyleProfile({ ...fixture, fontFace: 'body { background:url(...) }' }).length > 0, true);
});

test('PlantUML and A3 adapters report unsupported layout fields and export concrete safe declarations', () => {
  const plantuml = { ...fixture, engine: 'plantuml' };
  const adapted = adaptDiagramStyle(plantuml);
  assert.ok(adapted.plantUmlSkinparam.includes('skinparam defaultFontName "Segoe UI"'));
  assert.ok(adapted.plantUmlSkinparam.includes('skinparam classBackgroundColor #314559'));
  assert.ok(adapted.unsupported.includes('orientation'));
  assert.ok(adapted.unsupported.includes('spacing.nodes'));
  assert.ok(adapted.unsupported.includes('background.resourceId'));
  assert.equal(JSON.parse(serializeDiagramTheme(plantuml)).plantuml.skinparam, adapted.plantUmlSkinparam);
  const native = adaptDiagramStyle({ ...fixture, engine: 'a3-native' });
  assert.ok(native.unsupported.includes('orientation'));
  assert.ok(native.unsupported.includes('scale'));
});

test('Mermaid profile configuration is serialized with rendering to avoid global theme races', async () => {
  let activeTheme = '';
  const engine = {
    configure(config) { activeTheme = config.theme; },
    async parse() { await new Promise((resolve) => setTimeout(resolve, 3)); return { diagramType: 'flowchart' }; },
    render() { return { svg: `<svg data-theme="${activeTheme}"/>` }; }
  };
  const [dark, forest] = await Promise.all([
    renderMermaidSource('flowchart TD\nA-->B', 'dark', async () => engine, { theme: 'dark' }),
    renderMermaidSource('flowchart TD\nA-->B', 'forest', async () => engine, { theme: 'forest' })
  ]);
  assert.equal(dark.state, 'rendered'); assert.match(dark.svg, /data-theme="dark"/);
  assert.equal(forest.state, 'rendered'); assert.match(forest.svg, /data-theme="forest"/);
});
