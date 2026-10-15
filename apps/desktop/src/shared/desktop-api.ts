import type { LocalProjectsState } from '@a3/project-store';
export type { LocalProjectsState, LocalProjectSession } from '@a3/project-store';
// This bridge never carries effective grants, raw services or filesystem handles.
export const APP_INFO_CHANNEL = 'a3.shell:get-app-info';
export const PROJECTS_CHANNEL = 'a3.projects:command';
export type ProjectsRequest =
  | { action: 'list' | 'open' }
  | { action: 'create'; name: string }
  | { action: 'recent' | 'relocate'; id: string }
  | { action: 'confirm' | 'cancel'; token: string }
  | { action: 'close'; sessionId: string }
  | { action: 'rename' | 'draft-name'; sessionId: string; name: string };
export type ProjectsResult = { ok: true; value: LocalProjectsState } | { ok: false; error: { code: string; message: string; recovery: string } };

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
  projects(request: ProjectsRequest): Promise<ProjectsResult>;
}
