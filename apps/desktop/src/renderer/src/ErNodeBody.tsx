import { createContext, useContext } from 'react';
import { erData } from '@a3/domain/er';
import type { CanvasEntitySummary, CanvasErElement } from '../../shared/desktop-api';

export const ErElementsContext = createContext<CanvasErElement[]>([]);
export function ErNodeBody({ entity }: { entity: CanvasEntitySummary }): React.JSX.Element | null {
  if (entity.type !== 'a3.er.table' || entity.typeVersion !== '1.0.0') return null;
  const elements = useContext(ErElementsContext), data = erData(entity);
  if (!data) return null;
  const targetName = (tableId: string, fieldId: string) => {
    const table = elements.find((e) => e.id.toLowerCase() === tableId.toLowerCase());
    const field = table?.data.fields.find((f) => f.id.toLowerCase() === fieldId.toLowerCase());
    return table && field ? `${table.title}.${field.name}` : `${tableId}.${fieldId}`;
  };
  return <section className="er-node" data-er-table-id={entity.id}>
    {data.description && <p>{data.description}</p>}
    <table className="er-fields"><thead><tr><th>Campo</th><th>Tipo</th><th>Propiedades</th></tr></thead><tbody>
      {data.fields.map((field) => <tr key={field.id} data-er-field-id={field.id}>
        <td>{field.name}</td><td>{field.type}</td><td>{[field.primaryKey && 'PK', field.foreignKey && `FK → ${targetName(field.foreignKey.tableId, field.foreignKey.fieldId)}`, field.unique && 'UNIQUE', field.nullable ? 'NULL' : 'NOT NULL'].filter(Boolean).join(' · ')}</td>
      </tr>)}
    </tbody></table>
  </section>;
}
