import { createContext, useContext } from 'react';
import { umlData, umlKind, umlVisibilitySymbol, type UmlType } from '@a3/domain/uml';
import type { CanvasEntitySummary, CanvasUmlElement } from '../../shared/desktop-api';

export const UmlElementsContext = createContext<CanvasUmlElement[]>([]);
export function UmlNodeBody({ entity }: { entity: CanvasEntitySummary }): React.JSX.Element | null {
  const elements = useContext(UmlElementsContext), kind = umlKind(entity), data = umlData(entity);
  if (!kind || !data) return null;
  const title = (id: string | undefined) => elements.find((e) => e.id.toLowerCase() === id?.toLowerCase())?.title;
  const type = (value: UmlType) => value.entityId ? title(value.entityId) ?? value.name : value.name;
  return <section className="uml-node" data-uml-kind={kind} data-uml-parent={data.parentId}>
    <div className="uml-compartment"><small>«{kind}» {data.stereotypes.map((s) => `«${s}»`).join(' ')}</small>
      <div className={data.abstract ? 'uml-abstract' : ''}>{umlVisibilitySymbol(data.visibility)} {entity.title}{data.abstract ? ' {abstract}' : ''}</div>
      {data.parentId && <small>Paquete: {title(data.parentId) ?? data.parentId}</small>}
    </div>
    {kind !== 'package' && <>
      <div className="uml-compartment" aria-label="Atributos UML">{data.attributes.map((a) => <div key={a.id} className={a.static ? 'uml-static' : ''}>
        {umlVisibilitySymbol(a.visibility)} {a.name}: {type(a.type)}{a.defaultValue ? ` = ${a.defaultValue}` : ''}{a.readOnly ? ' {readOnly}' : ''}
      </div>)}</div>
      <div className="uml-compartment" aria-label="Métodos UML">{data.methods.map((m) => <div key={m.id} className={`${m.static ? 'uml-static' : ''} ${m.abstract ? 'uml-abstract' : ''}`}>
        {umlVisibilitySymbol(m.visibility)} {m.name}({m.parameters.map((p) => `${p.direction} ${p.name}: ${type(p.type)}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`).join(', ')}): {type(m.returnType)}
      </div>)}</div>
    </>}
    {kind === 'enum' && <div className="uml-compartment" aria-label="Literales UML">{data.literals.map((l) => <div key={l.id}>{l.name}{l.value ? ` = ${l.value}` : ''}</div>)}</div>}
    {data.constraints.map((c, i) => <div key={i}>{`{${c}}`}</div>)}
    {data.description && <p>{data.description}</p>}
  </section>;
}
