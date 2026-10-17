import { randomUUID } from 'node:crypto';
import { CodexTurnJournal } from './codex-turn-journal.ts';
import { demand, digest, canonical, object, opaqueId, terminal, TurnError, uuid, validReceipt,
  type AgentTurn, type OperationReceipt, type TurnBinding, type TurnChange, type TurnOperation, type TurnState } from './codex-turn-state.ts';
import type { CodexSessionEvent, CodexSessionRequest } from './codex-app-server.ts';

export interface SessionTransport {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  request(request: CodexSessionRequest): Promise<Record<string, unknown>>;
  subscribe(listener: (event: CodexSessionEvent) => void): () => void;
}
/** The future E5-D host bridge must enforce its broker and persist receipts with effects in the project journal. */
export interface OperationExecutor {
  authorize(binding: TurnBinding, request: OperationRequest): Promise<boolean>;
  execute(binding: TurnBinding, request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt>;
  lookup(binding: TurnBinding, operation: Pick<TurnOperation, 'id' | 'requestHash'>): Promise<OperationReceipt | null>;
}
export interface OperationRequest {
  projectId: string; operationId: string; actor: { kind: string; id: string }; command: string;
  expectedRevisions: unknown[]; scope: Record<string, unknown>; payload: unknown;
}
export interface TurnCoordinatorOptions {
  transport?: SessionTransport;
  /** Failure injection at durable boundaries; never a renderer argument. */
  fault?(phase: 'prepared' | 'running' | 'effect' | 'confirmed'): Promise<void>;
}

export class CodexTurnCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly blockedConnections = new Set<string>();
  private readonly activeOperations = new Map<string, { hash: string; promise: Promise<OperationReceipt>; abort: AbortController }>();
  private unsubscribe?: () => void;
  private closing?: Promise<void>;
  private constructor(readonly journal: CodexTurnJournal, private readonly options: TurnCoordinatorOptions) {}

