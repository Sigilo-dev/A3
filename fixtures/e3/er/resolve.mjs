export function resolvedTableData(table, ids, scenario) {
  return { description: table.description ?? '', fields: table.fields.map((field) => ({ id: field.id, name: field.name, type: field.type,
    nullable: field.nullable, primaryKey: field.primaryKey, unique: field.unique,
    ...(field.foreignTable ? { foreignKey: { tableId: ids[field.foreignTable], fieldId: scenario.tables.find((item) => item.key === field.foreignTable).fields.find((item) => item.key === field.foreignField).id } } : {})
  })) };
}
export function relationshipData(relationship) {
  return { label: relationship.label, sourceCardinality: relationship.sourceCardinality, targetCardinality: relationship.targetCardinality, identifying: relationship.identifying };
}
