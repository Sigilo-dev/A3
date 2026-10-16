import { UML_CATALOG, UML_RELATIONS, UML_VISIBILITIES, type UmlAttribute, type UmlPatch, type UmlEnd, type UmlKind, type UmlMethod, type UmlOperation, type UmlParameter, type UmlRelationData, type UmlRelationKind, type UmlType, type UmlVisibility } from '@a3/domain/uml';
import type { CanvasUmlElement, CanvasUmlRelationView, LocalCanvasWorkspace } from '../../shared/desktop-api';

const value = (form: FormData, key: string) => String(form.get(key) ?? '');
const lines = (text: string) => text.split('\n').map((item) => item.trim()).filter(Boolean);
const same = (a: string, b: string | undefined) => a.toLowerCase() === b?.toLowerCase();
const optionId = (elements: CanvasUmlElement[], id: string | undefined) => elements.find((e) => same(e.id, id))?.id ?? id ?? '';
const defaultEnd = (): UmlEnd => ({ role: '', multiplicity: { lower: 1, upper: 1 }, navigable: false });
function typeValue(form: FormData): UmlType { const entityId = value(form, 'typeEntityId'); return { name: value(form, 'typeName'), ...(entityId ? { entityId } : {}) }; }
function TypeFields({ type, elements, label = 'Tipo', disabled }: { type: UmlType; elements: CanvasUmlElement[]; label?: string; disabled: boolean }): React.JSX.Element {
  return <><label>{label} <input name="typeName" defaultValue={type.name} required maxLength={200} disabled={disabled} /></label>
    <label>Referencia de tipo <select name="typeEntityId" defaultValue={optionId(elements, type.entityId)} disabled={disabled}><option value="">Tipo textual</option>{elements.filter((e) => e.kind !== 'package').map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label></>;
}
function Visibility({ initial = 'public', disabled }: { initial?: UmlVisibility; disabled: boolean }): React.JSX.Element {
  return <label>Visibilidad <select name="visibility" defaultValue={initial} disabled={disabled}>{UML_VISIBILITIES.map((v) => <option key={v}>{v}</option>)}</select></label>;
}
function attributeValue(form: FormData, id: string): UmlAttribute { return { id, name: value(form, 'name'), type: typeValue(form), visibility: value(form, 'visibility') as UmlVisibility, static: form.has('static'), readOnly: form.has('readOnly'), defaultValue: value(form, 'defaultValue') }; }
function AttributeFields({ initial, elements, disabled }: { initial?: UmlAttribute; elements: CanvasUmlElement[]; disabled: boolean }): React.JSX.Element {
  return <><label>Nombre de atributo <input name="name" defaultValue={initial?.name ?? ''} required maxLength={200} disabled={disabled} /></label>
    <TypeFields type={initial?.type ?? { name: 'string' }} elements={elements} disabled={disabled} /><Visibility initial={initial?.visibility} disabled={disabled} />
    <label>Valor inicial <input name="defaultValue" defaultValue={initial?.defaultValue ?? ''} disabled={disabled} /></label>
    <label><input name="static" type="checkbox" defaultChecked={initial?.static ?? false} disabled={disabled} />Estático</label>
    <label><input name="readOnly" type="checkbox" defaultChecked={initial?.readOnly ?? false} disabled={disabled} />Solo lectura</label></>;
}
function ParameterFields({ initial, elements, disabled }: { initial?: UmlParameter; elements: CanvasUmlElement[]; disabled: boolean }): React.JSX.Element {
  return <><label>Nombre de parámetro <input name="name" defaultValue={initial?.name ?? ''} required maxLength={200} disabled={disabled} /></label>
    <TypeFields type={initial?.type ?? { name: 'string' }} elements={elements} disabled={disabled} />
    <label>Dirección <select name="direction" defaultValue={initial?.direction ?? 'in'} disabled={disabled}>{['in', 'out', 'inout'].map((v) => <option key={v}>{v}</option>)}</select></label>
    <label>Valor inicial <input name="defaultValue" defaultValue={initial?.defaultValue ?? ''} disabled={disabled} /></label></>;
}
function parameterValue(form: FormData, id: string): UmlParameter { return { id, name: value(form, 'name'), type: typeValue(form), direction: value(form, 'direction') as UmlParameter['direction'], defaultValue: value(form, 'defaultValue') }; }
function move<T>(items: T[], index: number, offset: number): T[] { const next = [...items], target = index + offset; if (target < 0 || target >= items.length) return next; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }
function EndFields({ prefix, initial, disabled }: { prefix: 'source' | 'target'; initial: UmlEnd; disabled: boolean }): React.JSX.Element {
  return <fieldset disabled={disabled}><legend>{prefix === 'source' ? 'Extremo origen' : 'Extremo destino'}</legend>
    <label>Rol <input name={`${prefix}Role`} defaultValue={initial.role} maxLength={200} /></label>
    <label>Mínimo <input name={`${prefix}Lower`} type="number" min="0" step="1" required defaultValue={initial.multiplicity.lower} /></label>
    <label>Máximo (* ilimitado) <input name={`${prefix}Upper`} pattern="[0-9]+|\*" required defaultValue={initial.multiplicity.upper} /></label>
    <label><input name={`${prefix}Navigable`} type="checkbox" defaultChecked={initial.navigable} />Navegable</label>
  </fieldset>;
}
function endValue(form: FormData, prefix: string): UmlEnd { const upper = value(form, `${prefix}Upper`); return { role: value(form, `${prefix}Role`), multiplicity: { lower: Number(value(form, `${prefix}Lower`)), upper: upper === '*' ? '*' : Number(upper) }, navigable: form.has(`${prefix}Navigable`) }; }
function RelationFields({ initial, disabled }: { initial?: UmlRelationData; disabled: boolean }): React.JSX.Element {
  return <><label>Etiqueta <input name="label" defaultValue={initial?.label ?? ''} maxLength={1000} disabled={disabled} /></label>
    <EndFields prefix="source" initial={initial?.source ?? defaultEnd()} disabled={disabled} /><EndFields prefix="target" initial={initial?.target ?? defaultEnd()} disabled={disabled} />
    <label>Estereotipos (uno por línea) <textarea name="stereotypes" defaultValue={initial?.stereotypes.join('\n') ?? ''} disabled={disabled} /></label>
    <label>Restricciones (una por línea) <textarea name="constraints" defaultValue={initial?.constraints.join('\n') ?? ''} disabled={disabled} /></label></>;
}
function relationValue(form: FormData): UmlRelationData { return { label: value(form, 'label'), source: endValue(form, 'source'), target: endValue(form, 'target'), stereotypes: lines(value(form, 'stereotypes')), constraints: lines(value(form, 'constraints')) }; }

function ElementEditor({ element, elements, onOperation, disabled }: { element: CanvasUmlElement; elements: CanvasUmlElement[]; onOperation: (op: UmlOperation) => void; disabled: boolean }): React.JSX.Element {
  const { data, kind } = element;
  const patch = (data: UmlPatch) => onOperation({ action: 'update-element', entityId: element.id, expectedRevision: element.revision, title: element.title, data });
  const updateMethod = (method: UmlMethod) => patch({ methods: data.methods.map((m) => m.id === method.id ? method : m) });
  return <section data-uml-element-editor>
    <h4>{element.title} · {kind}</h4><small>ID compartido: {element.id}</small>
    <form data-uml-properties onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget);
      onOperation({ action: 'update-element', entityId: element.id, expectedRevision: element.revision, title: value(values, 'title'), data: { description: value(values, 'description'), visibility: value(values, 'visibility') as UmlVisibility,
        abstract: values.has('abstract'), parentId: value(values, 'parentId') || null, stereotypes: lines(value(values, 'stereotypes')), constraints: lines(value(values, 'constraints')) } });
    }}>
      <label>Nombre <input name="title" required maxLength={200} defaultValue={element.title} disabled={disabled} /></label><Visibility initial={data.visibility} disabled={disabled} />
      <label>Paquete semántico <select name="parentId" defaultValue={optionId(elements, data.parentId)} disabled={disabled}><option value="">Sin paquete</option>{elements.filter((e) => e.kind === 'package' && !same(e.id, element.id)).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
      <label>Descripción Markdown <textarea name="description" defaultValue={data.description} disabled={disabled} /></label>
      <label>Estereotipos (uno por línea) <textarea name="stereotypes" defaultValue={data.stereotypes.join('\n')} disabled={disabled} /></label>
      <label>Restricciones (una por línea) <textarea name="constraints" defaultValue={data.constraints.join('\n')} disabled={disabled} /></label>
      {kind !== 'package' && <label><input name="abstract" type="checkbox" defaultChecked={data.abstract} disabled={disabled} />Abstracto</label>}
      <button disabled={disabled}>Guardar propiedades UML</button>
    </form>
    {kind !== 'package' && <>
      <h4>Atributos</h4>{data.attributes.map((attribute) => <form key={attribute.id} data-uml-attribute={attribute.id} onSubmit={(event) => { event.preventDefault(); const next = attributeValue(new FormData(event.currentTarget), attribute.id); patch({ attributes: data.attributes.map((a) => a.id === attribute.id ? next : a) }); }}>
        <AttributeFields initial={attribute} elements={elements} disabled={disabled} /><button disabled={disabled}>Guardar atributo</button>
        <button type="button" disabled={disabled} onClick={() => patch({ attributes: data.attributes.filter((a) => a.id !== attribute.id) })}>Quitar atributo</button>
      </form>)}
      <form data-uml-add-attribute onSubmit={(event) => { event.preventDefault(); patch({ attributes: [...data.attributes, attributeValue(new FormData(event.currentTarget), crypto.randomUUID())] }); }}>
        <AttributeFields elements={elements} disabled={disabled} /><button disabled={disabled}>Añadir atributo</button>
      </form>
      <h4>Métodos</h4>{data.methods.map((method) => <details key={method.id} open data-uml-method={method.id}>
        <summary>{method.name} · {method.parameters.length} parámetros</summary>
        <form onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); updateMethod({ ...method, name: value(values, 'name'), returnType: typeValue(values), visibility: value(values, 'visibility') as UmlVisibility, static: values.has('static'), abstract: values.has('abstract') }); }}>
          <label>Nombre de método <input name="name" required maxLength={200} defaultValue={method.name} disabled={disabled} /></label>
          <TypeFields label="Retorno" type={method.returnType} elements={elements} disabled={disabled} /><Visibility initial={method.visibility} disabled={disabled} />
          <label><input type="checkbox" name="static" defaultChecked={method.static} disabled={disabled} />Estático</label><label><input type="checkbox" name="abstract" defaultChecked={method.abstract} disabled={disabled} />Abstracto</label>
          <button disabled={disabled}>Guardar método</button><button type="button" disabled={disabled} onClick={() => patch({ methods: data.methods.filter((m) => m.id !== method.id) })}>Quitar método</button>
        </form>
        {method.parameters.map((parameter, index) => <form key={parameter.id} data-uml-parameter={parameter.id} onSubmit={(event) => { event.preventDefault(); const next = parameterValue(new FormData(event.currentTarget), parameter.id); updateMethod({ ...method, parameters: method.parameters.map((p) => p.id === parameter.id ? next : p) }); }}>
          <ParameterFields initial={parameter} elements={elements} disabled={disabled} /><button disabled={disabled}>Guardar parámetro</button>
          <button type="button" disabled={disabled || index === 0} onClick={() => updateMethod({ ...method, parameters: move(method.parameters, index, -1) })}>Subir parámetro</button>
          <button type="button" disabled={disabled || index === method.parameters.length - 1} onClick={() => updateMethod({ ...method, parameters: move(method.parameters, index, 1) })}>Bajar parámetro</button>
          <button type="button" disabled={disabled} onClick={() => updateMethod({ ...method, parameters: method.parameters.filter((p) => p.id !== parameter.id) })}>Quitar parámetro</button>
        </form>)}
        <form data-uml-add-parameter onSubmit={(event) => { event.preventDefault(); updateMethod({ ...method, parameters: [...method.parameters, parameterValue(new FormData(event.currentTarget), crypto.randomUUID())] }); }}>
          <ParameterFields elements={elements} disabled={disabled} /><button disabled={disabled}>Añadir parámetro</button>
        </form>
      </details>)}
      <form data-uml-add-method onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget);
        patch({ methods: [...data.methods, { id: crypto.randomUUID(), name: value(values, 'name'), returnType: typeValue(values), visibility: value(values, 'visibility') as UmlVisibility, static: values.has('static'), abstract: values.has('abstract'), parameters: [] }] });
      }}><label>Nombre de método <input name="name" required maxLength={200} disabled={disabled} /></label><TypeFields label="Retorno" type={{ name: 'void' }} elements={elements} disabled={disabled} /><Visibility disabled={disabled} />
        <label><input type="checkbox" name="static" disabled={disabled} />Estático</label><label><input type="checkbox" name="abstract" disabled={disabled} />Abstracto</label><button disabled={disabled}>Añadir método</button>
      </form>
    </>}
    {kind === 'enum' && <><h4>Literales</h4>{data.literals.map((literal) => <form key={literal.id} data-uml-literal={literal.id} onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); patch({ literals: data.literals.map((l) => l.id === literal.id ? { ...l, name: value(values, 'name'), value: value(values, 'value') } : l) }); }}>
      <label>Literal <input name="name" defaultValue={literal.name} required disabled={disabled} /></label><label>Valor <input name="value" defaultValue={literal.value} disabled={disabled} /></label><button disabled={disabled}>Guardar literal</button>
      <button type="button" disabled={disabled} onClick={() => patch({ literals: data.literals.filter((l) => l.id !== literal.id) })}>Quitar literal</button>
    </form>)}<form data-uml-add-literal onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); patch({ literals: [...data.literals, { id: crypto.randomUUID(), name: value(values, 'name'), value: value(values, 'value') }] }); }}>
      <label>Literal <input name="name" required disabled={disabled} /></label><label>Valor <input name="value" disabled={disabled} /></label><button disabled={disabled}>Añadir literal</button>
    </form></>}
  </section>;
}