  static async open(userData: string, binding: TurnBinding, options: TurnCoordinatorOptions = {}): Promise<CodexTurnCoordinator> {
    const journal = await CodexTurnJournal.open(userData, binding);
    const coordinator = new CodexTurnCoordinator(journal, options);
    try {
      const state = journal.snapshot();
      if (!journal.readOnly && (state.turns.some((turn) => ['running', 'cancelling'].includes(turn.status)) || state.operations.some((operation) => operation.status === 'running'))) {
        await journal.append({ type: 'diagnostic', code: 'HOST_RESTARTED', uncertain: true });
      }
      coordinator.unsubscribe = options.transport?.subscribe((event) => {
        const task = event.type === 'notification' ? coordinator.ingest(event) : coordinator.streamLost(event.code);
        void task.catch(() => undefined); // typed diagnostic remains in the journal/read-only snapshot
      });
      return coordinator;
    } catch (error) { await journal.close(); throw error; }
  }
  get readOnly(): boolean { return this.journal.readOnly; }
  snapshot(): TurnState { return this.journal.snapshot(); }
  async flush(): Promise<void> { await this.queue; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { demand(!this.closed, 'SESSION_CLOSED'); return operation(); });
    this.queue = next.catch(() => undefined); return next;
  }
  private binding(): TurnBinding { const state = this.snapshot(); return { projectId: state.projectId, rootIdentity: state.rootIdentity }; }
  private turn(id: string): AgentTurn { const turn = this.snapshot().turns.find((entry) => entry.id === id); demand(turn, 'TURN_MISSING'); return turn; }

  /** IDs must come from a validated provider result in the host, never from a web page. */
  addSession(threadId: string, providerSessionId: string, id = randomUUID()): Promise<string> {
    return this.serial(async () => {
      demand(opaqueId(threadId) && opaqueId(providerSessionId) && uuid(id));
      const existing = this.snapshot().sessions.find((session) => session.threadId === threadId);
      if (existing) { demand(existing.providerSessionId === providerSessionId, 'SESSION_MISMATCH'); return existing.id; }
      await this.journal.append({ type: 'session', value: { id, threadId, providerSessionId } }); return id;
    });
  }
  trackTurn(sessionId: string, providerTurnId: string, operationId: string, id = randomUUID()): Promise<string> {
    return this.serial(async () => {
      demand(uuid(operationId));
      const existing = this.snapshot().turns.find((turn) => turn.operationId === operationId || turn.sessionId === sessionId && turn.providerTurnId === providerTurnId);
      if (existing) { demand(existing.operationId === operationId && existing.sessionId === sessionId && existing.providerTurnId === providerTurnId, 'TURN_ID_REUSED'); return existing.id; }
      await this.journal.append({ type: 'turn', value: { id, sessionId, providerTurnId, operationId, status: 'running', providerStatus: null } }); return id;
    });
  }

  streamLost(code = 'STREAM_DISCONNECTED'): Promise<void> {
    return this.serial(async () => {
      demand(/^[A-Z_]{1,64}$/.test(code));
      if (this.journal.readOnly) return;
      const state = this.snapshot();
      if (state.diagnostics.includes(code) && !state.turns.some((turn) => ['running', 'cancelling'].includes(turn.status))) return;
      await this.journal.append({ type: 'diagnostic', code, uncertain: true });
    });
  }

  ingest(event: Extract<CodexSessionEvent, { type: 'notification' }>): Promise<void> {
    return this.serial(async () => {
      demand(uuid(event.connectionId) && Number.isSafeInteger(event.sequence) && event.sequence > 0);
      if (this.blockedConnections.has(event.connectionId)) return;
      let hash: string;
      try { demand(canonical(event.message).length <= 1024 * 1024); hash = digest(event.message); }
      catch { await this.rejectStream(event.connectionId, 'MALFORMED_PROVIDER_EVENT'); return; }
      const state = this.snapshot(), known = state.deliveries.find((delivery) => delivery.connectionId === event.connectionId && delivery.sequence === event.sequence);
      if (known) { if (known.hash !== hash) await this.rejectStream(event.connectionId, 'DELIVERY_ID_REUSED'); return; }
      const previous = state.deliveries.filter((delivery) => delivery.connectionId === event.connectionId).at(-1);
      if (event.sequence !== (previous?.sequence ?? 0) + 1) { await this.rejectStream(event.connectionId, 'STREAM_SEQUENCE_GAP'); return; }
      try {
        const change = this.normalize(event.message);
        await this.journal.append({ type: 'delivery', delivery: { connectionId: event.connectionId, sequence: event.sequence, hash }, change });
      } catch (error) {
        if (this.journal.readOnly) throw error;
        await this.rejectStream(event.connectionId, error instanceof TurnError ? error.code : 'MALFORMED_PROVIDER_EVENT');
      }
    });
  }
  private async rejectStream(connectionId: string, code: string): Promise<void> {
    this.blockedConnections.add(connectionId);
    await this.journal.append({ type: 'diagnostic', code, uncertain: true });
  }
  private normalize(message: Record<string, unknown>): TurnChange {
    demand(object(message) && typeof message.method === 'string' && object(message.params), 'MALFORMED_PROVIDER_EVENT');
    const p = message.params;
    if (message.method === 'error') return { type: 'diagnostic', code: 'PROVIDER_TURN_ERROR', uncertain: true };
    if (!['turn/started', 'turn/completed', 'item/completed', 'item/agentMessage/delta'].includes(message.method)) {
      return { type: 'diagnostic', code: 'UNHANDLED_PROVIDER_EVENT', uncertain: false };
    }
    const providerTurnId = message.method.startsWith('turn/') && object(p.turn) ? p.turn.id : p.turnId;
    const session = this.snapshot().sessions.find((entry) => entry.threadId === p.threadId);
    const turn = this.snapshot().turns.find((entry) => entry.sessionId === session?.id && entry.providerTurnId === providerTurnId);
    demand(session && turn, 'PROVIDER_CONTEXT_MISMATCH');
    if (message.method === 'turn/completed') {
      demand(object(p.turn) && ['completed', 'failed', 'interrupted'].includes(String(p.turn.status)), 'MALFORMED_PROVIDER_EVENT');
      return { type: 'provider-status', turnId: turn.id, status: p.turn.status as 'completed' | 'failed' | 'interrupted' };
    }
    if (message.method === 'turn/started') return { type: 'diagnostic', code: 'TURN_OBSERVED', uncertain: false };
    if (message.method === 'item/completed') {
      demand(object(p.item) && opaqueId(p.item.id) && typeof p.item.type === 'string', 'MALFORMED_PROVIDER_EVENT');
      if (p.item.type !== 'agentMessage') return { type: 'diagnostic', code: 'PROVIDER_TOOL_EVENT_NOT_EXECUTED', uncertain: false };
      demand(typeof p.item.text === 'string', 'MALFORMED_PROVIDER_EVENT');
      return { type: 'message', turnId: turn.id, itemId: p.item.id, text: p.item.text, confirmed: true };
    }
    demand(opaqueId(p.itemId) && typeof p.delta === 'string', 'MALFORMED_PROVIDER_EVENT');
    if (terminal(turn.status)) return { type: 'diagnostic', code: 'LATE_DELTA_IGNORED', uncertain: false };
    if (turn.status === 'uncertain') return { type: 'diagnostic', code: 'UNCERTAIN_DELTA_IGNORED', uncertain: false };
    return { type: 'message', turnId: turn.id, itemId: p.itemId, text: p.delta, confirmed: false };
  }

  async cancel(turnId: string): Promise<void> {
    const target = await this.serial(async () => {
      const turn = this.turn(turnId); if (terminal(turn.status)) return null;
      await this.journal.append({ type: 'status', turnId, status: 'cancelling' });
      for (const operation of this.snapshot().operations.filter((entry) => entry.turnId === turnId)) {
        this.activeOperations.get(operation.id)?.abort.abort();
        if (operation.status === 'prepared' || operation.status === 'running') {
          await this.journal.append({ type: 'operation', value: { ...operation, status: operation.status === 'prepared' ? 'cancelled' : 'uncertain' } });
        }
      }
      const session = this.snapshot().sessions.find((entry) => entry.id === turn.sessionId)!;
      return { threadId: session.threadId, turnId: turn.providerTurnId };
    });
    if (!target) return;
    try {
      demand(this.options.transport, 'CANCELLATION_UNCONFIRMED');
      await this.options.transport.request({ method: 'turn/interrupt', params: target });
      // An RPC acknowledgement is not a terminal turn event.
    } catch { await this.streamLost('CANCELLATION_UNCONFIRMED'); }
  }

  async reconnect(sessionId: string): Promise<void> {
    const session = this.snapshot().sessions.find((entry) => entry.id === sessionId); demand(session, 'SESSION_MISSING');
    try {
      demand(this.options.transport, 'PROVIDER_NOT_CONFIGURED');
      await this.options.transport.start();
      const result = await this.options.transport.request({ method: 'thread/resume', params: { threadId: session.threadId, excludeTurns: true } });
      demand(object(result.thread) && result.thread.id === session.threadId && result.thread.sessionId === session.providerSessionId, 'SESSION_MISMATCH');
      // History pagination cursors are not event-replay cursors. Never resend a turn or a tool here.
      await this.streamLost('STDIO_REPLAY_UNAVAILABLE');
    } catch { await this.streamLost('RECONNECT_UNCERTAIN'); }
  }

  runOperation(turnId: string, request: OperationRequest, executor: OperationExecutor): Promise<OperationReceipt> {
    try {
      demand(object(request) && request.projectId === this.snapshot().projectId && uuid(request.operationId) && object(request.actor) &&
        typeof request.actor.kind === 'string' && typeof request.actor.id === 'string' && typeof request.command === 'string' &&
        Array.isArray(request.expectedRevisions) && object(request.scope), 'INVALID_OPERATION');
      demand(canonical(request).length <= 1024 * 1024, 'OPERATION_SIZE_LIMIT');
      const hash = digest(request), active = this.activeOperations.get(request.operationId);
      if (active) { demand(active.hash === hash, 'OPERATION_ID_REUSED'); return active.promise; }
      const abort = new AbortController();
      const promise = this.dispatch(turnId, structuredClone(request), hash, executor, abort);
      this.activeOperations.set(request.operationId, { hash, promise, abort });
      void promise.finally(() => this.activeOperations.delete(request.operationId)).catch(() => undefined);
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private async dispatch(turnId: string, request: OperationRequest, hash: string, executor: OperationExecutor, abort: AbortController): Promise<OperationReceipt> {
    let authorized = false;
    try { authorized = await executor.authorize(this.binding(), request); } catch { /* deny without exposing a provider/broker body */ }
    demand(authorized, 'PERMISSION_DENIED');
    const receipt = await this.serial(async () => {
      const existing = this.snapshot().operations.find((entry) => entry.id === request.operationId);
      if (existing) {
        demand(existing.requestHash === hash, 'OPERATION_ID_REUSED');
        if (existing.status === 'confirmed') return existing.receipt!;
        demand(existing.status === 'prepared' && existing.turnId === turnId, 'OPERATION_REPLAY_BLOCKED');
      }
      demand(this.turn(turnId).status === 'running', 'TURN_NOT_RUNNING');
      if (!existing) await this.journal.append({ type: 'operation', value: { id: request.operationId, turnId, requestHash: hash, status: 'prepared' } });
      return null;
    });
    if (receipt) return receipt;
    await this.options.fault?.('prepared');
    // The project journal may already hold a receipt even if the local session record was lost.
    let recovered: OperationReceipt | null;
    try { recovered = await executor.lookup(this.binding(), { id: request.operationId, requestHash: hash }); }
    catch { await this.streamLost('OPERATION_LOOKUP_FAILED'); throw new TurnError('OPERATION_LOOKUP_FAILED'); }
    if (recovered) return this.serial(async () => {
      const operation = this.snapshot().operations.find((entry) => entry.id === request.operationId)!;
      demand(validReceipt(recovered, this.binding(), operation), 'INVALID_OPERATION_RECEIPT');
      await this.journal.append({ type: 'operation', value: { ...operation, status: 'confirmed', receipt: recovered } });
      return recovered;
    });
    // Recheck after asynchronous preparation/receipt lookup; the executor must revalidate at its own write boundary too.
    try { authorized = await executor.authorize(this.binding(), request); } catch { authorized = false; }
    demand(authorized, 'PERMISSION_DENIED');
    await this.serial(async () => {
      demand(this.turn(turnId).status === 'running' && !abort.signal.aborted, 'CANCELLED');
      const operation = this.snapshot().operations.find((entry) => entry.id === request.operationId)!;
      await this.journal.append({ type: 'operation', value: { ...operation, status: 'running' } });
    });
    try {
      await this.options.fault?.('running');
      const result = await executor.execute(this.binding(), request, abort.signal);
      await this.options.fault?.('effect');
      await this.serial(async () => {
        const operation = this.snapshot().operations.find((entry) => entry.id === request.operationId)!;
        demand(validReceipt(result, this.binding(), operation), 'INVALID_OPERATION_RECEIPT');
        await this.journal.append({ type: 'operation', value: { ...operation, status: 'confirmed', receipt: result } });
      });
      await this.options.fault?.('confirmed');
      return structuredClone(result);
    } catch {
      if (!this.closed && !this.journal.readOnly) await this.serial(async () => {
        const operation = this.snapshot().operations.find((entry) => entry.id === request.operationId)!;
        if (operation.status === 'running') await this.journal.append({ type: 'operation', value: { ...operation, status: 'uncertain' } });
        await this.journal.append({ type: 'diagnostic', code: 'OPERATION_RESULT_UNCERTAIN', uncertain: true });
      });
      throw new TurnError('OPERATION_RESULT_UNCERTAIN');
    }
  }

  reconcileOperation(operationId: string, executor: OperationExecutor): Promise<OperationReceipt | null> {
    return this.serial(async () => {
      const operation = this.snapshot().operations.find((entry) => entry.id === operationId); demand(operation, 'OPERATION_MISSING');
      if (operation.status === 'confirmed') return operation.receipt!;
      const receipt = await executor.lookup(this.binding(), operation);
      if (!receipt) {
        if (operation.status === 'running') await this.journal.append({ type: 'operation', value: { ...operation, status: 'uncertain' } });
        return null;
      }
      demand(validReceipt(receipt, this.binding(), operation), 'INVALID_OPERATION_RECEIPT');
      await this.journal.append({ type: 'operation', value: { ...operation, status: 'confirmed', receipt } }); return receipt;
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.unsubscribe?.();
    this.closing = this.serial(async () => {
      for (const operation of this.activeOperations.values()) operation.abort.abort();
      try { if (!this.journal.readOnly) await this.journal.append({ type: 'diagnostic', code: 'HOST_STOPPED', uncertain: true }); }
      finally { this.closed = true; await this.journal.close(); }
    });
    return this.closing;
  }
}

/** Lazy main-process owner; switching project roots closes the previous stream before binding another. */
export class CodexTurnHost {
  private active?: { key: string; coordinator: CodexTurnCoordinator; transport: SessionTransport; closing: boolean };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly createTransport: (binding: TurnBinding) => SessionTransport) {}
  private async release(): Promise<void> {
    if (!this.active) return;
    this.active.closing = true;
    let closeError: unknown;
    try { await this.active.coordinator.close(); } catch (error) { closeError = error; }
    // Keep ownership if the provider cannot be stopped: a second project/process must not overlap it.
    await this.active.transport.stop(); this.active = undefined;
    if (closeError) throw closeError;
  }
  openProject(binding: TurnBinding): Promise<CodexTurnCoordinator> {
    const task = this.queue.then(async () => {
      const key = digest(binding);
      if (this.active?.key === key && !this.active.closing) return this.active.coordinator;
      await this.release();
      const transport = this.createTransport(binding);
      const coordinator = await CodexTurnCoordinator.open(this.userData, binding, { transport });
      this.active = { key, coordinator, transport, closing: false }; return coordinator;
    });
    this.queue = task.catch(() => undefined); return task;
  }
  shutdown(): Promise<void> {
    const task = this.queue.then(async () => {
      await this.release();
    });
    this.queue = task.catch(() => undefined); return task;
  }
  /** Revocation closes the project-bound coordinator and asks its local provider process to stop. */
  revokeProject(projectId: string): Promise<void> {
    const task = this.queue.then(async () => {
      if (this.active?.coordinator.snapshot().projectId === projectId.toLowerCase()) await this.release();
    });
    this.queue = task.catch(() => undefined); return task;
  }
}
