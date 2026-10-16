import type { ContentNodeKind } from './content-nodes.js';
import type { ConceptualNodeKind, ConceptualRelationKind } from './conceptual-diagrams.js';
import type { C4Change } from './c4.js';
import type { UmlChange } from './uml.js';
import type { ErChange } from './er.js';
export type UUID = string;
export type Namespace = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface OpenData { [key: string]: unknown; }
export type ExtensionMap = Record<Namespace, JsonValue>;
export interface Revisioned extends OpenData { schemaVersion: string; revision: number; extensions: ExtensionMap; }
export interface Document extends Revisioned { id: UUID; }
export interface Point extends OpenData { x: number; y: number; }
export interface Project extends OpenData {
  projectId: UUID; formatVersion: string; revision: number; name: string;
  defaultWorkspaceId: UUID; createdAt: string; locale: string; catalogRoot: string; extensions: ExtensionMap;
}
export interface Workspace extends Document {
  name: string; viewport: Point & { zoom: number }; properties: ExtensionMap;
}
export interface Port extends OpenData { id: string; label?: string; }
export interface Entity extends Document {
  type: Namespace; typeVersion: string; title: string; contentResourceId?: UUID;
  tags: string[]; properties: ExtensionMap; ports: Port[]; bindings: ExtensionMap;
}
export type ResourceLocation =
  | { kind: 'project-file'; path: string }
  | { kind: 'mounted-file'; path: string; mountId: UUID }
  | { kind: 'remote-url'; url: string };
export type Resource = Document & ResourceLocation & { mediaType?: string };
export interface Endpoint extends OpenData { entityId: UUID; portId?: string; }
export interface Relation extends Document {
  type: Namespace; typeVersion: string; source: Endpoint; target: Endpoint; properties: ExtensionMap;
}
export interface Placement extends Document {
  entityId: UUID; position: Point; size: OpenData & { width: number; height: number }; style: ExtensionMap;
}
export interface VisualEdge extends Document {
  sourcePlacementId: UUID; targetPlacementId: UUID; label: string; waypoints: Point[]; style: ExtensionMap;
}
export interface RelationView extends Document {
  relationId: UUID; sourcePlacementId: UUID; targetPlacementId: UUID; waypoints: Point[]; style: ExtensionMap;
}
export interface DrawingPoint extends Point { pressure?: number; }
export interface DrawingParameters extends OpenData {
  size: number; thinning: number; smoothing: number; streamline: number; simulatePressure: boolean;
}
/** Workspace annotation source. Rendered outlines are derived from these points and parameters. */
export interface Drawing extends Document {
  points: DrawingPoint[]; parameters: DrawingParameters; style: ExtensionMap;
}
export interface DrawingAssetStroke extends OpenData { sourceDrawingId: UUID; points: DrawingPoint[]; parameters: DrawingParameters; style: ExtensionMap; }
export interface DrawingAsset extends OpenData { schemaVersion: string; strokes: DrawingAssetStroke[]; }
export interface GroupMember extends OpenData { kind: 'placement' | 'group' | 'drawing'; id: UUID; }
export interface Group extends Document { name: string; members: GroupMember[]; collapsed?: boolean; }
export interface Collection extends Document { name: string; entityIds: UUID[]; }
export type ValueType = 'string' | 'number' | 'boolean' | 'json';
export interface Variable extends OpenData {
  name: Namespace; valueType: ValueType;
  source: ({ kind: 'literal'; value: JsonValue } | { kind: 'reference'; name: Namespace }) & OpenData;
}
export interface VariableScope extends OpenData { kind: 'project' | 'workspace' | 'entity'; ownerId: UUID; }
export interface VariableSet extends Revisioned { scope: VariableScope; variables: Variable[]; }
export type PortDirection = 'input' | 'output' | 'inout';
export interface FieldRule extends OpenData { name: Namespace; valueType: ValueType; required: boolean; }
// Immutable, versioned package definitions. They are not Entity documents.
export interface NodeType extends OpenData {
  name: Namespace; version: string; packageId: Namespace; fields: FieldRule[];
  ports: (OpenData & { id: string; direction: PortDirection })[];
  bindingFields: Namespace[]; extensions: ExtensionMap;
}
export interface EndpointRule extends OpenData {
  entityTypes: '*' | Namespace[]; requirePort: boolean; portDirections?: PortDirection[];
  cardinality: { min: number; max: number | null } & OpenData;
}
export interface RelationType extends OpenData {
  name: Namespace; version: string; direction: 'directed' | 'undirected'; allowSelf: boolean;
  source: EndpointRule; target: EndpointRule; extensions: ExtensionMap;
}
export interface TypeRegistry { nodeTypes: NodeType[]; relationTypes: RelationType[]; }

