export const AV_PROFILES = [
  { id: 'mp4', label: 'MP4 · H.264 / AAC', mediaType: 'video/mp4', video: true },
  { id: 'mov', label: 'MOV · H.264 / AAC', mediaType: 'video/quicktime', video: true },
  { id: 'mkv', label: 'MKV · H.264 / FLAC', mediaType: 'video/x-matroska', video: true },
  { id: 'mp3', label: 'MP3 · libmp3lame', mediaType: 'audio/mpeg', video: false },
  { id: 'flac', label: 'FLAC · audio de 16 bits', mediaType: 'audio/flac', video: false }
] as const;
export type AvProfileId = typeof AV_PROFILES[number]['id'];
export interface AvSettings { profile: AvProfileId; width: number; height: number; crf: number; audioKbps: number; }
export interface AvStream {
  index: number; kind: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown'; codec: string;
  width?: number; height?: number; frameRate?: number; nominalFrameRate?: number; channels?: number; sampleRate?: number; pixelFormat?: string;
  bitsPerSample?: number; profile?: string; duration?: number;
}
export interface AvInspection { container: string; bytes: number; streams: AvStream[]; duration: number | null; warnings: string[]; supported: boolean; }
export interface AvEngineInfo { available: boolean; version?: string; license?: string; message: string; profiles: AvProfileId[]; }
export interface AvJobView {
  jobId: string; resourceId: string; sourceName: string;
  state: 'inspecting' | 'inspected' | 'queued' | 'converting' | 'verifying' | 'staged' | 'saving' | 'saved' | 'cancelled' | 'error' | 'conflict';
  progress: number | null; engine: AvEngineInfo; source?: AvInspection; message?: string;
  output?: AvInspection & { path: string; mediaType: string; losses: string[] }; outputResourceId?: string;
}
export type AvRequest = { action: 'engine-status' } | { action: 'configure-engine' } |
  { action: 'inspect'; sessionId: string; resourceId: string; jobId: string } |
  { action: 'convert'; sessionId: string; jobId: string; settings: AvSettings; destination: string } |
  { action: 'status' | 'save' | 'cancel'; sessionId: string; jobId: string };
export type AvResult = { ok: true; value: AvJobView | AvEngineInfo } | { ok: false; error: { code: string; message: string; recovery: string } };
export function validAvSettings(value: unknown): value is AvSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 5 && Object.keys(input).every((key) => ['profile', 'width', 'height', 'crf', 'audioKbps'].includes(key)) &&
    AV_PROFILES.some((profile) => profile.id === input.profile) && typeof input.width === 'number' && Number.isInteger(input.width) && input.width >= 2 && input.width <= 1920 && input.width % 2 === 0 &&
    typeof input.height === 'number' && Number.isInteger(input.height) && input.height >= 2 && input.height <= 1080 && input.height % 2 === 0 &&
    typeof input.crf === 'number' && Number.isInteger(input.crf) && input.crf >= 18 && input.crf <= 35 &&
    [96, 128, 192, 256, 320].includes(Number(input.audioKbps)) && typeof input.audioKbps === 'number';
}
export function validAvRequest(value: unknown): value is AvRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>, uuid = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (input.action === 'engine-status' || input.action === 'configure-engine') return Object.keys(input).length === 1;
  if (!uuid(input.sessionId) || !uuid(input.jobId)) return false;
  const keys = input.action === 'inspect' ? ['action', 'sessionId', 'jobId', 'resourceId'] : input.action === 'convert' ?
    ['action', 'sessionId', 'jobId', 'settings', 'destination'] : ['action', 'sessionId', 'jobId'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) return false;
  if (input.action === 'inspect') return uuid(input.resourceId);
  if (input.action === 'convert') return validAvSettings(input.settings) && typeof input.destination === 'string' &&
    /^assets\/converted\/[^\\/:<>"|?*\x00-\x1f]{1,200}\.(mp4|mov|mkv|mp3|flac)$/i.test(input.destination);
  return ['status', 'save', 'cancel'].includes(String(input.action));
}
