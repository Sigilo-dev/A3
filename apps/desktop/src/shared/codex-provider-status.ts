export type ProviderCondition = 'not-eligible' | 'limit-exhausted' | 'unavailable';
export type ProviderOutcome = ProviderCondition | 'completed' | 'credential-rejected';
export type ProviderDiagnostic =
  | 'INVALID_PROVIDER_RESULT'
  | 'INFERENCE_CONFIRMED'
  | 'INFERENCE_INTERRUPTED'
  | 'PLAN_NOT_ELIGIBLE'
  | 'USAGE_LIMIT_EXHAUSTED'
  | 'PROVIDER_TEMPORARILY_UNAVAILABLE'
  | 'AUTH_REJECTED_REFRESHING'
  | 'PROVIDER_PERMISSION_REJECTED'
  | 'PROVIDER_ACCESS_DENIED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REQUEST_FAILED';
export type ReportableProviderResult = { outcome: ProviderOutcome; diagnostic: ProviderDiagnostic };
export type ProviderSignal =
  | { kind: 'completed' }
  | { kind: 'interrupted' }
  | { kind: 'http-error'; status: number; body?: unknown };

export interface ClassifiedProviderSignal {
  outcome: ProviderOutcome | 'request-failed';
  diagnostic: ProviderDiagnostic;
}

function codeFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const root = body as Record<string, unknown>;
  const error = root.error;
  const code = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>).code
    : error;
  return typeof code === 'string' && /^[a-z0-9_]{1,96}$/.test(code) ? code : undefined;
}

/** Maps provider response shapes to fixed local states without retaining provider text or secrets. */
export function classifyProviderSignal(signal: ProviderSignal): ClassifiedProviderSignal {
  if (!signal || typeof signal !== 'object') return { outcome: 'request-failed', diagnostic: 'INVALID_PROVIDER_RESULT' };
  if (signal.kind === 'completed') return { outcome: 'completed', diagnostic: 'INFERENCE_CONFIRMED' };
  if (signal.kind === 'interrupted') return { outcome: 'unavailable', diagnostic: 'INFERENCE_INTERRUPTED' };
  if (signal.kind !== 'http-error' || !Number.isInteger(signal.status) || signal.status < 100 || signal.status > 599) {
    return { outcome: 'request-failed', diagnostic: 'INVALID_PROVIDER_RESULT' };
  }
  const code = codeFrom(signal.body);
  if (code === 'subscription_sharing_user_not_eligible') return { outcome: 'not-eligible', diagnostic: 'PLAN_NOT_ELIGIBLE' };
  if (code === 'subscription_sharing_usage_limit_exceeded') return { outcome: 'limit-exhausted', diagnostic: 'USAGE_LIMIT_EXHAUSTED' };
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') {
    return { outcome: 'unavailable', diagnostic: 'PROVIDER_TEMPORARILY_UNAVAILABLE' };
  }
  if (code === 'subscription_sharing_invalid_user' || signal.status === 401) {
    return { outcome: 'credential-rejected', diagnostic: 'AUTH_REJECTED_REFRESHING' };
  }
  if (code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') {
    return { outcome: 'unavailable', diagnostic: 'PROVIDER_PERMISSION_REJECTED' };
  }
  if (code === 'subscription_sharing_route_not_supported' || signal.status === 403) {
    return { outcome: 'unavailable', diagnostic: 'PROVIDER_ACCESS_DENIED' };
  }
  if (signal.status === 429) return { outcome: 'unavailable', diagnostic: 'PROVIDER_RATE_LIMITED' };
  if (signal.status === 503 || signal.status >= 500) return { outcome: 'unavailable', diagnostic: 'PROVIDER_TEMPORARILY_UNAVAILABLE' };
  return { outcome: 'request-failed', diagnostic: 'PROVIDER_REQUEST_FAILED' };
}

/** Adapter boundary used by the Codex host integration; renderer and projects cannot report outcomes. */
export class CodexProviderStatusAdapter {
  constructor(private readonly report: (result: ReportableProviderResult) => Promise<void>) {}
  async accept(signal: ProviderSignal): Promise<ClassifiedProviderSignal> {
    const result = classifyProviderSignal(signal);
    if (result.outcome !== 'request-failed') await this.report(result as ReportableProviderResult);
    return result;
  }
}
