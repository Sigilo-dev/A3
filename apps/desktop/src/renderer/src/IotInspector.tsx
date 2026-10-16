import { useMemo, useState } from 'react';
import { IOT_CATALOG, IOT_COLLECTIONS, isIotComponent, iotData, type IotCollectionId, type IotPort } from '@a3/domain/iot';
import { iotCircuitData, isIotCircuit, serializeIotCircuitContext, validateIotCircuitModel, type IotBusLane, type IotCircuitData, type IotNet, type IotNetKind } from '@a3/domain/iot-circuit';
import type { LocalCanvasWorkspace } from '../../shared/desktop-api';

const evidenceText = (value: { state: string; value?: unknown; reason?: string }) => value.state === 'known' ? JSON.stringify(value.value) : `Desconocido: ${value.reason ?? 'sin dato documentado'}`;
const limitsText = (limits: IotPort['limits']) => Object.entries(limits).map(([name, value]) => `${name}: ${evidenceText(value)}`).join(' · ');
function PortTable({ ports }: { ports: readonly IotPort[] }): React.JSX.Element {
  return <div className="iot-port-list"><table><thead><tr><th>ID</th><th>Etiqueta / función</th><th>Dirección</th><th>Señal / bus</th><th>Límites</th></tr></thead>
    <tbody>{ports.map((port) => <tr key={port.id} data-iot-port-id={port.id}>
      <td><code>{port.id}</code></td><td>{port.label}<small>{port.function}{port.availability === 'reserved' ? ' · reservado' : ''}</small></td>
      <td>{port.direction}</td><td>{evidenceText(port.signalType)}<small>Bus: {evidenceText(port.bus)}</small></td><td>{limitsText(port.limits)}</td>
    </tr>)}</tbody></table></div>;
}
function saveText(name: string, content: string, mediaType: string): void {
  const blob = new Blob([content], { type: mediaType }), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function nextReference(model: IotCircuitData): string {
  let index = model.instances.length + 1;
  while (model.instances.some((instance) => instance.reference.toLowerCase() === `u${index}`)) index++;
  return `U${index}`;
}

export function IotInspector({ workspace, selectedEntityId, onCreate, onCreateCircuit, onChangeCircuit }: {
  workspace: LocalCanvasWorkspace; selectedEntityId?: string;
  onCreate: (catalogId: string, title: string) => void;
  onCreateCircuit: (title: string) => void;
  onChangeCircuit: (entityId: string, expectedRevision: number, model: IotCircuitData) => void;
}): React.JSX.Element {
  const [collectionId, setCollectionId] = useState<IotCollectionId>('a3.iot.collection.esp32');
  const [catalogId, setCatalogId] = useState(IOT_CATALOG.find((entry) => entry.collectionId === collectionId && !entry.template)?.catalogId ?? '');
  const [circuitId, setCircuitId] = useState('');
  const entries = useMemo(() => IOT_CATALOG.filter((entry) => entry.collectionId === collectionId), [collectionId]);
  const selectedEntry = entries.find((entry) => entry.catalogId === catalogId);
  const selected = workspace.entities.find((entity) => entity.id.toLowerCase() === selectedEntityId?.toLowerCase() && isIotComponent(entity));
  const metadata = selected && iotData(selected);
  const ports = selected?.ports as IotPort[] | undefined;
  const disabled = !workspace.canWrite;
  const components = workspace.entities.filter(isIotComponent);
  const circuits = workspace.entities.filter(isIotCircuit);
  const selectedCircuit = circuits.find((entity) => entity.id === circuitId) ?? circuits.find((entity) => entity.id === selectedEntityId) ?? circuits[0];
  const circuit = selectedCircuit && iotCircuitData(selectedCircuit);
  const issues = circuit && selectedCircuit ? validateIotCircuitModel(circuit, workspace.entities, selectedCircuit.id) : [];
  const exports = circuit && selectedCircuit ? serializeIotCircuitContext(selectedCircuit, workspace.entities) : undefined;
  const selectableEndpoints = circuit ? circuit.instances.flatMap((instance) => {
    const component = components.find((entity) => entity.id.toLowerCase() === instance.entityId.toLowerCase());
    return component ? (component.ports as IotPort[]).map((port) => ({ value: `${component.id}|${port.id}`, label: `${instance.reference} · ${component.title} · ${port.label ?? port.id} [${port.id}]` })) : [];
  }) : [];
  const update = (next: IotCircuitData): void => {
    if (selectedCircuit) onChangeCircuit(selectedCircuit.id, selectedCircuit.revision, next);
  };
  const addInstance = (componentId: string): void => {
    if (!circuit || circuit.instances.some((instance) => instance.entityId.toLowerCase() === componentId.toLowerCase())) return;
    update({ ...circuit, instances: [...circuit.instances, { entityId: componentId, reference: nextReference(circuit), parameters: {} }] });
  };
  return <details className="iot-inspector" data-iot-inspector>
    <summary>IoT · Circuitos y catálogo identificado</summary>
    <p>Redes A3 conservan múltiples pines, uniones, buses, alimentación y tierra. Las reglas incompletas o desconocidas se muestran aparte; no se simula ni certifica el circuito.</p>
    <form data-iot-create-component onSubmit={(event) => {
      event.preventDefault();
      const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
      if (catalogId && title) onCreate(catalogId, title);
    }}>
      <label>Colección <select aria-label="Colección IoT" value={collectionId} disabled={disabled} onChange={(event) => {
        const next = event.currentTarget.value as IotCollectionId; setCollectionId(next);
        setCatalogId(IOT_CATALOG.find((entry) => entry.collectionId === next && !entry.template)?.catalogId ?? '');
      }}>{IOT_COLLECTIONS.map((collection) => <option key={collection.id} value={collection.id}>{collection.label}</option>)}</select></label>
      <label>Componente <select aria-label="Componente IoT" value={catalogId} disabled={disabled || !entries.some((entry) => !entry.template)} onChange={(event) => setCatalogId(event.currentTarget.value)}>
        {entries.map((entry) => <option key={entry.catalogId} value={entry.catalogId} disabled={entry.template}>{entry.title}{entry.template ? ' · plantilla' : ''}</option>)}
      </select></label>
      <label>Nombre de instancia <input name="title" key={catalogId} defaultValue={selectedEntry?.title ?? ''} maxLength={200} required disabled={disabled || !selectedEntry || selectedEntry.template} /></label>
      {selectedEntry && <><p>{selectedEntry.description}</p><small>Fabricante: {evidenceText(selectedEntry.manufacturer)} · modelo: {selectedEntry.model} · revisión: {evidenceText(selectedEntry.revision)}</small>
        <PortTable ports={selectedEntry.ports} /><small>Fuentes: {selectedEntry.sources.map((source) => `${source.title}${source.documentRevision ? ` (${source.documentRevision})` : ''}`).join(' · ')}</small></>}
      <button type="submit" disabled={disabled || !selectedEntry || selectedEntry.template}>Añadir componente al lienzo</button>
    </form>
    <form data-iot-create-circuit onSubmit={(event) => { event.preventDefault(); const title = String(new FormData(event.currentTarget).get('title') ?? '').trim(); if (title) onCreateCircuit(title); }}>
      <label>Nuevo circuito <input name="title" maxLength={200} defaultValue="Circuito IoT" required disabled={disabled} /></label>
      <button type="submit" disabled={disabled}>Crear circuito</button>
    </form>
    {circuits.length > 0 && <section data-iot-circuit-editor>
      <label>Circuito <select aria-label="Circuito IoT" value={selectedCircuit?.id ?? ''} onChange={(event) => setCircuitId(event.currentTarget.value)}>
        {circuits.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      {selectedCircuit && circuit && <>
        <p>Entity ID: <code>{selectedCircuit.id}</code> · revisión {selectedCircuit.revision}</p>
        <h4>Instancias del modelo</h4>
        {components.map((component) => {
          const instance = circuit.instances.find((item) => item.entityId.toLowerCase() === component.id.toLowerCase());
          return <p key={component.id}>{instance ? <><strong>{instance.reference}</strong> · {component.title} <button type="button" disabled={disabled || circuit.nets.some((net) => (net.kind === 'bus' ? net.bus!.members.flatMap((lane) => lane.endpoints) : net.endpoints).some((endpoint) => endpoint.entityId === component.id))}
            onClick={() => update({ ...circuit, instances: circuit.instances.filter((item) => item.entityId !== component.id) })}>Quitar</button></> : <button type="button" disabled={disabled} onClick={() => addInstance(component.id)}>Incluir {component.title}</button>}</p>;
        })}
        <h4>Crear red</h4>
        <form data-iot-create-net onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget, data = new FormData(form), name = String(data.get('name') ?? '').trim();
          const kind = String(data.get('kind') ?? 'signal') as IotNetKind, endpoints = data.getAll('endpoint').map(String).map((value) => { const [entityId, portId] = value.split('|'); return { entityId: entityId!, portId: portId! }; });
          if (!name || kind !== 'bus' && !endpoints.length) return;
          const protocol = String(data.get('protocol') ?? '').trim();
          const net: IotNet = { id: crypto.randomUUID(), name, kind, endpoints: kind === 'bus' ? [] : endpoints, junctions: [], ...(kind === 'bus' ? { bus: { protocol: protocol ? { state: 'known' as const, value: protocol } : { state: 'unknown' as const, reason: 'No se ha especificado el protocolo del bus.' }, members: [] } } : {}), notes: [], extensions: {} };
          update({ ...circuit, nets: [...circuit.nets, net] }); form.reset();
        }}>
          <label>Nombre <input name="name" maxLength={120} required disabled={disabled} /></label>
          <label>Tipo <select name="kind" disabled={disabled}><option value="signal">Señal</option><option value="bus">Bus</option><option value="power">Alimentación</option><option value="ground">Tierra</option></select></label>
          <label>Protocolo de bus <input name="protocol" placeholder="I2C, SPI…" disabled={disabled} /></label>
          <label>Pines de una red eléctrica (no se usa para crear el grupo bus) <select name="endpoint" multiple size={5} disabled={disabled || !circuit.instances.length}>
            {selectableEndpoints.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>
          <button type="submit" disabled={disabled || !circuit.instances.length}>Añadir red o grupo bus</button>
        </form>
        <ul data-iot-net-list>{circuit.nets.map((net) => <li key={net.id} data-iot-net-id={net.id}>
          <strong>{net.name}</strong> · {net.kind}{net.kind === 'bus' ? ` · ${net.bus?.protocol.state === 'known' ? net.bus.protocol.value : 'protocolo desconocido'}` : ` · ${net.endpoints.length} extremos`}
          {net.kind !== 'bus' ? <><small>{net.endpoints.map((endpoint) => `${circuit.instances.find((item) => item.entityId === endpoint.entityId)?.reference ?? '?'}:${endpoint.portId}`).join(' ↔ ') || 'sin extremos'}</small>
            <button type="button" disabled={disabled} onClick={() => update({ ...circuit, nets: circuit.nets.map((item) => item.id === net.id ? { ...item, junctions: [...item.junctions, { id: crypto.randomUUID(), label: `Unión ${item.junctions.length + 1}` }] } : item) })}>Añadir unión</button></>
            : <><ul>{net.bus!.members.map((lane) => <li key={lane.id} data-iot-bus-lane={lane.id}><strong>{lane.name}</strong><small>{lane.endpoints.map((endpoint) => `${circuit.instances.find((item) => item.entityId === endpoint.entityId)?.reference ?? '?'}:${endpoint.portId}`).join(' ↔ ') || 'carril incompleto'}</small>
              <button type="button" disabled={disabled} onClick={() => update({ ...circuit, nets: circuit.nets.map((item) => item.id === net.id ? { ...item, bus: { ...item.bus!, members: item.bus!.members.map((member) => member.id === lane.id ? { ...member, junctions: [...member.junctions, { id: crypto.randomUUID(), label: `Unión ${member.junctions.length + 1}` }] } : member) } } : item) })}>Añadir unión</button>
              <button type="button" disabled={disabled} onClick={() => update({ ...circuit, nets: circuit.nets.map((item) => item.id === net.id ? { ...item, bus: { ...item.bus!, members: item.bus!.members.filter((member) => member.id !== lane.id) } } : item) })}>Eliminar carril</button>
            </li>)}</ul>
            <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form), name = String(data.get('lane') ?? '').trim();
              const endpoints = data.getAll('endpoint').map(String).map((value) => { const [entityId, portId] = value.split('|'); return { entityId: entityId!, portId: portId! }; }); if (!name || !endpoints.length) return;
              const lane: IotBusLane = { id: crypto.randomUUID(), name, endpoints, junctions: [] };
              update({ ...circuit, nets: circuit.nets.map((item) => item.id === net.id ? { ...item, bus: { ...item.bus!, members: [...item.bus!.members, lane] } } : item) }); form.reset(); }}>
              <label>Nuevo carril <input name="lane" required disabled={disabled} /></label><label>Pines de este carril <select name="endpoint" multiple size={4} disabled={disabled}>{selectableEndpoints.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button disabled={disabled}>Añadir carril</button>
            </form></>}
          <button type="button" disabled={disabled} onClick={() => update({ ...circuit, nets: circuit.nets.filter((item) => item.id !== net.id) })}>Eliminar red</button>
        </li>)}</ul>
        <h4>Parámetros, requisitos, restricciones y notas</h4>
        <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, requirement = String(new FormData(form).get('requirement') ?? '').trim(); if (!requirement) return;
          update({ ...circuit, requirements: [...circuit.requirements, requirement] }); form.reset(); }}>
          <label>Requisito <input name="requirement" required disabled={disabled} /></label><button disabled={disabled}>Añadir requisito</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form), name = String(data.get('parameter') ?? '').trim(); if (!name) return;
          const value = data.get('state') === 'unknown' ? { state: 'unknown' as const, reason: String(data.get('reason') ?? '').trim() || 'Aún no documentado.' } : { state: 'known' as const, value: String(data.get('value') ?? '') };
          update({ ...circuit, parameters: [...circuit.parameters, { id: crypto.randomUUID(), name, value, ...(String(data.get('unit') ?? '').trim() ? { unit: String(data.get('unit')).trim() } : {}) }] }); form.reset(); }}>
          <label>Parámetro <input name="parameter" required disabled={disabled} /></label><label>Estado <select name="state" disabled={disabled}><option value="known">Conocido</option><option value="unknown">Desconocido</option></select></label>
          <label>Valor documentado <input name="value" disabled={disabled} /></label><label>Motivo si se desconoce <input name="reason" disabled={disabled} /></label><label>Unidad <input name="unit" disabled={disabled} /></label><button disabled={disabled}>Añadir parámetro</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form), statement = String(data.get('constraint') ?? '').trim(); if (!statement) return;
          update({ ...circuit, constraints: [...circuit.constraints, { id: crypto.randomUUID(), statement, state: data.get('state') === 'unknown' ? 'unknown' : 'known', ...(String(data.get('source') ?? '').trim() ? { source: String(data.get('source')).trim() } : {}) }] }); form.reset(); }}>
          <label>Restricción <input name="constraint" required disabled={disabled} /></label><label>Estado <select name="state" disabled={disabled}><option value="known">Conocida</option><option value="unknown">Desconocida</option></select></label><label>Fuente <input name="source" disabled={disabled} /></label><button disabled={disabled}>Añadir restricción</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form), text = String(data.get('text') ?? '').trim(); if (!text) return;
          update({ ...circuit, notes: [...circuit.notes, { id: crypto.randomUUID(), markdown: text }] }); form.reset(); }}>
          <label>Nota Markdown <textarea name="text" required disabled={disabled} /></label><button disabled={disabled}>Añadir nota</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, data = new FormData(form), question = String(data.get('question') ?? '').trim(); if (!question) return;
          update({ ...circuit, questions: [...circuit.questions, question] }); form.reset(); }}>
          <label>Pregunta pendiente <input name="question" required disabled={disabled} /></label><button disabled={disabled}>Añadir pregunta</button>
        </form>
        {!!issues.length && <section aria-label="Validación del circuito" data-iot-validation>
          <h4>Diagnósticos por estado</h4>
          {(['invalid', 'incomplete', 'unknown'] as const).map((state) => {
            const matches = issues.filter((issue) => issue.state === state);
            return matches.length ? <div key={state} data-iot-issue-state={state}><strong>{state === 'invalid' ? 'Inválido' : state === 'incomplete' ? 'Incompleto' : 'Desconocido'}</strong><ul>{matches.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div> : null;
          })}
        </section>}
        {exports?.ok && <section data-iot-export>
          <h4>Exportar contexto A3</h4><p>Manifest: {exports.value.manifest.entityIds.length} entidades y {exports.value.manifest.sources.length} fuentes; omitidos por tamaño: {exports.value.manifest.omitted.length}.</p>
          <button type="button" onClick={() => saveText('a3-iot-bom.csv', exports.value.bomCsv, 'text/csv;charset=utf-8')}>BOM CSV</button>
          <button type="button" onClick={() => saveText('a3-iot-connections.json', exports.value.connectionsJson, 'application/json;charset=utf-8')}>Conexiones JSON por ID</button>
          <button type="button" onClick={() => saveText('a3-iot-pin-table.csv', exports.value.pinTableCsv, 'text/csv;charset=utf-8')}>Tabla de pines CSV</button>
          <button type="button" onClick={() => saveText('a3-iot-context.md', exports.value.contextMarkdown, 'text/markdown;charset=utf-8')}>Contexto Markdown</button>
        </section>}
      </>}
    </section>}
    {selected && metadata && <section className="iot-selected-component" data-iot-selected={selected.id}>
      <h4>{selected.title}</h4><p>{metadata.model} · {metadata.manufacturer.state === 'known' ? metadata.manufacturer.value : 'fabricante desconocido'} · revisión {evidenceText(metadata.revision)}</p>
      <small>Entity ID: {selected.id}</small><PortTable ports={ports ?? []} />
      <small>Fuentes: {metadata.sources.map((source) => `${source.title}${source.documentRevision ? ` (${source.documentRevision})` : ''}`).join(' · ')}</small>
    </section>}
    {disabled && <p role="note">Solo lectura: el broker no concede edición de diagramas a este proyecto.</p>}
  </details>;
}
