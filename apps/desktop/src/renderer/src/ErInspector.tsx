import { useMemo, useState } from 'react';
import { ER_CARDINALITIES, exportMermaidEr, type ErCardinality, type ErField, type ErOperation, type ErRelationData } from '@a3/domain/er';
import type { CanvasErElement, CanvasErRelationView, LocalCanvasWorkspace } from '../../shared/desktop-api';

const text = (form: FormData, key: string) => String(form.get(key) ?? '');
const same = (a: string, b: string | undefined) => a.toLowerCase() === b?.toLowerCase();
function fieldValue(form: FormData, id: string): ErField {
  const foreign = text(form, 'foreignKey'), split = foreign.indexOf('~');
  const primaryKey = form.has('primaryKey');
  return { id, name: text(form, 'name'), type: text(form, 'type'), nullable: primaryKey ? false : form.has('nullable'), primaryKey,
    unique: form.has('unique'), ...(split > 0 ? { foreignKey: { tableId: foreign.slice(0, split), fieldId: foreign.slice(split + 1) } } : {}) };
}
function cardinalityName(value: ErCardinality): string { return ({ one: 'Uno obligatorio', 'zero-or-one': 'Cero o uno', many: 'Uno o varios', 'zero-or-many': 'Cero o varios' })[value]; }
function RelationFields({ data, disabled }: { data?: ErRelationData; disabled: boolean }): React.JSX.Element {
  return <>
    <label>Etiqueta <input name="label" defaultValue={data?.label ?? ''} maxLength={200} disabled={disabled} /></label>
    {(['sourceCardinality', 'targetCardinality'] as const).map((key) => <label key={key}>{key === 'sourceCardinality' ? 'Cardinalidad en origen' : 'Cardinalidad en destino'}
      <select name={key} defaultValue={data?.[key] ?? 'one'} disabled={disabled}>{ER_CARDINALITIES.map((v) => <option key={v} value={v}>{cardinalityName(v)}</option>)}</select></label>)}
    <label><input name="identifying" type="checkbox" defaultChecked={data?.identifying ?? false} disabled={disabled} />Relación identificadora</label>
  </>;
}
function relationValue(form: FormData): ErRelationData { return { label: text(form, 'label'), sourceCardinality: text(form, 'sourceCardinality') as ErCardinality,
  targetCardinality: text(form, 'targetCardinality') as ErCardinality, identifying: form.has('identifying') }; }