export interface GlobalDocuments {
  project: Project; workspace: Workspace; entity: Entity; resource: Resource;
  relation: Relation; collection: Collection; 'variable-set': VariableSet;
}
export interface ScopedDocuments {
  placement: Placement; 'visual-edge': VisualEdge; 'relation-view': RelationView; group: Group;
  // Only identity/revision are understood here; E2 owns drawing geometry.
  drawing: Drawing;
}
export type DocumentKinds = GlobalDocuments & ScopedDocuments;
export type RecordKind = keyof DocumentKinds;
export type ScopedKind = keyof ScopedDocuments;
export type DomainRecord = {
  [K in RecordKind]: { kind: K; value: DocumentKinds[K] } & (K extends ScopedKind ? { workspaceId: UUID } : {})
}[RecordKind];
export interface DomainSnapshot { records: DomainRecord[]; }
export interface DocumentRef {
  kind: RecordKind; id: string; workspaceId?: UUID; variableScope?: VariableScope['kind'];
}
export interface ExpectedRevision extends DocumentRef { revision: number | null; }
export interface Actor { kind: 'user' | 'agent' | 'extension' | 'importer'; id: string; }
export type ErrorCode = 'VALIDATION_FAILED' | 'REVISION_CONFLICT' | 'PERMISSION_DENIED' | 'RESOURCE_MISSING' |
  'PATH_UNAVAILABLE' | 'ENGINE_UNAVAILABLE' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'EXTERNAL_SERVICE_FAILED' | 'IO_FAILED' | 'CANCELLED';
