import type { EvidenceTarget, PlanningProjection, PlanningPolicy, TaskProposal, TaskState } from '@a3/domain';
import type { ChecklistInspection, PlanningTraceability } from '@a3/domain';
export interface ProjectPlanningState extends PlanningProjection {
  sessionId: string; projectId: string; projectRevision: number; policy: PlanningPolicy | null;
  canEdit: boolean; canSetPolicy: boolean; canPlace: boolean; readOnlyReason: string; diagnostics: string[];
  resources: { id: string; label: string }[]; entities: { id: string; title: string }[];
  traceability: PlanningTraceability; canExport: boolean;
}
export interface PlanningTaskUpdate { entityId: string; expectedRevision: number; state: TaskState; evidenceIds: string[]; }
export interface PlanningEvidenceInput { taskId: string; expectedRevision: number; title: string; target: EvidenceTarget; criterionIds: string[]; }
export interface PlanningProposalPreview { token: string | null; sourceHash: string; proposal: TaskProposal | null; issues: string[]; coverageClaim: false; }
export interface ChecklistExport { markdown: string; sourceHash: string; taskIds: string[]; }
export interface ChecklistImportPreview extends ChecklistInspection { token: string | null; sourceHash: string; }
