import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { test } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CodexAuthorization, AUTH_ENDPOINT, TOKEN_ENDPOINT, DISCOVERY_ENDPOINT, AUTH_SCOPES, RESOURCE } from '../src/main/codex-authorization.ts';
import { SystemCredentialVault, emptyCredentials } from '../src/main/codex-credential-vault.ts';

const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e5/codex-auth/provider.json', import.meta.url), 'utf8'));
const keys = await generateKeyPair('RS256'), publicKey = { ...await exportJWK(keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
async function until(predicate) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise((accept) => setTimeout(accept, 10)); } throw new Error('Synthetic authorization did not settle'); }
function callback(url, headers) { return new Promise((accept, reject) => { get(url, { headers }, (res) => { res.resume(); res.once('end', () => accept(res.statusCode)); }).on('error', reject); }); }
function setup(options = {}) {
  let saved = options.saved ?? emptyCredentials(), authorization, exchanged = 0, refreshes = 0, revocations = 0, scopes = fixture.scopes;
  const forms = [], urls = [], flags = { claims: {}, token: {}, ...options.flags };
  const vault = {
    available: () => options.available ?? true,
    load: async () => { if (options.corrupt) throw new Error('Do not expose this sensitive diagnostic'); return structuredClone(saved); },
    save: async (state) => { if (options.failSave) throw new Error('Do not expose this sensitive diagnostic'); saved = structuredClone(state); }
  };
  const service = new CodexAuthorization({ vault, timeoutMs: options.timeoutMs ?? 5000, openBrowser: async (url) => { authorization = new URL(url); if (options.browserFails) throw new Error('sensitive URL'); },
    fetch: async (url, init) => {
      urls.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      if (flags.networkFailure) throw new Error('synthetic-secret-access-token');
      if (url === DISCOVERY_ENDPOINT) return Response.json({ ...fixture.discovery, ...options.discovery });
      if (url === fixture.discovery.jwks_uri) return Response.json({ keys: [publicKey] });
      if (url === fixture.discovery.revocation_endpoint) { revocations++; forms.push(new URLSearchParams(init.body)); return new Response(null, { status: flags.revokeFails ? 503 : 200 }); }
      assert.equal(url, TOKEN_ENDPOINT); const form = new URLSearchParams(init.body); forms.push(form);
      if (form.get('grant_type') === 'refresh_token') refreshes++; else exchanged++;
      if (flags.hold) await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (flags.error) return Response.json({ error: flags.error, error_description: 'synthetic-secret-access-token' }, { status: flags.status ?? 400 });
      const claims = { nonce: authorization.searchParams.get('nonce'), ...flags.claims };
      const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
        .setIssuer(flags.issuer ?? fixture.discovery.issuer).setAudience(flags.audience ?? fixture.clientId).setSubject(flags.subject ?? fixture.subject)
        .setIssuedAt().setExpirationTime(flags.expired ? '0s' : '1h').sign(flags.wrongKey ? (await generateKeyPair('RS256')).privateKey : keys.privateKey);
      return Response.json({ access_token: 'synthetic-secret-access-token', refresh_token: 'synthetic-secret-refresh-' + refreshes,
        id_token: token, token_type: 'Bearer', expires_in: 3600, scope: scopes, ...flags.token });
    }
  });
  const state = async () => (await service.handle({ action: 'state' })).value;
  const start = async (input = {}) => { const result = await service.handle({ action: 'connect', ...input }); assert.equal(result.ok, true); return result.value; };
  const complete = async (params = {}) => {
    const url = new URL(authorization.searchParams.get('redirect_uri'));
    for (const [name, value] of Object.entries({ state: authorization.searchParams.get('state'), code: 'synthetic-code', client_id: fixture.clientId, ...params })) if (value !== undefined) url.searchParams.set(name, value);
    const status = await callback(url); await until(async () => (await state()).status !== 'authorizing'); return status;
  };
  return { service, state, start, complete, flags, forms, urls, vault, setScopes(value) { scopes = value; }, get authorization() { return authorization; }, get saved() { return saved; }, get exchanged() { return exchanged; }, get refreshes() { return refreshes; }, get revocations() { return revocations; } };
}
function isolated(name, run) { test(name, async () => { const value = setup(); try { await run(value); } finally { value.service.dispose(); } }); }

