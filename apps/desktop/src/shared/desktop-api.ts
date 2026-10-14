// This bridge is a shell query, not an E0 domain command or a grant of capabilities.
export const APP_INFO_CHANNEL = 'a3.shell:get-app-info';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chromium: string;
  node: string;
}

export type ShellResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'PERMISSION_DENIED' | 'IO_FAILED'; message: string; recovery: string } };

export interface DesktopAPI {
  getAppInfo(): Promise<ShellResult<AppInfo>>;
}
