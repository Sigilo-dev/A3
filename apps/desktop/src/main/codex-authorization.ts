import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { CodexAuthRequest, CodexAuthResult, CodexAuthState } from '../shared/codex-auth';
import type { CredentialState, CredentialVault, Registration, TokenSet } from './codex-credential-vault';

const ISSUER = 'https://auth.openai.com';
export const AUTH_ENDPOINT = ISSUER + '/api/accounts/authorize';
export const TOKEN_ENDPOINT = ISSUER + '/api/accounts/oauth/token';
export const DISCOVERY_ENDPOINT = ISSUER + '/.well-known/openid-configuration';
export const RESOURCE = 'https://api.openai.com/v1';
export const AUTH_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = (): string => randomBytes(32).toString('base64url');
const matches = (left: string, right: string): boolean => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const hasPlan = (tokens?: TokenSet): boolean => !!tokens && ['resource.invoke', 'chatgpt.tokens.use.direct'].every((scope) => tokens.scopes.includes(scope));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32768;
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string };
type Pending = { server: Server; state: string; nonce: string; verifier: string; redirect: string; account?: Registration; clientId?: string; abort: AbortController; timer: ReturnType<typeof setTimeout>; consumed: boolean };
class AuthFailure extends Error { constructor(readonly code: string) { super(code); } }

