import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCodexAgentView } from '../src/shared/codex-agent-view.ts';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e5/agent-controls/states.json', import.meta.url), 'utf8'));

test('exhausted account limit is explicit and never exposes paid fallback', () => {
  const state = fixture.limitExhausted;
  const view = createCodexAgentView(state);
  assert.equal(view.errorNotice, state.expectedError);
  assert.equal(view.canStart, false);
  assert.deepEqual(view.modelLabels, []);
});

test('inaccessible provider model stays out of available model list', () => {
  const state = fixture.modelInaccessible;
  const view = createCodexAgentView(state);
  assert.equal(view.modelNotice, state.expectedModelNotice);
  assert.deepEqual(view.modelLabels, []);
  assert.equal(view.errorNotice, 'El proveedor denegó acceso al modelo o la ruta solicitada. No se ofrece un modelo alternativo sin verificar.');
});

test('lost connection marks streaming uncertain and does not enable automatic replay', () => {
  const state = fixture.connectionLost;
  const view = createCodexAgentView(state);
  assert.equal(view.providerLabel, 'Conexión perdida');
  assert.equal(view.streamingLabel, state.expectedStreaming);
  assert.equal(view.errorNotice, state.expectedError);
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, false);
  assert.equal(view.canResume, false);
});

test('only an explicitly verified catalog can display available models', () => {
  const unverified = createCodexAgentView({ providerConnection: 'connected', turnStatus: null, turnControlsAvailable: false });
  assert.deepEqual(unverified.modelLabels, []);
  const verified = createCodexAgentView({ providerConnection: 'connected', turnStatus: null, turnControlsAvailable: false,
    modelCatalog: { verified: true, models: [
      { id: 'model-a', label: 'Model A', available: true },
      { id: 'model-b', label: 'Model B', available: false },
      { id: 'model-a-duplicate', label: 'Model A', available: true }
    ] }
  });
  assert.deepEqual(verified.modelLabels, ['Model A']);
  assert.equal(verified.canStart, false);
});