function FieldForm({ field, elements, disabled, onSave, onRemove }: { field?: ErField; elements: CanvasErElement[]; disabled: boolean; onSave: (next: ErField) => void; onRemove?: () => void }): React.JSX.Element {
  const targetFields = elements.flatMap((table) => table.data.fields.filter((item) => item.primaryKey || item.unique).map((item) => ({ value: `${table.id}~${item.id}`, label: `${table.title}.${item.name}` })));
  const selected = field?.foreignKey ? `${field.foreignKey.tableId}~${field.foreignKey.fieldId}` : '';
  return <form data-er-field={field?.id ?? 'new'} onSubmit={(event) => { event.preventDefault(); onSave(fieldValue(new FormData(event.currentTarget), field?.id ?? crypto.randomUUID())); }}>
    <label>Nombre del campo <input name="name" required maxLength={200} defaultValue={field?.name ?? ''} disabled={disabled} /></label>
    <label>Tipo textual <input name="type" required maxLength={200} defaultValue={field?.type ?? 'TEXT'} disabled={disabled} /></label>
    <label><input name="nullable" type="checkbox" defaultChecked={field?.nullable ?? true} disabled={disabled} />Nullable</label>
    <label><input name="primaryKey" type="checkbox" defaultChecked={field?.primaryKey ?? false} disabled={disabled} />Clave primaria (PK)</label>
    <label><input name="unique" type="checkbox" defaultChecked={field?.unique ?? false} disabled={disabled} />Único (UNIQUE)</label>
    <label>Referencia de clave foránea <select name="foreignKey" defaultValue={selected} disabled={disabled}><option value="">Sin clave foránea</option>{targetFields.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
    <button disabled={disabled}>Guardar campo</button>{onRemove && <button type="button" disabled={disabled} onClick={onRemove}>Quitar campo</button>}
  </form>;
}

export function ErInspector({ workspace, selectedEntityId, onOperation }: { workspace: LocalCanvasWorkspace; selectedEntityId?: string; onOperation: (operation: ErOperation) => void }): React.JSX.Element {
  const er = workspace.er, disabled = !workspace.canWrite;
  const selected = er.elements.find((e) => same(e.id, selectedEntityId) && workspace.placements.some((p) => same(p.entityId, e.id)));
  const local = workspace.placements.flatMap((p) => { const e = er.elements.find((item) => same(item.id, p.entityId)); return e ? [{ p, e }] : []; });
  const [exportNotice, setExportNotice] = useState('');
  const exported = useMemo(() => exportMermaidEr({ elements: er.elements, relationships: er.relationships }), [er.elements, er.relationships]);
  const endpoint = (name: 'source' | 'target') => <label>{name === 'source' ? 'Origen' : 'Destino'} <select name={name} required disabled={disabled}><option value="">Elegir tabla</option>{local.map(({ p, e }) => <option key={p.id} value={p.id}>{e.title} · {p.id.slice(-6)}</option>)}</select></label>;
  return <details className="er-inspector" data-er-inspector><summary>Entidad–relación · Tablas y campos</summary>
    <p>Las referencias FK guardan IDs de tabla y campo. Renombrar sus títulos no las rompe. Las relaciones y cardinalidades se editan por separado.</p>
    <form data-er-create-table onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onOperation({ action: 'create-table', title: text(form, 'title'), data: { description: '' }, position: { x: 0, y: 0 } }); }}>
      <label>Nombre de tabla <input name="title" defaultValue="NuevaTabla" required maxLength={200} disabled={disabled} /></label><button disabled={disabled}>Crear tabla ER</button>
    </form>
    <form data-er-reuse-table onSubmit={(event) => { event.preventDefault(); onOperation({ action: 'show-table', entityId: text(new FormData(event.currentTarget), 'entityId'), position: { x: 0, y: 0 } }); }}>
      <label>Tabla existente <select name="entityId" required disabled={disabled}><option value="">Elegir</option>{er.elements.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label><button disabled={disabled}>Representar tabla en este workspace</button>
    </form>
    {selected && <section data-er-table-editor key={`${selected.id}:${selected.revision}`}>
      <h4>{selected.title} · Tabla ER</h4><small>ID estable: {selected.id}</small>
      <form data-er-table-properties onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onOperation({ action: 'update-table', entityId: selected.id,
        expectedRevision: selected.revision, title: text(form, 'title'), data: { description: text(form, 'description') } }); }}>
        <label>Nombre <input name="title" required maxLength={200} defaultValue={selected.title} disabled={disabled} /></label>
        <label>Descripción <textarea name="description" defaultValue={selected.data.description} disabled={disabled} /></label><button disabled={disabled}>Guardar tabla</button>
      </form>
      <h4>Campos</h4>{selected.data.fields.map((field) => <FieldForm key={field.id} field={field} elements={er.elements} disabled={disabled} onSave={(next) => onOperation({ action: 'update-table', entityId: selected.id,
        expectedRevision: selected.revision, title: selected.title, data: { fields: selected.data.fields.map((f) => same(f.id, field.id) ? next : f) } })}
        onRemove={() => onOperation({ action: 'update-table', entityId: selected.id, expectedRevision: selected.revision, title: selected.title, data: { fields: selected.data.fields.filter((f) => !same(f.id, field.id)) } })} />)}
      <FieldForm elements={er.elements} disabled={disabled} onSave={(field) => onOperation({ action: 'update-table', entityId: selected.id, expectedRevision: selected.revision, title: selected.title, data: { fields: [...selected.data.fields, field] } })} />
    </section>}
    <form data-er-create-relationship onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onOperation({ action: 'create-relationship',
      sourcePlacementId: text(form, 'source'), targetPlacementId: text(form, 'target'), data: relationValue(form) }); }}>
      <h4>Relación ER</h4>{endpoint('source')}{endpoint('target')}<RelationFields disabled={disabled} /><button disabled={disabled}>Crear relación ER</button>
    </form>
    <form data-er-reuse-relationship onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onOperation({ action: 'show-relationship', relationId: text(form, 'relationId'), sourcePlacementId: text(form, 'source'), targetPlacementId: text(form, 'target') }); }}>
      <label>Relación del proyecto <select name="relationId" required disabled={disabled}><option value="">Elegir</option>{er.relationships.map((r) => <option key={r.id} value={r.id}>{er.elements.find((e) => same(e.id, r.sourceEntityId))?.title} → {er.elements.find((e) => same(e.id, r.targetEntityId))?.title} · {r.data.label}</option>)}</select></label>
      {endpoint('source')}{endpoint('target')}<button disabled={disabled}>Representar relación existente</button>
    </form>
    {er.relationViews.map((r: CanvasErRelationView) => <form key={`${r.id}:${r.relationRevision}`} data-er-relationship={r.relationId} onSubmit={(event) => { event.preventDefault(); onOperation({ action: 'update-relationship',
      relationId: r.relationId, expectedRevision: r.relationRevision, data: relationValue(new FormData(event.currentTarget)) }); }}>
      <h4>{er.elements.find((e) => same(e.id, r.sourceEntityId))?.title} → {er.elements.find((e) => same(e.id, r.targetEntityId))?.title}</h4><RelationFields data={r.data} disabled={disabled} /><button disabled={disabled}>Guardar cardinalidad</button>
    </form>)}
    <section data-er-export aria-label="Exportar modelo Mermaid ER"><h4>Exportar Mermaid ER</h4>
      {exported.ok ? <><textarea aria-label="Código Mermaid ER" readOnly value={exported.content} rows={8} /><button type="button" onClick={() => { void navigator.clipboard.writeText(exported.content).then(() => setExportNotice('Código Mermaid ER copiado.')).catch(() => setExportNotice('No se pudo copiar; selecciona el código para copiarlo manualmente.')); }}>Copiar código</button></>
        : <ul role="status">{exported.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      {exportNotice && <small role="status">{exportNotice}</small>}
    </section>
    {disabled && <p role="note">Solo lectura: el broker no concede edición de diagramas a este proyecto.</p>}
  </details>;
}
