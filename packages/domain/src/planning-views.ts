import { isJson, isObject, sameId, UUID_PATTERN } from './data.js';
import { planningData, planningHistory, validatePlanningSnapshot, type PlanningData, type PlanningActivity, type PlanningReference, type TaskData } from './planning.js';
import type { DomainSnapshot, Project } from './models.js';

export const PLANNING_POLICY_KEY = 'a3.planning.policy';
export interface PlanningPolicy { requireEvidenceForDone: boolean; }
export function planningPolicy(project: Project): PlanningPolicy | undefined {
  const value = project.extensions[PLANNING_POLICY_KEY];
  return value === undefined ? { requireEvidenceForDone: false } : isObject(value) && typeof value.requireEvidenceForDone === 'boolean' ? { requireEvidenceForDone: value.requireEvidenceForDone } : undefined;
}
export interface PlanningItem { id: string; revision: number; title: string; data: PlanningData; history: PlanningActivity[]; workspaceIds: string[]; }
export interface PlanningProjection {
  items: PlanningItem[]; workspaces: { id: string; name: string }[];
  requirements: { id: string; title: string }[]; requirementsWithoutTask: { id: string; title: string }[]; criteriaWithoutEvidence: { id: string; title: string }[];
}
export function projectPlanning(snapshot: DomainSnapshot): PlanningProjection {
  const items = snapshot.records.flatMap((record) => {
    if (record.kind !== 'entity') return [];
    const data = planningData(record.value), history = planningHistory(record.value);
    return data && history ? [{ id: record.value.id, revision: record.value.revision, title: record.value.title, data, history,
      workspaceIds: [...new Set(snapshot.records.flatMap((r) => r.kind === 'placement' && sameId(r.value.entityId, record.value.id) ? [r.workspaceId] : []))] }] : [];
  });
  const tasks = items.filter((item) => item.data.kind === 'task');
  const diagnostics = validatePlanningSnapshot(snapshot);
  const validEvidence = new Set(items.filter((item) => item.data.kind === 'evidence' && !diagnostics.some((d) => d.ref?.id === item.id && d.severity === 'error')).map((item) => item.id.toLowerCase()));
  const requirements = snapshot.records.flatMap((r) => r.kind === 'entity' && (planningData(r.value)?.kind === 'story' || r.value.properties['a3.planning.requirement'] === true) ? [{ id: r.value.id, title: r.value.title }] : []);
  return { items, workspaces: snapshot.records.flatMap((r) => r.kind === 'workspace' ? [{ id: r.value.id, name: r.value.name }] : []), requirements,
    requirementsWithoutTask: requirements.filter((requirement) => !tasks.some((task) => task.data.kind === 'task' && (task.data.storyId && sameId(task.data.storyId, requirement.id) || task.data.references.some((r) => r.kind === 'entity' && sameId(r.id, requirement.id))))),
    criteriaWithoutEvidence: items.filter((item) => item.data.kind === 'criterion' && !tasks.some((task) => task.data.kind === 'task' && task.data.criterionIds.some((id) => sameId(id, item.id)) && task.data.evidenceIds.some((id) => {
      const evidence = items.find((e) => sameId(e.id, id)); return validEvidence.has(id.toLowerCase()) && evidence?.data.kind === 'evidence' && evidence.data.criterionIds.some((criterion) => sameId(criterion, item.id));
    }))).map(({ id, title }) => ({ id, title })) };
}
export interface PlanningFilter { search?: string; state?: string; priority?: string; workspaceId?: string; storyId?: string; groupBy?: 'none' | 'story' | 'workspace'; }
export function groupPlanningTasks(projection: PlanningProjection, filter: PlanningFilter): { id: string; label: string; tasks: PlanningItem[] }[] {
  const terms = (filter.search ?? '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const tasks = projection.items.filter((item) => item.data.kind === 'task' && (!filter.state || item.data.state === filter.state) && (!filter.priority || item.data.priority === filter.priority) &&
    (!filter.workspaceId || item.workspaceIds.some((id) => sameId(id, filter.workspaceId!))) && (!filter.storyId || item.data.storyId && sameId(item.data.storyId, filter.storyId)) &&
    terms.every((term) => (item.title + ' ' + item.id + ' ' + ((item.data as TaskData).assignee?.id ?? '')).toLocaleLowerCase().includes(term)));
  if (!filter.groupBy || filter.groupBy === 'none') return [{ id: 'all', label: 'Todas las tareas', tasks }];
  const groups = new Map<string, { id: string; label: string; tasks: PlanningItem[] }>();
  for (const task of tasks) {
    const data = task.data as TaskData;
    const ids = filter.groupBy === 'story' ? [data.storyId ?? 'none'] : task.workspaceIds.length ? task.workspaceIds : ['none'];
    for (const id of ids) {
      const label = id === 'none' ? filter.groupBy === 'story' ? 'Sin historia' : 'Sin workspace' : filter.groupBy === 'story' ? projection.items.find((item) => sameId(item.id, id))?.title ?? id : projection.workspaces.find((workspace) => sameId(workspace.id, id))?.name ?? id;
      const group = groups.get(id) ?? { id, label, tasks: [] }; group.tasks.push(task); groups.set(id, group);
    }
  }
  return [...groups.values()];
}

