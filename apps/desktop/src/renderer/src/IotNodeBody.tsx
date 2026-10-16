import { isIotComponent, iotData, type IotKnown, type IotPort } from '@a3/domain/iot';
import { iotCircuitData, isIotCircuit } from '@a3/domain/iot-circuit';
import type { CanvasEntitySummary } from '../../shared/desktop-api';

function evidenceText(value: IotKnown<unknown>): string { return value.state === 'known' ? JSON.stringify(value.value) : `Desconocido: ${value.reason}`; }
function limitsText(limits: IotPort['limits']): string { return Object.entries(limits).map(([name, value]) => `${name}: ${evidenceText(value)}`).join(' · '); }
export function IotNodeBody({ entity }: { entity: CanvasEntitySummary }): React.JSX.Element | null {
  if (isIotCircuit(entity)) {
    const circuit = iotCircuitData(entity);
    return circuit ? <section className="iot-node" data-iot-circuit-node>
      <strong>Modelo eléctrico A3 · {circuit.instances.length} instancias</strong>
      <span>{circuit.nets.length} redes · {circuit.nets.reduce((count, net) => count + net.junctions.length, 0)} uniones</span>
      <small>Las redes se guardan por IDs de instancia y pin; este nodo no representa una simulación.</small>
    </section> : null;
  }
  if (!isIotComponent(entity)) return null;
  const component = iotData(entity);
  if (!component) return null;
  const ports = entity.ports as IotPort[];
  return <section className="iot-node" data-iot-component={component.catalogId}>
    <strong>{component.model}</strong><span>{component.manufacturer.state === 'known' ? component.manufacturer.value : 'Fabricante desconocido'} · revisión: {evidenceText(component.revision)}</span>
    <details><summary>Puertos documentados ({ports.length})</summary><ul>{ports.map((port) => <li key={port.id} data-iot-port-id={port.id}>
      <code>{port.id}</code> · {port.label} · {port.direction} · {port.function}<small>Señal: {evidenceText(port.signalType)} · bus: {evidenceText(port.bus)} · límites: {limitsText(port.limits)}</small>
    </li>)}</ul></details>
    <small>Fuente: {component.sources.map((source) => `${source.title}${source.documentRevision ? ` (${source.documentRevision})` : ''}`).join(' · ')}</small>
    <small>Las líneas del lienzo siguen siendo visuales; las conexiones eléctricas se guardan en un modelo de circuito separado.</small>
  </section>;
}
