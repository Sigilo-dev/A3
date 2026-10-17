export const CODEX_AUTH_CHANNEL = 'a3.codex:authorization';
export type CodexAuthRequest =
  | { action: 'state' | 'cancel' | 'disconnect' | 'refresh' | 'open-usage' }
  | { action: 'connect'; accountId?: string; enablePlan?: boolean }
  | { action: 'select'; accountId: string };

// Deliberately contains no provider tokens, callback values, claims or authorization URLs.
export interface CodexAuthState {
  status: 'disconnected' | 'authorizing' | 'identity-only' | 'connected' | 'expired' | 'not-eligible' | 'limit-exhausted' | 'unavailable';
  accounts: { id: string; label: string; signedIn: boolean }[];
  activeAccountId: string | null;
  diagnostic: string;
  planPermission: boolean;
  inferenceVerified: boolean;
  manualAvailable: true;
}
export type CodexAuthResult = { ok: true; value: CodexAuthState } | { ok: false; error: { code: string; message: string } };
