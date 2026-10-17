import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { manualChatURL, manualChatOrigin, manualChatResourceAllowed, validManualChatRequest } from '../src/shared/manual-chat.ts';
const urls = JSON.parse(await readFile(new URL('../../../fixtures/e5/manual-chat/urls.json', import.meta.url), 'utf8'));
const sessionId = '00000000-0000-4000-8000-000000000001', tabId = '00000000-0000-4000-8000-000000000002';
test('A3-027: navigation and external opening reject filesystem, app protocols, script URLs, credentials and local service literals', () => {
  for (const url of urls.allowed) assert.equal(manualChatURL(url), new URL(url).href);
  for (const url of urls.blocked) assert.equal(manualChatURL(url), null, url);
  assert.equal(manualChatOrigin('https://provider.example/chat?secret=not-logged'), 'https://provider.example');
  assert.equal(manualChatURL('wss://chatgpt.com/'), null); assert.equal(manualChatResourceAllowed('wss://chatgpt.com/', 'webSocket'), true);
  assert.equal(manualChatResourceAllowed('data:image/png;base64,AA==', 'image'), true);
  assert.equal(manualChatResourceAllowed('data:text/html,test', 'mainFrame'), false);
  assert.equal(manualChatResourceAllowed('blob:https://chatgpt.com/test', 'subFrame'), false);
  assert.equal(manualChatResourceAllowed('file:///C:/project/secret', 'xhr'), false);
});
test('manual browser IPC is a bounded control contract: no scripts, filesystem paths, project operations or forged sessions', () => {
  for (const action of ['show', 'state', 'hide', 'new-tab', 'logout']) assert.ok(validManualChatRequest({ action, sessionId }));
  assert.ok(validManualChatRequest({ action: 'state', sessionId: null }));
  assert.ok(validManualChatRequest({ action: 'copy-text', sessionId, text: '# Un prompt para copiar manualmente' }));
  assert.ok(validManualChatRequest({ action: 'navigate', sessionId, tabId, url: 'https://chatgpt.com/' }));
  assert.ok(validManualChatRequest({ action: 'layout', sessionId, bounds: { x: 200, y: 220, width: 500, height: 300 } }));
  for (const request of [
    { action: 'evaluate', sessionId, script: 'require("fs")' }, { action: 'state', sessionId, actor: 'user' }, { action: 'state', sessionId: 'other' },
    { action: 'new-tab', sessionId, preload: 'malicious.js' }, { action: 'navigate', sessionId, tabId, url: 'a'.repeat(8193) },
    { action: 'copy-text', sessionId, text: 'a'.repeat(1024 * 1024 + 1) }, { action: 'copy-text', sessionId, text: '', pasteAutomatically: true },
    { action: 'external', sessionId, tabId, url: 'file:///C:/secret' }, { action: 'close', sessionId, tabId: 'not-a-tab' },
    ...[NaN, Infinity, -1, 32769].map((x) => ({ action: 'layout', sessionId, bounds: { x, y: 0, width: 1, height: 1 } }))
  ]) assert.equal(validManualChatRequest(request), false, JSON.stringify(request));
});
