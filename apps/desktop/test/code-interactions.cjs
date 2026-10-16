const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { dialog } = require('electron');

module.exports = async ({ win, js, click, input, waitFor, root }) => {
  const active = (await js("window.a3.projects({ action: 'list' })")).value.active;
  const original = await readFile(join(root, 'editor.ts'));
  await click('[data-section="files"]'); await waitFor("Boolean(document.querySelector('[data-file-entry]'))");
  const selectFile = async (name) => {
    await waitFor("document.querySelector('.files-panel')?.getAttribute('aria-busy') === 'false'");
    await js(`(() => { const row = [...document.querySelectorAll('[data-file-entry]')].find((e) => e.querySelector('.file-name').textContent === ${JSON.stringify(name)}); if (!row) throw new Error('Missing file'); row.click(); })()`);
    await waitFor("Boolean(document.querySelector('[data-file-edit]')) && !document.querySelector('[data-file-edit]').disabled");
    await click('[data-file-edit]');
  };
  const replaceWord = async (old, next) => {
    const changed = await js(`(() => { const editor = document.querySelector('[data-code-editor] .cm-content'); editor.focus(); const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) { const at = node.textContent.indexOf(${JSON.stringify(old)}); if (at >= 0) {
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + ${old.length}); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return document.execCommand('insertText', false, ${JSON.stringify(next)}); } } return false; })()`);
    assert.equal(changed, true, `edit ${old}`);
    await waitFor("!document.querySelector('[data-code-save]').disabled");
  };
  await selectFile('editor.ts'); await waitFor("Boolean(document.querySelector('[data-code-editor] .cm-editor'))");
  assert.equal(await js("document.querySelector('[data-code-language-select]').value"), 'typescript');
  assert.equal(await js("document.querySelector('[data-code-save]').disabled"), true);
  assert.ok(await js("document.querySelectorAll('[data-code-editor] .cm-lineNumbers .cm-gutterElement').length > 1"));
  await waitFor("Boolean(document.querySelector('[data-code-editor] .cm-foldGutter [title]'))");
  assert.deepEqual(await readFile(join(root, 'editor.ts')), original, 'open does not normalize BOM/CRLF');
  await replaceWord('hola', 'niño 😀');
  await click('[data-code-close]'); await waitFor("Boolean(document.querySelector('#code-close-title'))");
  await js("[...document.querySelectorAll('.code-dialog .markdown-confirm button')].find((e) => e.textContent === 'Seguir editando').click(); undefined");
  // Cancelling native window exit must keep the project writer alive and the draft editable.
  const previousDialog = dialog.showMessageBox; dialog.showMessageBox = async () => ({ response: 0 });
  win.close(); await new Promise((resolve) => setTimeout(resolve, 250)); dialog.showMessageBox = previousDialog;
  assert.equal(win.isDestroyed(), false);
  assert.equal((await js("window.a3.projects({ action: 'list' })")).value.active.sessionId, active.sessionId);
  await js(`(() => { const editor = document.querySelector('[data-code-editor] .cm-content'); editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
  await waitFor("document.querySelector('[data-code-status]')?.textContent === 'Guardado'");
  const bytes = await readFile(join(root, 'editor.ts'));
  assert.equal(bytes.toString('utf8'), original.toString('utf8').replace('hola', 'niño 😀'));
  assert.equal(bytes.toString('utf8').charCodeAt(0), 0xfeff); assert.doesNotMatch(bytes.toString('utf8'), /(?<!\r)\n/);
  await click('[data-code-find]'); await waitFor("Boolean(document.querySelector('.code-dialog .cm-search input[name=search]'))");
  await input('.code-dialog .cm-search input[name=search]', 'niño');
  await input('.code-dialog .cm-search input[name=replace]', 'mundo');
  await js("document.querySelector('.code-dialog .cm-search input[name=replace]').dispatchEvent(new Event('change', { bubbles: true })); undefined");
  await js("[...document.querySelectorAll('.code-dialog .cm-search button')].find((e) => e.textContent === 'replace all').click(); undefined");
  await waitFor("!document.querySelector('[data-code-save]').disabled"); await click('[data-code-save]');
  await waitFor("document.querySelector('[data-code-status]')?.textContent === 'Guardado'");
  assert.match((await readFile(join(root, 'editor.ts'))).toString('utf8'), /mundo 😀/);
  for (const name of ['markdown', 'json', 'javascript', 'typescript', 'python', 'rust', 'cpp', 'html', 'css', 'yaml', 'toml', 'sql', 'text']) {
    await js(`(() => { const select = document.querySelector('[data-code-language-select]'); select.value = '${name}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('[data-code-editor]')?.dataset.codeLanguage === '${name}'`);
  }
  assert.equal(await js("document.querySelector('[data-code-save]').disabled"), true, 'language selection does not edit source');
  await click('[data-code-close]'); await selectFile('editor.ts'); await waitFor("document.querySelector('[data-code-editor] .cm-content')?.textContent.includes('mundo 😀')");
  await replaceWord('mundo', 'local');
  const tracked = await js(`(async () => { const listing = await window.a3.files({ action: 'list', sessionId: '${active.sessionId}', directoryId: 'project-root' }); return listing.value.entries.find((e) => e.name === 'editor.ts'); })()`);
  const base = (await js(`window.a3.code({ action: 'open', sessionId: '${active.sessionId}', target: { resourceId: '${tracked.resourceId}' } })`)).value;
  const external = await js(`window.a3.code({ action: 'save', sessionId: '${active.sessionId}', documentId: '${base.documentId}', expectedRevision: ${base.revision}, expectedHash: '${base.hash}', content: ${JSON.stringify(base.content.replace('mundo', 'externo'))} })`);
  assert.equal(external.ok, true, JSON.stringify(external));
  await click('[data-code-save]'); await waitFor("Boolean(document.querySelector('[data-code-conflict]'))");
  assert.match(await js("document.querySelector('[data-code-error]').textContent"), /REVISION_CONFLICT/);
  assert.match(await js("document.querySelector('.code-dialog .markdown-conflict-versions section:first-child pre').textContent"), /local/);
  assert.match(await js("document.querySelector('.code-dialog .markdown-conflict-versions section:last-child pre').textContent"), /externo/);
  await click('[data-code-keep-draft]'); await waitFor("!document.querySelector('[data-code-conflict]') && document.querySelector('[data-code-status]')?.textContent === 'Guardado'");
  assert.match((await readFile(join(root, 'editor.ts'))).toString(), /local/);
  await click('[data-code-close]'); await selectFile('binary.fixture');
  await waitFor("Boolean(document.querySelector('[data-code-state=binary]'))");
  assert.equal(await js("document.querySelector('[data-code-editor]')"), null);
  await click('[data-code-close]'); await selectFile('mixed.fixture'); await waitFor("Boolean(document.querySelector('[data-code-readonly]'))");
  assert.equal(await js("document.querySelector('[data-code-editor] .cm-content').getAttribute('contenteditable')"), 'false');
  assert.equal(await js("document.querySelector('[data-code-save]').disabled"), true); await click('[data-code-close]');
  assert.equal((await js(`window.a3.code({ action: 'open', sessionId: '${active.sessionId}', target: { path: '../secret' } })`)).error.code, 'INVALID_REQUEST');
  assert.equal((await js(`window.a3.code({ action: 'save', sessionId: '${active.sessionId}', documentId: '${base.documentId}', expectedRevision: ${base.revision}, expectedHash: '${base.hash}', content: 'x', execute: true })`)).error.code, 'INVALID_REQUEST');

  const entity = await js(`(async () => { const workspaceId = '${active.workspaces[0].id}'; const canvas = (await window.a3.canvas({ action: 'load', sessionId: '${active.sessionId}', workspaceId })).value;
    const added = await window.a3.canvas({ action: 'create-content-node', sessionId: '${active.sessionId}', workspaceId, expectedWorkspaceRevision: canvas.revision,
      node: { kind: 'code', title: 'Editor E2-E1', value: 'print("hello")\\n', language: 'python', position: { x: 0, y: 0 } } });
    if (!added.ok) throw new Error(added.error.message); return added.value.entities.find((e) => e.title === 'Editor E2-E1'); })()`);
  await click('[data-section="canvas"]'); await waitFor(`Boolean(document.querySelector('[data-open-code="${entity.id}"]'))`);
  await click(`[data-open-code="${entity.id}"]`); await waitFor("Boolean(document.querySelector('[data-code-editor] .cm-editor'))");
  assert.equal(await js("document.querySelector('[data-code-language-select]').value"), 'python');
  await replaceWord('hello', 'hola'); await click('[data-code-save]'); await waitFor("document.querySelector('[data-code-status]')?.textContent === 'Guardado'");
  const saved = await js(`window.a3.code({ action: 'open', sessionId: '${active.sessionId}', target: { resourceId: '${entity.contentResourceId}', entityId: '${entity.id}' } })`);
  assert.equal(saved.value.content, 'print("hola")\n'); assert.equal(saved.value.resourceId, entity.contentResourceId);
  await click('[data-code-close]');
  return base.documentId;
};
