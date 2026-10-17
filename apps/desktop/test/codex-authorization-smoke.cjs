const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { get } = require('node:http');
const { generateKeyPairSync, sign } = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, webContents } = require('electron');
const [entry, profileDirectory, root, mode] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/e5/codex-auth/provider.json'), 'utf8'));
const channel = 'a3.codex:authorization', handlers = new Map(), originalHandle = ipcMain.handle.bind(ipcMain);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const created = new Promise((accept) => app.once('browser-window-created', (_event, win) => accept(win)));
let authorization, exchangeCount = 0;
function jwt(clientId, nonce) {
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const value = encoded({ alg: 'RS256', kid: 'synthetic' }) + '.' + encoded({ iss: fixture.discovery.issuer, aud: clientId, sub: fixture.subject, iat: now, exp: now + 3600, nonce });
  return value + '.' + sign('sha256', Buffer.from(value), keys.privateKey).toString('base64url');
}
ipcMain.handle = (name, listener) => { handlers.set(name, listener); originalHandle(name, listener); };
app.setPath('userData', profileDirectory); BrowserWindow.prototype.show = function () {};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = () => { console.error('Synthetic desktop startup failed'); app.exit(3); };
shell.openExternal = async (url) => { authorization = new URL(url); };
// Intercept the host transport in the test process, never add an injection endpoint to product IPC.
globalThis.fetch = async (url, init) => {
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json(fixture.discovery);
  if (url === fixture.discovery.jwks_uri) return Response.json({ keys: [publicKey] });
  if (url === fixture.discovery.revocation_endpoint) return new Response(null, { status: 200 });
  assert.equal(url, fixture.discovery.token_endpoint); exchangeCount++;
  const form = new URLSearchParams(init.body); assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  return Response.json({ access_token: 'synthetic-secret-access', refresh_token: 'synthetic-secret-refresh', id_token: jwt(form.get('client_id'), authorization.searchParams.get('nonce')), token_type: 'Bearer', scope: fixture.scopes, expires_in: 3600 });
};
const ready = app.whenReady().then(() => {
  session.fromPartition('persist:a3-manual-chatgpt-v1').protocol.handle('https', () => new Response('<!doctype html><title>Synthetic manual chat</title><p>Manual session</p>', { headers: { 'content-type': 'text/html' } }));
});
function callback(state) {
  const url = new URL(authorization.searchParams.get('redirect_uri'));
  url.searchParams.set('state', state); url.searchParams.set('code', 'synthetic-code'); url.searchParams.set('client_id', fixture.clientId);
  return new Promise((accept, reject) => get(url, (res) => { res.resume(); res.once('end', () => accept(res.statusCode)); }).on('error', reject));
}
async function run() {
  const win = await created; await ready; win.webContents.setBackgroundThrottling(false); await new Promise((accept) => win.webContents.once('did-finish-load', accept));
  const js = (source) => win.webContents.executeJavaScript(source);
  async function until(predicate) { for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise((accept) => setTimeout(accept, 20)); } throw new Error('Synthetic authorization UI timed out'); }
  const wait = (source) => until(() => js(source)), click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`);
  const request = (value) => js(`window.a3.codexAuthorization(${JSON.stringify(value)})`);
  await wait("Boolean(document.querySelector('[data-open-project]'))"); await click('[data-open-project]'); await wait("Boolean(document.querySelector('[data-active-project]'))");
  await click('[data-section="agent"]'); await wait("Boolean(document.querySelector('[data-codex-connect]'))");
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'DPAPI must be available on this Windows host');
  const manual = session.fromPartition('persist:a3-manual-chatgpt-v1');
  if (mode === 'connect') {
    await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='disconnected'");
    await manual.cookies.set({ url: 'https://chatgpt.com', name: 'a3-oauth-independent', value: 'synthetic-cookie', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
    await click('[data-codex-connect]'); await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='authorizing'");
    assert.equal(await callback('invalid-state'), 400); await wait("document.querySelector('[data-codex-status]')?.textContent.includes('no corresponde')"); assert.equal(exchangeCount, 0);
    await click('[data-codex-connect]'); await wait("!document.querySelector('[data-codex-cancel]').disabled"); await click('[data-codex-cancel]');
    await wait("document.querySelector('[data-codex-status]')?.textContent.includes('cancelada')"); assert.equal(exchangeCount, 0);
    await click('[data-codex-connect]'); await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='authorizing'");
    assert.equal(await callback(authorization.searchParams.get('state')), 200); await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='connected'");
    const value = (await request({ action: 'state' })).value;
    assert.equal(value.planPermission, true); assert.equal(value.inferenceVerified, false); assert.equal(value.accounts.length, 1);
    const serialized = JSON.stringify(value); for (const secret of ['synthetic-secret-', fixture.subject, fixture.clientId, authorization.searchParams.get('state'), authorization.searchParams.get('nonce')]) assert.equal(serialized.includes(secret), false);
    const path = join(profileDirectory, 'codex-authorization', 'credentials.bin'), encrypted = readFileSync(path);
    assert.equal(encrypted.includes(Buffer.from('synthetic-secret-')), false); const decoded = JSON.parse(safeStorage.decryptString(encrypted)); assert.equal(decoded.accounts[0].tokens.accessToken, 'synthetic-secret-access');
    for (const secret of [decoded.accounts[0].tokens.accessToken, decoded.accounts[0].tokens.refreshToken, decoded.accounts[0].tokens.idToken]) assert.equal(serialized.includes(secret), false);
    assert.ok(!resolve(path).startsWith(resolve(root))); assert.equal((await manual.cookies.get({ name: 'a3-oauth-independent' })).length, 1);
    assert.equal(await js("typeof window.require + ':' + typeof window.process"), 'undefined:undefined');
    assert.equal((await request({ action: 'connect', accessToken: 'injected' })).ok, false);
    await click('[data-codex-manual]'); await wait("document.querySelectorAll('[data-chat-tab]').length===1");
    const remote = () => webContents.getAllWebContents().find((value) => value.session === manual && !value.isDestroyed()); await until(() => remote() && !remote().isLoading());
    assert.equal(await remote().executeJavaScript('typeof window.a3'), 'undefined');
    for (const event of [{ sender: remote(), senderFrame: remote().mainFrame }, { sender: win.webContents, senderFrame: remote().mainFrame }]) assert.equal((await handlers.get(channel)(event, { action: 'state' })).error.code, 'PERMISSION_DENIED');
    // Manual logout is not OAuth disconnect.
    await click('[data-chat-logout]'); await wait("document.querySelector('[data-chat-notice]')?.textContent.includes('eliminados')"); assert.equal((await request({ action: 'state' })).value.status, 'connected');
  } else {
    await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='connected'"); assert.equal(exchangeCount, 0, 'Restoration does not authorize or infer');
    await manual.cookies.set({ url: 'https://chatgpt.com', name: 'a3-oauth-independent', value: 'synthetic-cookie', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
    await click('[data-codex-disconnect]'); await wait("document.querySelector('[data-codex-status]')?.dataset.codexStatus==='disconnected'");
    const envelope = JSON.parse(safeStorage.decryptString(readFileSync(join(profileDirectory, 'codex-authorization', 'credentials.bin'))));
    assert.equal(envelope.accounts.length, 1); assert.equal(envelope.accounts[0].tokens, undefined); assert.equal((await manual.cookies.get({ name: 'a3-oauth-independent' })).length, 1);
  }
  console.log('A3_CODEX_AUTH_SMOKE=' + JSON.stringify({ passed: true, mode, checks: ['Windows DPAPI encrypted host envelope', 'trusted typed IPC only', 'manual/OAuth session independence', 'portable project bytes unchanged', mode === 'connect' ? 'invalid state, cancellation and synthetic OAuth through local UI' : 'new-process encrypted session restoration and disconnect'] }));
  win.close();
}
void run().catch(() => { console.error('Synthetic authorization smoke failed; no provider data logged.'); app.exit(2); }); require(entry);
