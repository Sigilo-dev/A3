import { useState } from 'react';
import { C4_CATALOG, C4_VIEW_KINDS, type C4Category, type C4ElementData, type C4ElementPatch, type C4Operation, type C4Step, type C4ViewKind } from '@a3/domain/c4';
import type { CanvasC4Element, LocalCanvasWorkspace } from '../../shared/desktop-api';

const label = (category: C4Category): string => C4_CATALOG.find((item) => item.category === category)!.label;
function fields(form: HTMLFormElement): C4ElementPatch {
  const data = new FormData(form), value = (name: string) => String(data.get(name) ?? '');
  return { description: value('description'), technology: value('technology'), url: value('url'), external: data.has('external'),
    parentId: value('parentId') || null, instanceOfId: value('instanceOfId') || null, environment: value('environment') || null };
}
function ElementFields({ category, elements, data, disabled, id }: { category: C4Category; elements: CanvasC4Element[]; data?: C4ElementData; disabled: boolean; id?: string }): React.JSX.Element {
  const parents = elements.filter((e) => e.id !== id && (category === 'instance' || category === 'deployment-node' ? e.category === 'deployment-node' :
    category === 'container' ? ['software-system', 'boundary'].includes(e.category) : category === 'component' ? ['container', 'boundary'].includes(e.category) :
    category === 'boundary' ? ['software-system', 'container', 'boundary'].includes(e.category) : e.category === 'boundary'));
  return <>
    <label>Descripción Markdown <textarea name="description" defaultValue={data?.description ?? ''} maxLength={20000} disabled={disabled} /></label>
    <label>Tecnología <input name="technology" defaultValue={data?.technology ?? ''} disabled={disabled} /></label>
    <label>URL <input name="url" type="url" defaultValue={data?.url ?? ''} disabled={disabled} /></label>
    <label>Padre semántico <select name="parentId" defaultValue={data?.parentId ?? ''} disabled={disabled} required={['container', 'component', 'instance'].includes(category)}>
      <option value="">Sin padre</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.title} · {label(p.category)}</option>)}
    </select></label>
    {category === 'software-system' && <label><input type="checkbox" name="external" defaultChecked={data?.external ?? false} disabled={disabled} />Sistema externo</label>}
    {category === 'deployment-node' && <label>Entorno <input name="environment" defaultValue={data?.environment ?? 'production'} required disabled={disabled} /></label>}
    {category === 'instance' && <label>Instancia de <select name="instanceOfId" defaultValue={data?.instanceOfId ?? ''} required disabled={disabled}>
      <option value="">Elegir sistema o contenedor</option>{elements.filter((e) => ['software-system', 'container'].includes(e.category)).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
    </select></label>}
  </>;
}

