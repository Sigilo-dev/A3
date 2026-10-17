import type { Capability, GrantMode, Profile, ProjectCapabilityState } from '@a3/project-store';

export const AGENT_PROFILES_CHANNEL = 'a3.agent:profiles';
export type AgentProfilesRequest =
  | { action: 'load'; sessionId: string }
  | { action: 'set-profile'; sessionId: string; profile: Profile }
  | { action: 'set-capability'; sessionId: string; capability: Capability; mode: GrantMode };
export type AgentProfilesResult =
  | { ok: true; value: { state: ProjectCapabilityState; updated?: boolean } }
  | { ok: false; error: { code: string; message: string; recovery: string } };

export const AGENT_CAPABILITIES: readonly Capability[] = [
  'project.read', 'mount.read', 'mount.index', 'mount.write', 'document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'process.run',
  'network.access', 'package.install', 'apps.connect', 'media.convert', 'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'git.branch', 'git.restore', 'export'
];
export const AGENT_CAPABILITY_GROUPS = [
  { id: 'read', label: 'Lectura', capabilities: ['project.read', 'mount.read', 'mount.index'] },
  { id: 'write', label: 'Escritura', capabilities: ['document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'mount.write'] },
  { id: 'shell', label: 'Procesos y shell', capabilities: ['process.run'] },
  { id: 'network', label: 'Red', capabilities: ['network.access'] },
  { id: 'git', label: 'Git', capabilities: ['git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'git.branch', 'git.restore'] },
  { id: 'apps', label: 'Aplicaciones', capabilities: ['apps.connect', 'package.install', 'media.convert', 'export'] }
] as const satisfies readonly { id: string; label: string; capabilities: readonly Capability[] }[];

export function validAgentProfilesRequest(value: unknown): value is AgentProfilesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['action', 'sessionId', 'profile', 'capability', 'mode'].includes(key)) ||
      typeof input.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId)) return false;
  if (input.action === 'load') return Object.keys(input).length === 2;
  if (input.action === 'set-profile') return Object.keys(input).length === 3 && ['consultar', 'proponer', 'trabajar', 'personalizado'].includes(String(input.profile));
  return input.action === 'set-capability' && Object.keys(input).length === 4 &&
    typeof input.capability === 'string' && AGENT_CAPABILITIES.includes(input.capability as Capability) && ['deny', 'propose', 'approval', 'direct'].includes(String(input.mode));
}