export interface Diagnostic {
  instancePath?: string;
  code: ErrorCode; detail: string; severity: 'error' | 'warning'; message: string;
  recovery: string; ref?: DocumentRef; missingCapability?: string;
}
export type Outcome<T> = { ok: true; value: T; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

export interface ResourceCopy { sourceId: UUID; id: UUID; location: ResourceLocation; }
export interface DuplicateSelection {
  workspaceId: UUID; placementIds: UUID[]; drawingIds?: UUID[]; groupIds?: UUID[]; mode: 'content' | 'representation'; offset: Point;
  ids: { entities: Record<string, UUID>; placements: Record<string, UUID>; relations: Record<string, UUID>;
    visualEdges: Record<string, UUID>; relationViews: Record<string, UUID>; drawings?: Record<string, UUID>; groups?: Record<string, UUID> };
  resourceCopies: ResourceCopy[]; includeExternalRelations: boolean;
}
export type CreateContentNodeSource =
  | { kind: 'inline'; resourceId: UUID; path: string; mediaType: string; content: string }
  | { kind: 'url'; resourceId: UUID; url: string }
  | { kind: 'existing-resource'; resourceId: UUID }
  | { kind: 'binary'; resourceId: UUID; path: string; mediaType: string; bytesBase64: string }
  | { kind: 'mounted-file'; resourceId: UUID; mountId: UUID; path: string; mediaType: string };
export interface CreateContentNode {
  workspaceId: UUID; entityId: UUID; placementId: UUID; kind: ContentNodeKind; title: string;
  position: Point; properties: ExtensionMap; source: CreateContentNodeSource;
}
export interface CreateConceptualNode {
  workspaceId: UUID; entityId: UUID; placementId: UUID; kind: ConceptualNodeKind; title: string; position: Point;
}
export interface UpdateConceptualNode {
  workspaceId: UUID; entityId: UUID; title?: string; kind?: ConceptualNodeKind;
}
export interface CreateConceptualRelation {
  workspaceId: UUID; relationId: UUID; relationViewId: UUID; sourcePlacementId: UUID; targetPlacementId: UUID;
  label: string; kind?: ConceptualRelationKind;
}
export interface UpdateConceptualRelation {
  workspaceId: UUID; relationId: UUID; label?: string; kind?: ConceptualRelationKind | null;
}
export interface CreateIotComponent {
  workspaceId: UUID; entityId: UUID; placementId: UUID; catalogId: string; title: string; position: Point;
}
export type EntityPatch = Partial<Pick<Entity, 'title' | 'tags' | 'properties' | 'ports' | 'bindings'>>;
export type Payloads = {
  'a3.er.change': ErChange;
  'a3.uml.change': UmlChange;
  'a3.c4.change': C4Change;
  'a3.core.create-project': { project: Project; workspace: Workspace };
  'a3.core.create-document': { record: DomainRecord };
  'a3.core.create-content-node': CreateContentNode;
  'a3.conceptual.create-node': CreateConceptualNode;
  'a3.conceptual.update-node': UpdateConceptualNode;
  'a3.conceptual.create-relation': CreateConceptualRelation;
  'a3.conceptual.update-relation': UpdateConceptualRelation;
  'a3.conceptual.delete-relation': { workspaceId: UUID; relationId: UUID };
  'a3.iot.create-component': CreateIotComponent;
  'a3.core.rename': { ref: DocumentRef; name: string };
  'a3.core.set-workspace-viewport': { workspaceId: UUID; viewport: { x: number; y: number; zoom: number } };
  'a3.core.update-entity': EntityPatch;
  'a3.core.move-placement': { ref: DocumentRef; position: Point };
  'a3.core.move-placements': { workspaceId: UUID; placements: { id: UUID; position: Point }[] };
  'a3.core.update-placement-views': { workspaceId: UUID; placements: { id: UUID; position?: Point; style?: ExtensionMap }[] };
  'a3.core.update-placement-view': { ref: DocumentRef; position?: Point; size?: Pick<Placement['size'], 'width' | 'height'>; style?: ExtensionMap };
  'a3.core.update-visual-edge': { ref: DocumentRef; sourcePlacementId?: UUID; targetPlacementId?: UUID; label?: string; waypoints?: Point[]; style?: ExtensionMap };
  'a3.core.update-drawing': { ref: DocumentRef; points?: DrawingPoint[]; parameters?: Partial<DrawingParameters>; style?: ExtensionMap };
  'a3.core.convert-drawings-to-node': { workspaceId: UUID; drawingIds: UUID[]; entityId: UUID; resourceId: UUID; placementId: UUID; title: string };
  'a3.core.move-resource': { resourceId: UUID; location: ResourceLocation };
  'a3.core.move-group': { ref: DocumentRef; offset: Point };
  'a3.core.set-group-members': { ref: DocumentRef; members: GroupMember[] };
  'a3.core.set-group-collapsed': { ref: DocumentRef; collapsed: boolean };
  'a3.core.set-collection-members': { collectionId: UUID; entityIds: UUID[] };
  'a3.core.set-variables': { scope: VariableScope; variables: Variable[] };
  'a3.core.delete': { ref: DocumentRef; replacementDefaultWorkspaceId?: UUID };
  'a3.core.duplicate-selection': DuplicateSelection;
  'a3.core.apply-canvas-history': { workspaceId: UUID; direction: 'undo' | 'redo'; changes: RecordChange[]; contentEffects: ContentEffect[]; revisionFloors: Record<string, number> };
  'a3.core.register-node-type': { definition: NodeType };
  'a3.core.unregister-node-type': { name: Namespace; version: string };
};
export type CommandName = keyof Payloads;
export interface EnvelopeBase {
  operationId: UUID; projectId: UUID; actor: Actor; expectedRevisions: ExpectedRevision[];
  expectedContentHashes: { resourceId: UUID; hash: string }[];
  scope: { entityIds: UUID[] };
}
export type DomainCommand = { [K in CommandName]: EnvelopeBase & { command: K; payload: Payloads[K] } }[CommandName];
export type ContentEffect =
  | { kind: 'create'; resourceId: UUID; path: string; content: string }
  | { kind: 'create-binary'; resourceId: UUID; path: string; mediaType: string; bytesBase64: string }
  | { kind: 'copy'; sourceId: UUID; targetId: UUID; expectedHash: string }
  | { kind: 'remove'; resourceId: UUID; path: string; expectedHash: string }
  | { kind: 'move'; resourceId: UUID; before: ResourceLocation; after: ResourceLocation; expectedHash: string };
export interface RecordChange { ref: DocumentRef; before: DomainRecord | null; after: DomainRecord | null; }
export interface NodeTypeChange { before: NodeType | null; after: NodeType | null; }
export interface AuthorizationRequest {
  operationId?: UUID;
  actor: Actor; projectId: UUID; command: CommandName; entityIds: UUID[];
  refs: DocumentRef[]; contentEffects: ContentEffect[]; registryWrite: boolean;
  changes: RecordChange[]; nodeTypeChanges: NodeTypeChange[];
}
export interface AuthorizationDecision { allowed: boolean; missingCapability?: string; reason?: string; }
export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): boolean;
  /** Optional structured host decision; pure-domain tests may keep using the boolean port. */
  authorizeDetailed?(request: AuthorizationRequest): AuthorizationDecision;
}
export interface CommandContext {
  authenticatedActor: Actor; authorization: AuthorizationPort; registry: TypeRegistry;
  // Observations already collected by the host; no file reads in the kernel.
  contentHashes: Readonly<Record<string, string>>;
}
export interface PreparedPlan {
  status: 'prepared'; operationId: UUID; projectId: UUID; request: DomainCommand;
  requestFingerprint: string; baseFingerprint: string;
  readSet: ExpectedRevision[]; changes: RecordChange[]; nodeTypeChanges: NodeTypeChange[]; contentEffects: ContentEffect[];
  nextSnapshot: DomainSnapshot; nextRegistry: TypeRegistry;
}
/** One committed canvas command's domain changes, ready for the single E2-B3 history to consume. */
export interface ReversibleCanvasCommand {
  operationId: UUID; projectId: UUID; workspaceId: UUID; command: CommandName;
  changes: readonly RecordChange[]; contentEffects: readonly ContentEffect[];
}
// The E1-C/D writer must revalidate under its lock and confirm the ledger atomically.
export interface ProjectCommitPort {
  commit(plan: PreparedPlan): Promise<Outcome<{ status: 'committed'; operationId: UUID }>>;
}