export function C4Inspector({ workspace, selectedEntityId, onOperation, onOpenWorkspace }: {
  workspace: LocalCanvasWorkspace; selectedEntityId?: string; onOperation: (operation: C4Operation) => void; onOpenWorkspace?: (id: string) => void;
}): React.JSX.Element {
  const c4 = workspace.c4, current = c4.current;
  const [typeKey, setTypeKey] = useState('a3.c4.person@1.0.0'), [viewKind, setViewKind] = useState<C4ViewKind>(current?.data.kind ?? 'context');
  const selectedType = c4.types.find((t) => `${t.name}@${t.version}` === typeKey) ?? c4.types[0]!;
  const selected = c4.elements.find((e) => e.id === selectedEntityId);
  const disabled = !workspace.canWrite;
  const local = workspace.placements.flatMap((p) => { const e = c4.elements.find((item) => item.id === p.entityId); return e && e.category !== 'boundary' ? [{ placement: p, entity: e }] : []; });
  const scopeOptions = c4.elements.filter((e) => e.category === (viewKind === 'components' ? 'container' : 'software-system') || viewKind === 'dynamic' && e.category === 'container');
  const endpoints = (name: string, selectedId?: string) => <label>{name === 'source' ? 'Origen' : 'Destino'} <select name={name} defaultValue={selectedId ?? ''} required disabled={disabled}>
    <option value="">Elegir representación</option>{local.map(({ placement, entity }) => <option key={placement.id} value={placement.id}>{entity.title} · {placement.id.slice(-6)}</option>)}
  </select></label>;
  const saveSteps = (steps: C4Step[]): void => { if (current) onOperation({ action: 'set-steps', diagramId: current.id, expectedRevision: current.revision, steps }); };
  const reorder = (index: number, offset: number): void => {
    if (!current) return; const steps = [...current.data.steps].sort((a, b) => a.order - b.order);
    const other = index + offset; if (other < 0 || other >= steps.length) return;
    [steps[index], steps[other]] = [steps[other]!, steps[index]!]; saveSteps(steps.map((step, i) => ({ ...step, order: i + 1 })));
  };
  return <details className="conceptual-inspector c4-inspector" data-c4-inspector>
    <summary>C4 · {current ? `${current.title} (${current.data.kind})` : 'Modelo y vistas reutilizables'}</summary>
    <p>La jerarquía pertenece al modelo. Agrupar o mover cajas en el lienzo no cambia su padre semántico.</p>
    <nav aria-label="Vistas C4 del proyecto">{c4.views.map((view) => <button key={view.id} type="button" onClick={() => onOpenWorkspace?.(view.workspaceId)}>{view.title} · {view.kind}</button>)}</nav>
    <details><summary>Jerarquía semántica del proyecto</summary><ul>{c4.elements.map((element) => <li key={element.id}>
      {element.title} · {label(element.category)}
      {element.data.parentId && ` · padre: ${c4.elements.find((e) => e.id === element.data.parentId)?.title ?? element.data.parentId}`}
      {element.data.instanceOfId && ` · instancia de: ${c4.elements.find((e) => e.id === element.data.instanceOfId)?.title ?? element.data.instanceOfId}`}
    </li>)}</ul></details>
    <form data-c4-view-form key={`view-${current?.id}:${current?.revision}`} onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget), scopeEntityId = String(data.get('scope') ?? ''), environment = String(data.get('environment') ?? '');
      const newWorkspace = data.has('newWorkspace');
      onOperation({ action: 'configure-view', title: String(data.get('title')), kind: viewKind, newWorkspace,
        ...(scopeEntityId ? { scopeEntityId } : {}), ...(environment ? { environment } : {}), ...(!newWorkspace && current ? { expectedDiagramRevision: current.revision } : {}) });
    }}>
      <h4>Documento de vista</h4>
      <label>Nombre <input name="title" defaultValue={current?.title ?? 'Contexto'} required maxLength={200} disabled={disabled} /></label>
      <label>Vista <select name="kind" value={viewKind} onChange={(e) => setViewKind(e.target.value as C4ViewKind)} disabled={disabled}>{C4_VIEW_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      <label>Ámbito <select name="scope" defaultValue={current?.data.scopeEntityId ?? ''} required={['context', 'containers', 'components'].includes(viewKind)} disabled={disabled}>
        <option value="">Proyecto completo</option>{scopeOptions.map((e) => <option key={e.id} value={e.id}>{e.title} · {label(e.category)}</option>)}
      </select></label>
      {viewKind === 'deployment' && <label>Entorno <input name="environment" required defaultValue={current?.data.environment ?? 'production'} disabled={disabled} /></label>}
      <label><input type="checkbox" name="newWorkspace" defaultChecked disabled={disabled} />Crear workspace nuevo</label>
      <button disabled={disabled}>Guardar vista C4</button>
    </form>
    <form data-c4-create-element key={typeKey} onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget;
      onOperation({ action: 'create-element', typeName: selectedType.name, typeVersion: selectedType.version, title: String(new FormData(form).get('title')), data: fields(form), position: { x: 0, y: 0 } });
    }}>
      <h4>Elemento nuevo</h4>
      <label>Tipo C4 <select name="type" value={typeKey} onChange={(event) => setTypeKey(event.target.value)} disabled={disabled}>{c4.types.map((type) => <option key={`${type.name}@${type.version}`} value={`${type.name}@${type.version}`}>{type.label} · {type.category}</option>)}</select></label>
      <label>Nombre <input name="title" required maxLength={200} defaultValue={`Nueva ${selectedType.label}`} disabled={disabled} /></label>
      <ElementFields category={selectedType.category} elements={c4.elements} disabled={disabled} />
      <button disabled={disabled}>Crear elemento C4</button>
    </form>
    <form data-c4-reuse-element onSubmit={(event) => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get('entityId')); if (id) onOperation({ action: 'show-element', entityId: id, position: { x: 0, y: 0 } }); }}>
      <h4>Reutilizar elemento</h4><label>Elemento existente <select name="entityId" required disabled={disabled}><option value="">Elegir</option>{c4.elements.map((e) => <option key={e.id} value={e.id}>{e.title} · {label(e.category)}</option>)}</select></label>
      <button disabled={disabled}>Crear representación con el mismo ID</button>
    </form>
    {selected && <form data-c4-element-form key={`${selected.id}:${selected.revision}`} onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
      onOperation({ action: 'update-element', entityId: selected.id, expectedRevision: selected.revision, title: String(values.get('title')), tags: String(values.get('tags')).split(',').map((t) => t.trim()).filter(Boolean), data: fields(form) });
    }}>
      <h4>{label(selected.category)} · {selected.title}</h4>
      <small>ID compartido: {selected.id}</small>
      <label>Nombre <input name="title" required maxLength={200} defaultValue={selected.title} disabled={disabled} /></label>
      <label>Etiquetas (coma) <input name="tags" defaultValue={selected.tags.join(', ')} disabled={disabled} /></label>
      <ElementFields category={selected.category} elements={c4.elements} data={selected.data} id={selected.id} disabled={disabled} />
      <button disabled={disabled}>Guardar propiedades C4</button>
    </form>}
    <form data-c4-create-relationship key={`relationship-${selectedEntityId ?? ''}`} onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      onOperation({ action: 'create-relationship', sourcePlacementId: String(values.get('source')), targetPlacementId: String(values.get('target')), description: String(values.get('description')), protocol: String(values.get('protocol')) });
    }}>
      <h4>Relación semántica nueva</h4>{endpoints('source', local.find((p) => p.entity.id === selectedEntityId)?.placement.id)}{endpoints('target')}
      <label>Descripción <input name="description" required disabled={disabled} /></label><label>Protocolo <input name="protocol" disabled={disabled} /></label>
      <button disabled={disabled}>Crear relación C4</button>
    </form>
    <form data-c4-reuse-relationship onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      onOperation({ action: 'show-relationship', relationId: String(values.get('relationId')), sourcePlacementId: String(values.get('source')), targetPlacementId: String(values.get('target')) });
    }}>
      <h4>Reutilizar relación</h4><label>Relación <select name="relationId" required disabled={disabled}><option value="">Elegir</option>{c4.relationships.map((r) => <option key={r.id} value={r.id}>{c4.elements.find((e) => e.id === r.sourceEntityId)?.title} → {c4.elements.find((e) => e.id === r.targetEntityId)?.title}: {r.description}</option>)}</select></label>
      {endpoints('source')}{endpoints('target')}<button disabled={disabled}>Representar relación existente</button>
    </form>
    {c4.relationViews.map((view) => <form key={`${view.id}:${view.relationRevision}`} data-c4-relationship={view.relationId} onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      onOperation({ action: 'update-relationship', relationId: view.relationId, expectedRevision: view.relationRevision, description: String(values.get('description')), protocol: String(values.get('protocol')) });
    }}><label>Descripción de relación <input name="description" required defaultValue={view.description} disabled={disabled} /></label><label>Protocolo <input name="protocol" defaultValue={view.protocol} disabled={disabled} /></label><button disabled={disabled}>Guardar relación compartida</button></form>)}
    {current?.data.kind === 'dynamic' && <section data-c4-sequence aria-label="Secuencia dinámica C4">
      <h4>Secuencia ordenada</h4>
      <ol>{[...current.data.steps].sort((a, b) => a.order - b.order).map((step, index) => <li key={step.id} data-c4-step={step.id}>
        {step.order}. {step.description || c4.relationViews.find((r) => r.id === step.relationViewId)?.description}
        <button type="button" aria-label={`Subir paso ${step.order}`} disabled={disabled || index === 0} onClick={() => reorder(index, -1)}>↑</button>
        <button type="button" aria-label={`Bajar paso ${step.order}`} disabled={disabled || index === current.data.steps.length - 1} onClick={() => reorder(index, 1)}>↓</button>
        <button type="button" disabled={disabled} onClick={() => saveSteps(current.data.steps.filter((s) => s.id !== step.id))}>Quitar paso</button>
      </li>)}</ol>
      <form data-c4-add-step onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget);
        saveSteps([...current.data.steps, { id: crypto.randomUUID(), relationViewId: String(values.get('relationViewId')), order: Math.max(0, ...current.data.steps.map((s) => s.order)) + 1, description: String(values.get('description')) }]);
      }}><label>Relación representada <select name="relationViewId" required disabled={disabled}>{c4.relationViews.map((r) => <option key={r.id} value={r.id}>{r.description}</option>)}</select></label>
        <label>Descripción de este paso (opcional) <input name="description" disabled={disabled} /></label><button disabled={disabled || !c4.relationViews.length}>Añadir paso</button>
      </form>
    </section>}
    {!workspace.canWrite && <p role="note">El broker mantiene el inspector en solo lectura.</p>}
  </details>;
}
