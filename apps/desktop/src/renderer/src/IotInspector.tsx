import { useMemo, useState } from 'react';
import { IOT_CATALOG, IOT_COLLECTIONS, isIotComponent, iotData, type IotCollectionId, type IotPort } from '@a3/domain/iot';
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

export function IotInspector({ workspace, selectedEntityId, onCreate }: { workspace: LocalCanvasWorkspace; selectedEntityId?: string; onCreate: (catalogId: string, title: string) => void }): React.JSX.Element {
  const [collectionId, setCollectionId] = useState<IotCollectionId>('a3.iot.collection.esp32');
  const [catalogId, setCatalogId] = useState(IOT_CATALOG.find((entry) => entry.collectionId === collectionId && !entry.template)?.catalogId ?? '');
  const entries = useMemo(() => IOT_CATALOG.filter((entry) => entry.collectionId === collectionId), [collectionId]);
  const selectedEntry = entries.find((entry) => entry.catalogId === catalogId);
  const selected = workspace.entities.find((entity) => entity.id.toLowerCase() === selectedEntityId?.toLowerCase() && isIotComponent(entity));
  const metadata = selected && iotData(selected);
  const ports = selected?.ports as IotPort[] | undefined;
  const disabled = !workspace.canWrite;
  return <details className="iot-inspector" data-iot-inspector>
    <summary>IoT · Catálogo identificado</summary>
    <p>Instancia componentes con fuente y puertos documentados. Los datos desconocidos permanecen marcados; la inserción no crea redes eléctricas ni conexiones.</p>
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
    {selected && metadata && <section className="iot-selected-component" data-iot-selected={selected.id}>
      <h4>{selected.title}</h4><p>{metadata.model} · {metadata.manufacturer.state === 'known' ? metadata.manufacturer.value : 'fabricante desconocido'} · revisión {evidenceText(metadata.revision)}</p>
      <small>Entity ID: {selected.id}</small><PortTable ports={ports ?? []} />
      <small>Fuentes: {metadata.sources.map((source) => `${source.title}${source.documentRevision ? ` (${source.documentRevision})` : ''}`).join(' · ')}</small>
    </section>}
    {disabled && <p role="note">Solo lectura: el broker no concede edición de diagramas a este proyecto.</p>}
  </details>;
}
