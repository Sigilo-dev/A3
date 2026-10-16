// Fixture-only symbolic keys are resolved to canonical IDs before issuing commands.
export function elementData(entry, ids) {
  const data = structuredClone(entry.data);
  if (entry.parent) data.parentId = ids[entry.parent];
  const resolve = (type) => { if (type.ref) { type.entityId = ids[type.ref]; delete type.ref; } };
  data.attributes?.forEach((a) => resolve(a.type));
  data.methods?.forEach((m) => { resolve(m.returnType); m.parameters.forEach((p) => resolve(p.type)); });
  return data;
}
export function relationshipData(entry) {
  return { label: entry.label, stereotypes: [], constraints: [],
    source: { role: entry.sourceRole ?? '', multiplicity: { lower: 0, upper: entry.sourceUpper ?? 1 }, navigable: false },
    target: { role: entry.targetRole ?? '', multiplicity: { lower: 1, upper: entry.targetUpper ?? 1 }, navigable: entry.kind === 'association' } };
}