export interface TaskProposalItem { key: string; title: string; requirementIds: string[]; criterionIds: string[]; dependencyKeys: string[]; storyId?: string; }
export interface TaskProposal { schemaVersion: '1.0.0'; projectId: string; sourceRefs: PlanningReference[]; items: TaskProposalItem[]; }
export interface TaskProposalInspection { proposal: TaskProposal | null; issues: string[]; }
/** A proposed checklist is untrusted data, never coverage evidence or executable instructions. */
export function inspectTaskProposal(snapshot: DomainSnapshot, source: string): TaskProposalInspection {
  let value: unknown;
  try { if (source.length > 256 * 1024) throw new Error(); value = JSON.parse(source); } catch { return { proposal: null, issues: ['JSON inválido o propuesta mayor de 256 KiB.'] }; }
  const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 128 && v.every(uuid) && new Set(v.map((id) => id.toLowerCase())).size === v.length;
  const key = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v);
  if (!isJson(value) || !isObject(value) || Object.keys(value).some((k) => !['schemaVersion', 'projectId', 'sourceRefs', 'items'].includes(k)) || value.schemaVersion !== '1.0.0' || !uuid(value.projectId) || !Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > 128 ||
      !value.sourceRefs.every((r) => isObject(r) && Object.keys(r).length === 2 && ['entity', 'resource', 'relation', 'workspace'].includes(String(r.kind)) && uuid(r.id)) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 128 ||
      !value.items.every((item) => isObject(item) && Object.keys(item).every((k) => ['key', 'title', 'requirementIds', 'criterionIds', 'dependencyKeys', 'storyId'].includes(k)) && key(item.key) && typeof item.title === 'string' && item.title.trim() && item.title.length <= 200 && ids(item.requirementIds) && item.requirementIds.length > 0 && ids(item.criterionIds) &&
        (item.storyId === undefined || uuid(item.storyId)) && Array.isArray(item.dependencyKeys) && item.dependencyKeys.length <= 128 && item.dependencyKeys.every(key) && new Set(item.dependencyKeys).size === item.dependencyKeys.length)) return { proposal: null, issues: ['Formato de propuesta no admitido: requiere claves, títulos, requisitos, criterios, dependencias y referencias explícitas.'] };
  const proposal = value as unknown as TaskProposal, issues: string[] = [], projection = projectPlanning(snapshot);
  const project = snapshot.records.find((r) => r.kind === 'project');
  if (project?.kind !== 'project' || !sameId(project.value.projectId, proposal.projectId)) issues.push('La propuesta pertenece a otro proyecto.');
  const keys = new Set(proposal.items.map((item) => item.key));
  if (keys.size !== proposal.items.length) issues.push('Claves de tarea duplicadas.');
  for (const ref of proposal.sourceRefs) if (!snapshot.records.some((r) => r.kind === ref.kind && 'id' in r.value && typeof r.value.id === 'string' && sameId(r.value.id, ref.id))) issues.push('Fuente ausente: ' + ref.kind + ':' + ref.id);
  for (const item of proposal.items) {
    if (item.storyId && !projection.items.some((story) => sameId(story.id, item.storyId!) && story.data.kind === 'story')) issues.push(item.key + ': historia ausente.');
    if (item.requirementIds.some((id) => !projection.requirements.some((r) => sameId(r.id, id)) || !proposal.sourceRefs.some((r) => r.kind === 'entity' && sameId(r.id, id)))) issues.push(item.key + ': requisito ausente o sin referencia de fuente.');
    if (item.criterionIds.some((id) => !projection.items.some((c) => sameId(c.id, id) && c.data.kind === 'criterion' && (!item.storyId || sameId(c.data.storyId, item.storyId))))) issues.push(item.key + ': criterio incompatible.');
    if (item.dependencyKeys.some((dep) => !keys.has(dep))) issues.push(item.key + ': dependencia ausente.');
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (k: string): boolean => { if (visiting.has(k)) return true; if (visited.has(k)) return false; visiting.add(k); const cyclic = proposal.items.find((i) => i.key === k)?.dependencyKeys.some(visit) ?? false; visiting.delete(k); visited.add(k); return cyclic; };
    if (visit(item.key)) issues.push(item.key + ': ciclo de dependencias.');
  }
  return { proposal, issues: [...new Set(issues)] };
}