export function UmlInspector({ workspace, selectedEntityId, onOperation }: { workspace: LocalCanvasWorkspace; selectedEntityId?: string; onOperation: (op: UmlOperation) => void }): React.JSX.Element {
  const uml = workspace.uml, disabled = !workspace.canWrite, selected = uml.elements.find((e) => same(e.id, selectedEntityId));
  const local = workspace.placements.flatMap((p) => { const e = uml.elements.find((item) => same(item.id, p.entityId)); return e ? [{ placement: p, entity: e }] : []; });
  const endpoint = (name: string) => <label>{name === 'source' ? 'Origen' : 'Destino'} <select name={name} required disabled={disabled}><option value="">Elegir representación</option>{local.map(({ placement, entity }) => <option key={placement.id} value={placement.id}>{entity.title} · {placement.id.slice(-6)}</option>)}</select></label>;
  return <details className="conceptual-inspector uml-inspector" data-uml-inspector><summary>UML · Clases, interfaces, enumeraciones y paquetes</summary>
    <p>Generalización: subtipo → supertipo. Realización: clase → interfaz. Agregación/composición: todo → parte. Los grupos del lienzo no definen paquetes.</p>
    <form data-uml-create-element onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); onOperation({ action: 'create-element', kind: value(values, 'kind') as UmlKind, title: value(values, 'title'), data: { parentId: value(values, 'parentId') || null }, position: { x: 0, y: 0 } }); }}>
      <label>Tipo UML <select name="kind" disabled={disabled}>{UML_CATALOG.map((e) => <option key={e.kind} value={e.kind}>{e.label}</option>)}</select></label>
      <label>Nombre <input name="title" required maxLength={200} defaultValue="Nueva clase" disabled={disabled} /></label>
      <label>Paquete semántico <select name="parentId" disabled={disabled}><option value="">Sin paquete</option>{uml.elements.filter((e) => e.kind === 'package').map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label>
      <button disabled={disabled}>Crear elemento UML</button>
    </form>
    <form data-uml-reuse-element onSubmit={(event) => { event.preventDefault(); onOperation({ action: 'show-element', entityId: value(new FormData(event.currentTarget), 'entityId'), position: { x: 0, y: 0 } }); }}>
      <label>Elemento compartido <select name="entityId" required disabled={disabled}><option value="">Elegir</option>{uml.elements.map((e) => <option key={e.id} value={e.id}>{e.title} · {e.kind}</option>)}</select></label><button disabled={disabled}>Crear otra representación UML</button>
    </form>
    {selected && <ElementEditor key={`${selected.id}:${selected.revision}`} element={selected} elements={uml.elements} onOperation={onOperation} disabled={disabled} />}
    <form data-uml-create-relationship onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); onOperation({ action: 'create-relationship', kind: value(values, 'kind') as UmlRelationKind, sourcePlacementId: value(values, 'source'), targetPlacementId: value(values, 'target'), data: relationValue(values) }); }}>
      <h4>Relación UML semántica</h4><label>Tipo <select name="kind" disabled={disabled}>{UML_RELATIONS.map((r) => <option key={r}>{r}</option>)}</select></label>{endpoint('source')}{endpoint('target')}
      <RelationFields disabled={disabled} /><button disabled={disabled}>Crear relación UML</button>
    </form>
    <form data-uml-reuse-relationship onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); onOperation({ action: 'show-relationship', relationId: value(values, 'relationId'), sourcePlacementId: value(values, 'source'), targetPlacementId: value(values, 'target') }); }}>
      <label>Relación compartida <select name="relationId" required disabled={disabled}><option value="">Elegir</option>{uml.relationships.map((r) => <option key={r.id} value={r.id}>{uml.elements.find((e) => same(e.id, r.sourceEntityId))?.title} → {uml.elements.find((e) => same(e.id, r.targetEntityId))?.title} · {r.kind}</option>)}</select></label>
      {endpoint('source')}{endpoint('target')}<button disabled={disabled}>Representar relación UML existente</button>
    </form>
    {uml.relationViews.map((r) => <RelationshipEditor key={`${r.id}:${r.relationRevision}`} relation={r} disabled={disabled} onOperation={onOperation} />)}
    {disabled && <p role="note">El broker mantiene el inspector en solo lectura.</p>}
  </details>;
}
function RelationshipEditor({ relation: r, disabled, onOperation }: { relation: CanvasUmlRelationView; disabled: boolean; onOperation: (op: UmlOperation) => void }): React.JSX.Element {
  return <form data-uml-relationship={r.relationId} onSubmit={(event) => { event.preventDefault(); onOperation({ action: 'update-relationship', relationId: r.relationId, expectedRevision: r.relationRevision, data: relationValue(new FormData(event.currentTarget)) }); }}>
    <h4>{r.kind} · {r.data.label}</h4><RelationFields initial={r.data} disabled={disabled} /><button disabled={disabled}>Guardar relación UML</button>
  </form>;
}