export interface AuthorizationOptions {
  vault: CredentialVault;
  openBrowser(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Host-only public OAuth client. Network and secure storage are explicit, replaceable boundaries. */
export class CodexAuthorization {
  private state: CredentialState = { version: 1, hostId: 'urn:uuid:' + randomUUID(), activeId: null, accounts: [] };
  private loaded = false;
  private pending?: Pending;
  private diagnostic = 'NOT_CONFIGURED';
  private busy = false;
  private callbackBusy = false;
  private retryClient?: string;
  private disposed = false;
  private abort?: AbortController;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  constructor(private readonly options: AuthorizationOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; }

  private async load(): Promise<void> {
    if (!this.options.vault.available()) throw new AuthFailure('SECURE_STORAGE_UNAVAILABLE');
    if (!this.loaded) {
      try {
        this.state = await this.options.vault.load(); this.loaded = true;
        const tokens = this.state.accounts.find((account) => account.id === this.state.activeId)?.tokens;
        this.diagnostic = !tokens ? 'NOT_CONFIGURED' : tokens.expiresAt <= this.now() + 30000 ? 'REAUTHORIZATION_REQUIRED' : hasPlan(tokens) ? 'PLAN_GRANTED_NOT_TESTED' : 'PLAN_PERMISSION_MISSING';
      } catch { throw new AuthFailure('SECURE_STORAGE_UNREADABLE'); }
    }
  }
  private async persist(next: CredentialState, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try { await this.options.vault.save(next); } catch { throw new AuthFailure('SECURE_STORAGE_WRITE_FAILED'); }
    if (signal?.aborted) {
      // Cancellation can race the single-file replacement. Restore the previous encrypted envelope before allowing another attempt.
      try { await this.options.vault.save(this.state); } catch { this.diagnostic = 'SECURE_STORAGE_WRITE_FAILED'; throw new AuthFailure('SECURE_STORAGE_WRITE_FAILED'); }
      signal.throwIfAborted();
    }
    this.state = next;
  }
  private view(): CodexAuthState {
    const selected = this.state.accounts.find((account) => account.id === this.state.activeId), token = selected?.tokens;
    const available = this.options.vault.available() && !this.diagnostic.startsWith('SECURE_STORAGE_');
    const fresh = !!token && token.expiresAt > this.now() + 30000;
    return {
      status: !available || this.diagnostic.startsWith('SECURE_STORAGE_') ? 'unavailable' : this.pending ? 'authorizing' :
        !token ? 'disconnected' : !fresh ? 'expired' : hasPlan(token) ? 'connected' : 'identity-only',
      accounts: this.state.accounts.map((account) => ({ id: account.id, label: 'Cuenta · ' + account.id.slice(-8), signedIn: !!account.tokens })),
      activeAccountId: this.state.activeId, diagnostic: this.diagnostic,
      planPermission: available && fresh && hasPlan(token), inferenceVerified: false, manualAvailable: true
    };
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.operations.add(task); void task.then(() => this.operations.delete(task), () => this.operations.delete(task)); return task;
  }
  handle(input: unknown): Promise<CodexAuthResult> { return this.track(this.command(input)); }
  private async command(input: unknown): Promise<CodexAuthResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return this.denied();
    const request = input as CodexAuthRequest;
    const allowed = request.action === 'connect' ? ['action', 'accountId', 'enablePlan'] : request.action === 'select' ? ['action', 'accountId'] : ['action'];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || !['state', 'connect', 'select', 'cancel', 'disconnect', 'refresh'].includes(request.action) ||
        ('accountId' in request && (typeof request.accountId !== 'string' || !request.accountId || request.accountId.length > 64)) ||
        request.action === 'select' && !request.accountId ||
        ('enablePlan' in request && typeof request.enablePlan !== 'boolean')) return this.denied();
    if (this.disposed) return this.denied();
    if (request.action === 'cancel') { this.cancel('CANCELLED'); return { ok: true, value: this.view() }; }
    // Polling and cancellation must not wait behind a network operation or browser login.
    if (request.action === 'state') {
      if (!this.loaded && !this.busy) { this.busy = true; try { await this.load(); } catch (error) { this.diagnostic = this.code(error); } finally { this.busy = false; } }
      return { ok: true, value: this.view() };
    }
    if (this.busy || this.callbackBusy || this.pending) return { ok: false, error: { code: 'AUTH_BUSY', message: 'Cancela o termina la autorización pendiente.' } };
    this.busy = true;
    const abort = new AbortController(); this.abort = abort;
    try {
      await this.load();
      if (request.action === 'connect') await this.connect(request, abort);
      else if (request.action === 'select') {
        if (!this.state.accounts.some((account) => account.id === request.accountId)) throw new AuthFailure('UNKNOWN_ACCOUNT');
        await this.persist({ ...this.state, activeId: request.accountId }); this.diagnostic = 'ACCOUNT_SELECTED';
      } else if (request.action === 'refresh') await this.refresh(abort.signal);
      else await this.disconnect(abort.signal);
    } catch (error) { if (!abort.signal.aborted) this.diagnostic = this.code(error); }
    finally { this.busy = false; if (this.abort === abort) this.abort = undefined; }
    return { ok: true, value: this.view() };
  }
  private denied(): CodexAuthResult { return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Solicitud de autorización no permitida.' } }; }
  private code(error: unknown): string { return error instanceof AuthFailure ? error.code : 'AUTH_UNAVAILABLE'; }

  private async response(url: string, signal: AbortSignal, form?: URLSearchParams): Promise<Response> {
    const response = await this.fetcher(url, { method: form ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
      headers: form ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } : { accept: 'application/json' },
      ...(form ? { body: form.toString() } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
    return response;
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    const reader = response.body?.getReader(); if (!reader) throw new AuthFailure('INVALID_PROVIDER_RESPONSE');
    const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) throw new AuthFailure('INVALID_PROVIDER_RESPONSE'); parts.push(part.value); }
      const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data as Record<string, unknown>;
    } catch { throw new AuthFailure('INVALID_PROVIDER_RESPONSE'); } finally { await reader.cancel().catch(() => undefined); }
  }
  private async discovery(signal: AbortSignal): Promise<Discovery> {
    const response = await this.response(DISCOVERY_ENDPOINT, signal); if (!response.ok) throw new AuthFailure('DISCOVERY_UNAVAILABLE');
    const data = await this.json(response);
    const endpoint = (value: unknown): boolean => {
      if (!text(value)) return false;
      try { const url = new URL(value); return url.origin === ISSUER && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    };
    if (data.issuer !== ISSUER || data.authorization_endpoint !== AUTH_ENDPOINT || data.token_endpoint !== TOKEN_ENDPOINT ||
        !endpoint(data.jwks_uri) || !endpoint(data.revocation_endpoint) ||
        !Array.isArray(data.id_token_signing_alg_values_supported) || !data.id_token_signing_alg_values_supported.includes('RS256')) throw new AuthFailure('UNSUPPORTED_DISCOVERY');
    return data as unknown as Discovery;
  }
  private async connect(request: Extract<CodexAuthRequest, { action: 'connect' }>, abort: AbortController): Promise<void> {
    const account = request.accountId ? this.state.accounts.find((item) => item.id === request.accountId) : undefined;
    if (request.accountId && !account) throw new AuthFailure('UNKNOWN_ACCOUNT');
    if (!account && this.state.accounts.length >= 32) throw new AuthFailure('ACCOUNT_LIMIT');
    await this.discovery(abort.signal);
    // Persist the stable host identifier before the first browser authorization.
    await this.persist(this.state); abort.signal.throwIfAborted();
    const server = createServer({ maxHeaderSize: 16384 });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    if (abort.signal.aborted) { server.close(); abort.signal.throwIfAborted(); }
    const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new AuthFailure('CALLBACK_UNAVAILABLE'); }
    const clientId = account?.clientId ?? this.retryClient;
    const pending: Pending = { server, state: random(), nonce: random(), verifier: random(), redirect: `http://127.0.0.1:${address.port}/auth/callback`, account, clientId,
      abort, timer: setTimeout(() => this.cancel('AUTH_TIMEOUT'), this.options.timeoutMs ?? 300000), consumed: false };
    this.pending = pending;
    server.on('request', (req, res) => { void this.track(this.callback(pending, req, res)).catch(() => { if (this.pending === pending) this.cancel('AUTH_UNAVAILABLE'); }); });
    server.on('error', () => { if (this.pending === pending) this.cancel('CALLBACK_UNAVAILABLE'); });
    const url = new URL(AUTH_ENDPOINT);
    const parameters: Record<string, string> = { client_id: clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.state.hostId,
      response_type: 'code', redirect_uri: pending.redirect, scope: AUTH_SCOPES, resource: RESOURCE,
      state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') };
    if (!clientId) parameters.agent_name_hint = 'A3';
    if (account?.tokens) parameters.id_token_hint = account.tokens.idToken;
    if (request.enablePlan) parameters.prompt = 'consent';
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    this.diagnostic = 'WAITING_FOR_BROWSER';
    try { await this.options.openBrowser(url.href); } catch { this.cancel('BROWSER_UNAVAILABLE'); }
  }
  private reply(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', connection: 'close' });
    res.end(status === 200 ? 'A3: vuelve a la aplicación para comprobar la conexión.' : 'A3: autorización rechazada. Vuelve a la aplicación.');
  }
  private async callback(pending: Pending, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.pending !== pending || pending.consumed) { this.reply(res, 410); return; }
    let url: URL;
    try { url = new URL(req.url ?? '', pending.redirect); } catch { this.reply(res, 400); return; }
    if (req.method !== 'GET' || req.headers.host !== new URL(pending.redirect).host || req.headers.origin ||
        req.socket.remoteAddress !== '127.0.0.1' || url.origin !== new URL(pending.redirect).origin || url.pathname !== '/auth/callback' || url.hash ||
        !req.url?.startsWith('/auth/callback?')) { this.reply(res, 400); return; }
    if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
        !matches(url.searchParams.get('state') ?? '', pending.state)) {
      this.reply(res, 400); this.cancel('INVALID_STATE'); return;
    }
    pending.consumed = true;
    this.reply(res, 200); pending.server.close(); pending.server.closeIdleConnections();
    if (url.searchParams.has('error')) { this.cancel(url.searchParams.get('error') === 'access_denied' ? 'CONSENT_DECLINED' : 'PROVIDER_DENIED'); return; }
    const client = url.searchParams.get('client_id') ?? pending.clientId;
    const code = url.searchParams.get('code');
    if (!client || !/^[a-zA-Z0-9_-]{1,256}$/.test(client) || client === 'dynamic_agent_client' || !text(code) ||
        pending.clientId && client !== pending.clientId) { this.cancel('INVALID_CALLBACK'); return; }
    this.callbackBusy = true;
    try {
      const discovery = await this.discovery(pending.abort.signal);
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: client, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, resource: RESOURCE });
      const data = await this.exchange(form, pending.abort.signal);
      const tokens = this.tokens(data);
      const subject = await this.identity(tokens.idToken, client, discovery, pending.abort.signal, pending.nonce);
      if (pending.account && pending.account.subject !== subject) throw new AuthFailure('ACCOUNT_MISMATCH');
      const existing = this.state.accounts.find((item) => item.clientId === client);
      if (existing && existing.subject !== subject) throw new AuthFailure('ACCOUNT_MISMATCH');
      const account: Registration = { id: existing?.id ?? randomUUID(), clientId: client, subject, tokens };
      pending.abort.signal.throwIfAborted();
      await this.persist({ ...this.state, activeId: account.id, accounts: [...this.state.accounts.filter((item) => item.id !== account.id), account] }, pending.abort.signal);
      if (this.pending === pending) { this.retryClient = undefined; this.diagnostic = hasPlan(tokens) ? 'PLAN_GRANTED_NOT_TESTED' : 'PLAN_PERMISSION_MISSING'; this.finish(pending); }
    } catch (error) {
      if (this.pending === pending) { if (!pending.account && error instanceof AuthFailure && error.code === 'REAUTHORIZATION_REQUIRED') this.retryClient = client; this.cancel(this.code(error)); }
    } finally { this.callbackBusy = false; }
  }
  private async exchange(form: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.response(TOKEN_ENDPOINT, signal, form);
    if (!response.ok) {
      // Provider bodies can contain secrets or arbitrary text. Only allowlisted machine codes leave this boundary.
      const data = await this.json(response).catch(() => ({} as Record<string, unknown>));
      const invalid = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];
      if (invalid.includes(String(data.error))) throw new AuthFailure('REAUTHORIZATION_REQUIRED');
      throw new AuthFailure(response.status === 403 ? 'PLAN_ACCESS_DENIED' : response.status === 429 ? 'USAGE_LIMIT' : response.status === 401 ? 'AUTH_REJECTED' : 'AUTH_TEMPORARILY_UNAVAILABLE');
    }
    return this.json(response);
  }
  private tokens(data: Record<string, unknown>, previous?: TokenSet): TokenSet {
    if (!text(data.access_token) || data.token_type !== 'Bearer' || typeof data.scope !== 'string' || data.scope.length > 8192 ||
        typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 ||
        !(text(data.id_token) || previous) || data.refresh_token !== undefined && !text(data.refresh_token)) throw new AuthFailure('INVALID_TOKEN_RESPONSE');
    const scopes = [...new Set(data.scope.split(/\s+/).filter(Boolean))];
    if (scopes.length > 64 || !scopes.includes('openid') || scopes.includes('offline_access') && !text(data.refresh_token)) throw new AuthFailure('INVALID_TOKEN_RESPONSE');
    return { accessToken: data.access_token, refreshToken: data.refresh_token as string | undefined, idToken: (data.id_token as string | undefined) ?? previous!.idToken,
      scopes, expiresAt: this.now() + data.expires_in * 1000 };
  }
  private async identity(token: string, client: string, discovery: Discovery, signal: AbortSignal, nonce?: string): Promise<string> {
    const response = await this.response(discovery.jwks_uri, signal); if (!response.ok) throw new AuthFailure('IDENTITY_KEYS_UNAVAILABLE');
    try {
      const keys = await this.json(response);
      const { payload } = await jwtVerify(token, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
        algorithms: ['RS256'], issuer: ISSUER, audience: client, requiredClaims: ['sub', 'exp', 'iat'], currentDate: new Date(this.now())
      });
      if (!text(payload.sub) || typeof payload.iat !== 'number' || payload.iat > this.now() / 1000 + 30 ||
          nonce && (typeof payload.nonce !== 'string' || !matches(payload.nonce, nonce)) ||
          payload.azp !== undefined && payload.azp !== client || Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== client) throw new Error();
      return payload.sub;
    } catch { throw new AuthFailure('INVALID_IDENTITY'); }
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    const account = this.state.accounts.find((item) => item.id === this.state.activeId);
    if (!account?.tokens?.refreshToken) throw new AuthFailure('REAUTHORIZATION_REQUIRED');
    try {
      const discovery = await this.discovery(signal);
      const data = await this.exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.tokens.refreshToken, resource: RESOURCE }), signal);
      const tokens = this.tokens(data, account.tokens);
      if (!tokens.refreshToken) throw new AuthFailure('INVALID_TOKEN_RESPONSE');
      if (data.id_token !== undefined && await this.identity(tokens.idToken, account.clientId, discovery, signal) !== account.subject) throw new AuthFailure('ACCOUNT_MISMATCH');
      signal.throwIfAborted(); await this.replace({ ...account, tokens }, signal); this.diagnostic = hasPlan(tokens) ? 'PLAN_GRANTED_NOT_TESTED' : 'PLAN_PERMISSION_MISSING';
    } catch (error) {
      if (error instanceof AuthFailure && error.code === 'REAUTHORIZATION_REQUIRED') await this.replace({ ...account, tokens: undefined });
      throw error;
    }
  }
  private async replace(account: Registration, signal?: AbortSignal): Promise<void> { await this.persist({ ...this.state, accounts: this.state.accounts.map((item) => item.id === account.id ? account : item) }, signal); }
  private async disconnect(signal: AbortSignal): Promise<void> {
    const account = this.state.accounts.find((item) => item.id === this.state.activeId);
    if (!account?.tokens) { this.diagnostic = 'DISCONNECTED'; return; }
    let revoked = !account.tokens.refreshToken;
    try {
      if (account.tokens.refreshToken) {
        const discovery = await this.discovery(signal);
        const response = await this.response(discovery.revocation_endpoint, signal, new URLSearchParams({ token: account.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }));
        revoked = response.status === 200; await response.body?.cancel();
      }
    } catch { /* Clear locally even when the provider cannot confirm revocation. */ }
    await this.replace({ ...account, tokens: undefined }); this.diagnostic = revoked ? 'DISCONNECTED' : 'REMOTE_REVOCATION_UNCONFIRMED';
  }
  private finish(pending: Pending): void { clearTimeout(pending.timer); pending.server.close(); pending.server.closeAllConnections(); if (this.pending === pending) this.pending = undefined; }
  private cancel(diagnostic: string): void { this.diagnostic = diagnostic; this.abort?.abort(); if (this.pending) { const pending = this.pending; pending.abort.abort(); this.finish(pending); } }
  dispose(): void { this.disposed = true; this.cancel('CANCELLED'); }
  async shutdown(): Promise<void> { this.dispose(); await Promise.allSettled([...this.operations]); }
}
