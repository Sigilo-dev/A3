export const MANUAL_CHAT_CHANNEL = 'a3.manual-chat:command';
export const MANUAL_CHAT_HOME = 'https://chatgpt.com/';
export const MANUAL_CHAT_PARTITION = 'persist:a3-manual-chatgpt-v1';
export interface ChatBounds { x: number; y: number; width: number; height: number; }
export type ManualChatAction =
  { action: 'show' | 'state' | 'hide' | 'new-tab' | 'logout' } |
  { action: 'layout'; bounds: ChatBounds } |
  { action: 'copy-text'; text: string } |
  { action: 'select' | 'close' | 'back' | 'forward' | 'reload' | 'external' | 'focus' | 'revoke'; tabId: string } |
  { action: 'navigate'; tabId: string; url: string }
;
export type ManualChatRequest = ManualChatAction & { sessionId: string | null };
export interface ManualChatTab {
  id: string; title: string; url: string; origin: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error: string;
  permissions: { audio: boolean; video: boolean };
}
export interface ManualChatState { sessionId: string | null; tabs: ManualChatTab[]; activeTabId: string | null; visible: boolean; notice: string; }
export type ManualChatResult = { ok: true; value: ManualChatState } | { ok: false; error: { code: string; message: string } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function validManualChatRequest(v: unknown): v is ManualChatRequest {
  if (!object(v) || !(v.sessionId === null || uuid(v.sessionId))) return false;
  const fields = v.action === 'layout' ? ['bounds'] : v.action === 'copy-text' ? ['text'] : v.action === 'navigate' ? ['tabId', 'url'] :
    ['select', 'close', 'back', 'forward', 'reload', 'external', 'focus', 'revoke'].includes(String(v.action)) ? ['tabId'] :
    ['show', 'state', 'hide', 'new-tab', 'logout'].includes(String(v.action)) ? [] : null;
  if (!fields || Object.keys(v).length !== fields.length + 2 || !Object.keys(v).every((key) => ['action', 'sessionId', ...fields].includes(key))) return false;
  if (fields.includes('tabId') && !uuid(v.tabId)) return false;
  if (v.action === 'navigate' && (typeof v.url !== 'string' || v.url.length > 8192)) return false;
  if (v.action === 'copy-text' && (typeof v.text !== 'string' || !v.text.length || v.text.length > 1024 * 1024)) return false;
  if (v.action === 'layout' && (!object(v.bounds) || Object.keys(v.bounds).length !== 4 || !['x', 'y', 'width', 'height'].every((key) => typeof v.bounds === 'object' && v.bounds !== null && Number.isFinite((v.bounds as Record<string, unknown>)[key]) && Number((v.bounds as Record<string, unknown>)[key]) >= 0 && Number((v.bounds as Record<string, unknown>)[key]) <= 32768))) return false;
  return true;
}
/** No file:, a3:, script:, credential URLs, local services or arbitrary OS protocols. */
export function manualChatURL(raw: string, socket = false): string | null {
  try {
    if (raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    const url = new URL(raw), host = url.hostname.toLowerCase();
    if (!(url.protocol === 'https:' || socket && url.protocol === 'wss:') || url.username || url.password || !host.includes('.') ||
        host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.') || host.startsWith('[') || /^\d+(?:\.\d+)*$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}
export function manualChatOrigin(raw: string): string | null { const url = manualChatURL(raw); return url ? new URL(url).origin : null; }
export function manualChatResourceAllowed(url: string, resourceType: string): boolean {
  if (manualChatURL(url, true)) return true;
  return !['mainFrame', 'subFrame'].includes(resourceType) && /^(?:data:|blob:https:\/\/)/.test(url);
}
