import type { JsonValue, PromptContextCategory, PromptContextCompilationResult } from '@a3/domain';
import type { VariablesQuery } from './variables.js';

export type PromptContextEntityRole = 'selection' | 'requirement' | 'acceptance-criterion';
export interface PromptContextEntitySelection { entityId: string; role: PromptContextEntityRole; }
export interface PromptContextSelection {
  entities: PromptContextEntitySelection[];
  resourceIds: string[];
  relationIds: string[];
  excludedSourceKeys: string[];
}
export interface PromptContextCatalog {
  sessionId: string;
  projectId: string;
  projectName: string;
  workspaces: { id: string; name: string }[];
  entities: { id: string; title: string; type: string; revision: number; contentResourceId?: string }[];
  resources: { id: string; label: string; originPath: string; revision: number; mediaType?: string; category: 'project-memory' | 'resource'; readableAsText: boolean; unavailableReason?: string }[];
  relations: { id: string; type: string; revision: number; sourceEntityId: string; targetEntityId: string }[];
  visualEdgeCount: number;
}
export interface PromptContextCompileInput {
  mode: 'template' | 'manual';
  source: string;
  inputs: Record<string, import('@a3/domain').JsonValue>;
  requiredNames: string[];
  query: VariablesQuery;
  selection: PromptContextSelection;
  maxBytes: number;
  split: boolean;
}
export interface PromptContextVariableTrace {
  name: string;
  scope: { kind: string; ownerId?: string };
  /** The effective typed value used by this local compilation. It is stored only in .a3/local. */
  resolvedValue: JsonValue;
  valueHash: string;
}
export interface PromptContextExecutionTrace {
  schemaVersion: '1.0.0';
  id: string;
  kind: 'prompt-context-compilation';
  projectId: string;
  createdAt: string;
  mode: 'template' | 'manual';
  templateId: string;
  templateHash: string;
  inputHash: string;
  promptHash: string;
  variableContext: { workspaceId?: string; entityId?: string; referenceScope?: VariablesQuery['referenceScope']; requiredNames: string[]; executionVariableNames: string[] };
  variables: PromptContextVariableTrace[];
  selection: PromptContextSelection;
  included: PromptContextCompilationResult['included'];
  omitted: PromptContextCompilationResult['omitted'];
  parts: { index: number; bytes: number; sha256: string; sourceKeys: string[] }[];
  provider: null;
  model: null;
}
export interface ProjectPromptContextResult extends PromptContextCompilationResult {
  executionId: string;
  tracePath: string;
  traceSaved: true;
}
export type { PromptContextCategory };