isolated('public registration uses exact official endpoints, loopback, fresh PKCE/state/nonce and no client secret', async (s) => {
  assert.equal((await s.start()).status, 'authorizing'); const url = s.authorization;
  assert.equal(url.origin + url.pathname, AUTH_ENDPOINT); assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'A3'); assert.equal(url.searchParams.get('scope'), AUTH_SCOPES);
  const redirect = new URL(url.searchParams.get('redirect_uri')); assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
  await s.complete(); const state = await s.state(); assert.equal(state.status, 'connected'); assert.equal(state.planPermission, true); assert.equal(state.inferenceVerified, false);
  const form = s.forms[0]; assert.equal(form.get('redirect_uri'), redirect.href); assert.equal(form.get('client_id'), fixture.clientId); assert.equal(form.get('resource'), RESOURCE);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(form.has('client_secret'), false); assert.equal(JSON.stringify(state).includes('synthetic-secret'), false); assert.equal(JSON.stringify(state).includes(fixture.subject), false);
});
isolated('invalid state consumes no code and stores no token', async (s) => {
  await s.start(); assert.equal(await s.complete({ state: 'invalid-state' }), 400); assert.equal(s.exchanged, 0); assert.equal(s.saved.accounts.length, 0); assert.equal((await s.state()).diagnostic, 'INVALID_STATE');
});
isolated('duplicate parameters rejected, error validated before exchange, cancellation closes listener', async (s) => {
  await s.start(); const url = new URL(s.authorization.searchParams.get('redirect_uri')); url.searchParams.append('state', s.authorization.searchParams.get('state')); url.searchParams.append('state', 'other');
  assert.equal(await callback(url), 400); assert.equal(s.exchanged, 0);
  await s.start(); await s.complete({ error: 'access_denied' }); assert.equal((await s.state()).diagnostic, 'CONSENT_DECLINED'); assert.equal(s.exchanged, 0);
  await s.start(); const address = s.authorization.searchParams.get('redirect_uri'); await s.service.handle({ action: 'cancel' });
  await assert.rejects(callback(address + '?state=x')); assert.equal(s.saved.accounts.length, 0);
});
isolated('callback binds Host, path and origin', async (s) => {
  await s.start(); const url = new URL(s.authorization.searchParams.get('redirect_uri')); url.searchParams.set('state', s.authorization.searchParams.get('state'));
  assert.equal(await callback(url, { Host: 'evil.example' }), 400); assert.equal(await callback(url, { Origin: 'https://evil.example' }), 400);
  url.pathname = '/callback'; assert.equal(await callback(url), 400); assert.equal(s.exchanged, 0);
  await s.complete(); assert.equal((await s.state()).status, 'connected');
});
for (const [name, flags] of Object.entries({ nonce: { claims: { nonce: 'wrong' } }, issuer: { issuer: 'https://evil.example' }, audience: { audience: 'other-client' }, signature: { wrongKey: true }, expired: { expired: true }, authorizedParty: { claims: { azp: 'other-client' } } })) {
  test('rejects invalid ID token ' + name, async () => {
    const s = setup({ flags }); try { await s.start(); await s.complete(); assert.equal((await s.state()).diagnostic, 'INVALID_IDENTITY'); assert.equal(s.saved.accounts.length, 0); } finally { s.service.dispose(); }
  });
}
isolated('callback scopes never grant plan permission; token response controls identity-only state', async (s) => {
  s.setScopes('openid profile email'); await s.start(); await s.complete({ scope: fixture.scopes });
  const state = await s.state(); assert.equal(state.status, 'identity-only'); assert.equal(state.planPermission, false);
  const id = state.activeAccountId, hostId = s.saved.hostId;
  await s.start({ accountId: id, enablePlan: true }); assert.equal(s.authorization.searchParams.get('client_id'), fixture.clientId);
  assert.equal(s.authorization.searchParams.get('agent_name_hint'), null); assert.equal(s.authorization.searchParams.get('ext_agent_host_id'), hostId); assert.equal(s.authorization.searchParams.get('prompt'), 'consent');
  assert.ok(s.authorization.searchParams.get('id_token_hint')); s.setScopes(fixture.scopes); await s.complete({ client_id: undefined }); assert.equal((await s.state()).planPermission, true);
});
isolated('reauthorization cannot change registration or identity', async (s) => {
  await s.start(); await s.complete(); const saved = structuredClone(s.saved), id = saved.activeId;
  await s.start({ accountId: id }); await s.complete({ client_id: 'other-client' }); assert.equal((await s.state()).diagnostic, 'INVALID_CALLBACK'); assert.deepEqual(s.saved, saved);
  s.flags.subject = 'another-account'; await s.start({ accountId: id }); await s.complete(); assert.equal((await s.state()).diagnostic, 'ACCOUNT_MISMATCH'); assert.deepEqual(s.saved, saved);
});
isolated('invalid_grant retries the issued public client instead of creating another registration', async (s) => {
  s.flags.error = 'invalid_grant'; await s.start(); const host = s.authorization.searchParams.get('ext_agent_host_id'), state = s.authorization.searchParams.get('state'); await s.complete();
  delete s.flags.error; await s.start(); assert.equal(s.authorization.searchParams.get('client_id'), fixture.clientId); assert.equal(s.authorization.searchParams.get('agent_name_hint'), null);
  assert.equal(s.authorization.searchParams.get('ext_agent_host_id'), host); assert.notEqual(s.authorization.searchParams.get('state'), state); await s.complete({ client_id: undefined }); assert.equal(s.saved.accounts.length, 1);
});
isolated('separate registrations remain selectable and never combine credentials', async (s) => {
  await s.start(); await s.complete(); const first = structuredClone(s.saved.accounts[0]);
  await s.start(); s.flags.audience = 'oaiapp_second_synthetic'; s.flags.subject = 'synthetic-second-account'; await s.complete({ client_id: 'oaiapp_second_synthetic' });
  assert.equal(s.saved.accounts.length, 2); assert.deepEqual(s.saved.accounts[0], first); assert.notEqual(s.saved.activeId, first.id);
  await s.service.handle({ action: 'select', accountId: first.id }); assert.equal(s.saved.activeId, first.id); assert.deepEqual(s.saved.accounts[0], first);
});
isolated('renewal rotates the entire token set, serializes attempts and disconnect retains registration', async (s) => {
  await s.start(); await s.complete(); const id = s.saved.activeId;
  assert.equal((await s.service.handle({ action: 'refresh' })).value.status, 'connected'); assert.equal(s.refreshes, 1); assert.equal(s.saved.accounts[0].tokens.refreshToken, 'synthetic-secret-refresh-1');
  const refresh = s.forms.at(-1); assert.equal(refresh.has('scope'), false); assert.equal(refresh.get('client_id'), fixture.clientId);
  s.flags.hold = true; const pending = s.service.handle({ action: 'refresh' }); await until(() => s.refreshes === 2);
  assert.equal((await s.service.handle({ action: 'refresh' })).error.code, 'AUTH_BUSY'); await s.service.handle({ action: 'cancel' }); await pending; s.flags.hold = false;
  await s.service.handle({ action: 'disconnect' }); assert.equal(s.revocations, 1); assert.equal(s.saved.accounts[0].tokens, undefined); assert.equal(s.saved.activeId, id);
  await s.start({ accountId: id }); assert.equal(s.authorization.searchParams.get('id_token_hint'), null); assert.equal(s.authorization.searchParams.get('client_id'), fixture.clientId);
});
isolated('terminal refresh clears unusable tokens; temporary failures preserve them; unconfirmed revocation is explicit', async (s) => {
  await s.start(); await s.complete(); const original = structuredClone(s.saved);
  s.flags.error = 'server_error'; s.flags.status = 503; await s.service.handle({ action: 'refresh' }); assert.deepEqual(s.saved, original);
  s.flags.error = 'invalid_grant'; await s.service.handle({ action: 'refresh' }); assert.equal((await s.state()).diagnostic, 'REAUTHORIZATION_REQUIRED'); assert.equal(s.saved.accounts[0].tokens, undefined);
  delete s.flags.error; await s.start({ accountId: s.saved.activeId }); await s.complete(); s.flags.revokeFails = true;
  await s.service.handle({ action: 'disconnect' }); assert.equal((await s.state()).diagnostic, 'REMOTE_REVOCATION_UNCONFIRMED'); assert.equal(s.saved.accounts[0].tokens, undefined);
});
isolated('cancelling while exchanging prevents late token persistence', async (s) => {
  s.flags.hold = true; await s.start(); const callbackResult = s.complete(); await until(() => s.exchanged === 1);
  await s.service.handle({ action: 'cancel' }); await callbackResult; await until(async () => (await s.service.handle({ action: 'select', accountId: 'missing' })).ok);
  assert.equal(s.saved.accounts.length, 0); assert.equal((await s.state()).planPermission, false);
});
isolated('cancellation during encrypted replacement rolls back before accepting another command', async (s) => {
  const save = s.vault.save; let committing = false, release;
  s.vault.save = async (state) => {
    await save(state);
    if (state.accounts.some((account) => account.tokens)) { committing = true; await new Promise((accept) => { release = accept; }); }
  };
  await s.start(); const completion = s.complete(); await until(() => committing);
  await s.service.handle({ action: 'cancel' }); assert.equal((await s.service.handle({ action: 'connect' })).error.code, 'AUTH_BUSY');
  release(); await completion; await s.service.shutdown(); assert.equal(s.saved.accounts.length, 0);
});
isolated('refresh can retain the verified ID token, while missing rotating refresh tokens fail closed', async (s) => {
  await s.start(); await s.complete(); const id = s.saved.accounts[0].tokens.idToken;
  s.flags.token.id_token = undefined; await s.service.handle({ action: 'refresh' }); assert.equal(s.saved.accounts[0].tokens.idToken, id);
  const before = structuredClone(s.saved); s.flags.token.refresh_token = undefined; await s.service.handle({ action: 'refresh' }); assert.deepEqual(s.saved, before); assert.equal((await s.state()).diagnostic, 'INVALID_TOKEN_RESPONSE');
});
isolated('restoration reflects expiration and plan scopes without network or automatic inference', async (s) => {
  await s.start(); await s.complete(); const saved = structuredClone(s.saved); saved.accounts[0].tokens.expiresAt = 1;
  const restored = setup({ saved }); try { const state = await restored.state(); assert.equal(state.status, 'expired'); assert.equal(state.planPermission, false); assert.equal(state.inferenceVerified, false); assert.deepEqual(restored.urls, []); } finally { restored.service.dispose(); }
});
test('unavailable, corrupt storage, discovery redirects, browser failure and timeout stay manual without tokens', async () => {
  for (const options of [{ available: false }, { corrupt: true }, { failSave: true }, { discovery: { jwks_uri: 'https://evil.example/keys' } }, { browserFails: true }, { timeoutMs: 5 }]) {
    const s = setup(options); try { await s.start(); await until(async () => (await s.state()).status !== 'authorizing'); const state = await s.state(); assert.equal(state.planPermission, false); assert.equal(state.manualAvailable, true); assert.equal(s.saved.accounts.length, 0); assert.equal(s.exchanged, 0); } finally { s.service.dispose(); }
  }
});
isolated('unknown IPC properties, token injection and arbitrary endpoints are denied', async (s) => {
  for (const input of [null, [], { action: 'connect', accessToken: 'injected' }, { action: 'connect', endpoint: 'https://evil.example' }, { action: 'select' }, { action: 'refresh', accountId: 'x' }]) assert.equal((await s.service.handle(input)).ok, false);
});
test('provider admission failures are redacted, keep manual mode and never switch billing', async () => {
  for (const [status, diagnostic] of [[401, 'AUTH_REJECTED'], [403, 'PLAN_ACCESS_DENIED'], [429, 'USAGE_LIMIT'], [503, 'AUTH_TEMPORARILY_UNAVAILABLE']]) {
    const s = setup({ flags: { error: 'synthetic-provider-error', status } });
    try {
      await s.start(); await s.complete(); const state = await s.state(); assert.equal(state.diagnostic, diagnostic); assert.equal(state.planPermission, false); assert.equal(state.manualAvailable, true);
      assert.equal(JSON.stringify(state).includes('synthetic-secret'), false); assert.equal(s.saved.accounts.length, 0);
      assert.ok(s.urls.every((url) => url.startsWith('https://auth.openai.com/')));
    } finally { s.service.dispose(); }
  }
});
test('Windows OS vault writes encrypted bytes, round-trips and preserves unreadable original; Linux fails closed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'a3-auth-vault-')); const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
  const key = randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
    encryptString: (value) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString: (bytes) => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); }
  };
  try {
    const vault = new SystemCredentialVault(temp, encryption, 'win32'); const state = emptyCredentials(); state.accounts.push({ id: 'fixture', clientId: fixture.clientId, subject: fixture.subject, tokens: { accessToken: 'synthetic-secret', idToken: 'synthetic-id', scopes: ['openid'], expiresAt: Date.now() + 10000 } });
    await vault.save(state); assert.deepEqual(await vault.load(), state); const path = join(vault.directory, 'credentials.bin'), bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from('synthetic-secret')), false);
    const linux = new SystemCredentialVault(temp, encryption, 'linux'); assert.equal(linux.available(), false); await assert.rejects(linux.save(state));
    const { writeFile } = await import('node:fs/promises'); await writeFile(path, 'corrupt fixture'); await assert.rejects(vault.load()); assert.equal(await readFile(path, 'utf8'), 'corrupt fixture');
  } finally { assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith('a3-auth-vault-')); await rm(temp, { recursive: true, force: true }); }
});
