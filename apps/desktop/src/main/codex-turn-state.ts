import { createHash } from 'node:crypto';

export class TurnError extends Error {
  constructor(readonly code: string) { super(`A3 Codex: ${code}`); this.name = 'TurnError'; }
}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
export const hashId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function demand(condition: unknown, code = 'INVALID_SESSION_DATA'): asserts condition { if (!condition) throw new TurnError(code); }
export function canonical(value: unknown, depth = 0): string {
  demand(depth <= 32);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { demand(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  demand(object(value) && Object.getPrototypeOf(value) === Object.prototype);
  return '{' + Object.keys(value).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    demand(!descriptor.get && !descriptor.set);
    return JSON.stringify(key) + ':' + canonical(descriptor.value, depth + 1);
  }).join(',') + '}';
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export interface TurnBinding { projectId: string; rootIdentity: string; }
export type TurnStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export const terminal = (status: TurnStatus): boolean => ['completed', 'failed', 'interrupted'].includes(status);
export interface AgentSession { id: string; threadId: string; providerSessionId: string; }
export interface AgentTurn {
  id: string; sessionId: string; providerTurnId: string; operationId: string; status: TurnStatus;
  providerStatus: 'completed' | 'failed' | 'interrupted' | null;
}
export interface TranscriptItem { turnId: string; itemId: string; text: string; confirmed: boolean; }
/** A3 receipts contain references/hashes, never arbitrary tool output or credentials. */
export interface OperationReceipt {
  projectId: string; operationId: string; requestHash: string; resultHash: string;
  revisions: { id: string; revision: number }[];
}
export interface TurnOperation {
  id: string; turnId: string; requestHash: string;
  status: 'prepared' | 'running' | 'confirmed' | 'uncertain' | 'cancelled';
  receipt?: OperationReceipt;
}
export interface Delivery { connectionId: string; sequence: number; hash: string; }
export interface TurnState extends TurnBinding {
  version: 1; sequence: number; sessions: AgentSession[]; turns: AgentTurn[];
  transcript: TranscriptItem[]; operations: TurnOperation[]; deliveries: Delivery[]; diagnostics: string[];
}
export type TurnChange =
  | { type: 'session'; value: AgentSession }
  | { type: 'turn'; value: AgentTurn }
  | { type: 'status'; turnId: string; status: TurnStatus }
  | { type: 'provider-status'; turnId: string; status: 'completed' | 'failed' | 'interrupted' }
  | { type: 'message'; turnId: string; itemId: string; text: string; confirmed: boolean }
  | { type: 'operation'; value: TurnOperation }
  | { type: 'diagnostic'; code: string; uncertain: boolean };
export type TurnEvent = TurnChange | { type: 'delivery'; delivery: Delivery; change: TurnChange };

export function validReceipt(value: unknown, binding: TurnBinding, operation: Pick<TurnOperation, 'id' | 'requestHash'>): value is OperationReceipt {
  return object(value) && value.projectId === binding.projectId && value.operationId === operation.id && value.requestHash === operation.requestHash &&
    hashId(value.resultHash) && Array.isArray(value.revisions) && value.revisions.length <= 10000 && value.revisions.every((entry) =>
      object(entry) && uuid(entry.id) && Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 0 && Object.keys(entry).every((key) => ['id', 'revision'].includes(key))) &&
    Object.keys(value).every((key) => ['projectId', 'operationId', 'requestHash', 'resultHash', 'revisions'].includes(key));
}
export function initialTurnState(binding: TurnBinding): TurnState {
  demand(uuid(binding.projectId) && hashId(binding.rootIdentity));
  return { ...binding, version: 1, sequence: 0, sessions: [], turns: [], transcript: [], operations: [], deliveries: [], diagnostics: [] };
}

/** Validates each replayed transition as well as live commands. Transcript and confirmed receipts are monotonic. */
export function applyTurnEvent(previous: TurnState, event: TurnEvent): TurnState {
  demand(object(event));
  const state = structuredClone(previous);
  let change: TurnChange = event as TurnChange;
  if (event.type === 'delivery') {
    const delivery = event.delivery;
    demand(object(delivery) && uuid(delivery.connectionId) && Number.isSafeInteger(delivery.sequence) && delivery.sequence > 0 && hashId(delivery.hash));
    const known = state.deliveries.find((entry) => entry.connectionId === delivery.connectionId && entry.sequence === delivery.sequence);
    demand(!known || known.hash === delivery.hash, 'DELIVERY_ID_REUSED');
    if (known) return state;
    const last = state.deliveries.filter((entry) => entry.connectionId === delivery.connectionId).at(-1);
    demand(delivery.sequence === (last?.sequence ?? 0) + 1, 'STREAM_SEQUENCE_GAP');
    state.deliveries.push(structuredClone(delivery));
    change = event.change;
    demand(object(change) && change.type !== ('delivery' as string));
  }
  switch (change.type) {
    case 'session': {
      const value = change.value;
      demand(object(value) && uuid(value.id) && opaqueId(value.threadId) && opaqueId(value.providerSessionId));
      demand(!state.sessions.some((session) => session.id === value.id || session.threadId === value.threadId), 'SESSION_ID_REUSED');
      state.sessions.push({ id: value.id, threadId: value.threadId, providerSessionId: value.providerSessionId }); break;
    }
    case 'turn': {
      const value = change.value;
      demand(object(value) && uuid(value.id) && uuid(value.sessionId) && uuid(value.operationId) && opaqueId(value.providerTurnId) && value.status === 'running');
      demand(state.sessions.some((session) => session.id === value.sessionId));
      demand(!state.turns.some((turn) => turn.id === value.id || turn.operationId === value.operationId || turn.sessionId === value.sessionId && turn.providerTurnId === value.providerTurnId), 'TURN_ID_REUSED');
      demand(!state.operations.some((operation) => operation.id === value.operationId), 'OPERATION_ID_REUSED');
      demand(!state.turns.some((turn) => turn.sessionId === value.sessionId && !terminal(turn.status)), 'TURN_UNRESOLVED');
      demand(value.providerStatus === null);
      state.turns.push({ id: value.id, sessionId: value.sessionId, providerTurnId: value.providerTurnId, operationId: value.operationId, status: value.status, providerStatus: null }); break;
    }
    case 'status': {
      const turn = state.turns.find((entry) => entry.id === change.turnId);
      demand(turn && ['running', 'cancelling', 'completed', 'failed', 'interrupted', 'uncertain'].includes(change.status));
      demand(!terminal(turn.status) || turn.status === change.status, 'TERMINAL_TURN_CHANGED');
      demand(change.status !== 'running' || turn.status === 'running', 'UNCERTAIN_TURN_RESTART');
      turn.status = change.status; break;
    }
    case 'provider-status': {
      const turn = state.turns.find((entry) => entry.id === change.turnId);
      demand(turn && ['completed', 'failed', 'interrupted'].includes(change.status));
      demand(!turn.providerStatus || turn.providerStatus === change.status, 'TERMINAL_TURN_CHANGED');
      turn.providerStatus = change.status;
      for (const operation of state.operations) if (operation.turnId === turn.id && operation.status === 'prepared') operation.status = 'cancelled';
      turn.status = state.operations.some((operation) => operation.turnId === turn.id && ['running', 'uncertain'].includes(operation.status)) ? 'uncertain' : change.status;
      break;
    }
    case 'message': {
      demand(state.turns.some((turn) => turn.id === change.turnId) && opaqueId(change.itemId) && typeof change.text === 'string' && change.text.length <= 1024 * 1024 && typeof change.confirmed === 'boolean');
      const item = state.transcript.find((entry) => entry.turnId === change.turnId && entry.itemId === change.itemId);
      if (item?.confirmed) { demand(!change.confirmed || item.text === change.text, 'CONFIRMED_ITEM_CHANGED'); break; }
      if (item) { item.text = change.confirmed ? change.text : item.text + change.text; item.confirmed = change.confirmed; demand(item.text.length <= 1024 * 1024); }
      else state.transcript.push({ turnId: change.turnId, itemId: change.itemId, text: change.text, confirmed: change.confirmed });
      break;
    }
    case 'operation': {
      const value = change.value;
      demand(object(value) && uuid(value.id) && uuid(value.turnId) && hashId(value.requestHash) && ['prepared', 'running', 'confirmed', 'uncertain', 'cancelled'].includes(value.status));
      demand(state.turns.some((turn) => turn.id === value.turnId));
      demand(!state.turns.some((turn) => turn.operationId === value.id), 'OPERATION_ID_REUSED');
      const existing = state.operations.find((entry) => entry.id === value.id);
      if (existing) {
        demand(existing.requestHash === value.requestHash && existing.turnId === value.turnId, 'OPERATION_ID_REUSED');
        if (existing.status === 'confirmed' && value.status === 'confirmed') {
          demand(validReceipt(value.receipt, state, value) && digest(existing.receipt) === digest(value.receipt), 'CONFIRMED_RECEIPT_CHANGED');
          break;
        }
        const transitions: Record<TurnOperation['status'], readonly TurnOperation['status'][]> = {
          prepared: ['running', 'cancelled', 'confirmed'], running: ['confirmed', 'uncertain'], uncertain: ['confirmed'], confirmed: [], cancelled: ['confirmed']
        };
        demand(transitions[existing.status].includes(value.status), 'OPERATION_REPLAY_BLOCKED');
      } else demand(value.status === 'prepared');
      if (value.status === 'confirmed') demand(validReceipt(value.receipt, state, value), 'INVALID_OPERATION_RECEIPT');
      else demand(value.receipt === undefined);
      const clean: TurnOperation = { id: value.id, turnId: value.turnId, requestHash: value.requestHash, status: value.status,
        ...(value.receipt ? { receipt: structuredClone(value.receipt) } : {}) };
      if (existing) state.operations[state.operations.indexOf(existing)] = clean; else state.operations.push(clean);
      const owner = state.turns.find((turn) => turn.id === value.turnId)!;
      if (owner.providerStatus && !state.operations.some((operation) => operation.turnId === owner.id && ['running', 'uncertain'].includes(operation.status))) owner.status = owner.providerStatus;
      break;
    }
    case 'diagnostic':
      demand(typeof change.code === 'string' && /^[A-Z_]{1,64}$/.test(change.code) && typeof change.uncertain === 'boolean');
      if (!state.diagnostics.includes(change.code)) state.diagnostics.push(change.code);
      if (change.uncertain) {
        for (const turn of state.turns) if (!terminal(turn.status)) turn.status = 'uncertain';
        for (const operation of state.operations) if (operation.status === 'running') operation.status = 'uncertain';
      }
      break;
    default: throw new TurnError('UNKNOWN_SESSION_EVENT');
  }
  return state;
}
