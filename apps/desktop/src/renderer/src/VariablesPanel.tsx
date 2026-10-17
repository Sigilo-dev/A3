import { useEffect, useRef, useState } from 'react';
import type { ProjectVariablesState, VariablesQuery } from '@a3/project-store';
import type { JsonValue, Variable, VariableScope, VariableSelectorScope, ValueType } from '@a3/domain';
import type { VariablesRequest } from '../../shared/variables';
import type { LocalProjectSession } from '../../shared/desktop-api';

const scopeLabel = (scope: VariableSelectorScope): string => scope.kind === 'execution' ? 'ejecución temporal' : `${scope.kind === 'project' ? 'proyecto' : scope.kind === 'workspace' ? 'workspace' : 'entidad'} · ${scope.ownerId}`;
const types: ValueType[] = ['string', 'number', 'boolean', 'enum', 'list', 'reference'];
export function VariablesPanel({ project, onChanged }: { project: LocalProjectSession | null; onChanged(): void }): React.JSX.Element {
  const [state, setState] = useState<ProjectVariablesState | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [workspaceId, setWorkspace] = useState(''), [entityId, setEntity] = useState(''), [scope, setScope] = useState<VariableScope['kind'] | 'execution'>('project');
  const [referenceMode, setReferenceMode] = useState('context'), [executions, setExecutions] = useState<Variable[]>([]);
  const [name, setName] = useState(''), [type, setType] = useState<ValueType>('string'), [sourceMode, setSourceMode] = useState('literal'), [raw, setRaw] = useState('');
  const [options, setOptions] = useState(''), [itemType, setItemType] = useState<ValueType>('string'), [referenceKind, setReferenceKind] = useState<'entity' | 'resource'>('entity');
  const [bindingName, setBindingName] = useState('');
  const [aliasScope, setAliasScope] = useState<VariableSelectorScope | undefined>(), [keepAliasScope, setKeepAliasScope] = useState(false);
  const loadGeneration = useRef(0);
  const ownerId = scope === 'project' ? state?.projectId : scope === 'workspace' ? workspaceId : entityId;
  const currentScope: VariableScope | null = scope === 'execution' || !ownerId ? null : { kind: scope, ownerId };
  const set = state?.sets.find((set) => set.scope.kind === scope && set.scope.ownerId.toLowerCase() === ownerId?.toLowerCase());
  const ownVariables = scope === 'execution' ? executions : set?.variables ?? [];
  const blocked = state?.blockedScopes.find((entry) => entry.scope.kind === scope && entry.scope.ownerId.toLowerCase() === ownerId?.toLowerCase());
  function explicitScope(): VariableSelectorScope | undefined {
    if (referenceMode === 'execution') return { kind: 'execution' };
    const id = referenceMode === 'project' ? state?.projectId ?? project?.projectId : referenceMode === 'workspace' ? workspaceId : entityId;
    return referenceMode !== 'context' && id ? { kind: referenceMode as VariableScope['kind'], ownerId: id } : undefined;
  }
  function query(executionVariables = executions): VariablesQuery {
    const selected = explicitScope(); return { ...(workspaceId ? { workspaceId } : {}), ...(entityId ? { entityId } : {}),
      ...(executionVariables.length ? { executionVariables } : {}), ...(selected ? { referenceScope: selected } : {}) };
  }
  async function call(request: VariablesRequest): Promise<ProjectVariablesState> {
    const result = await window.a3?.variables(request); if (!result) throw new Error('El puente local no está disponible.');
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
    if (!('sets' in result.value)) throw new Error('La operación no devolvió el estado de variables.'); return result.value;
  }
  async function load(): Promise<void> {
    if (!project) return; const generation = ++loadGeneration.current;
    try { const next = await call({ action: 'load', sessionId: project.sessionId, query: query() }); if (generation === loadGeneration.current) setState(next); }
    catch (e) { if (generation === loadGeneration.current) setError(e instanceof Error ? e.message : 'No se cargaron las variables.'); }
  }
  useEffect(() => { setError(''); void load(); return () => { loadGeneration.current++; }; }, [project?.sessionId, workspaceId, entityId, referenceMode]);
  async function persist(variables: Variable[]): Promise<void> {
    if (!project || busy) return; setBusy(true); setError(''); setMessage(''); loadGeneration.current++;
    try {
      if (scope === 'execution') {
        const next = await call({ action: 'load', sessionId: project.sessionId, query: query(variables) });
        const invalid = [...next.executionDiagnostics, ...next.effective.flatMap((entry) => entry.result.ok ? [] : entry.result.diagnostics)].filter((d) => !['variable-missing', 'variable-context-required'].includes(d.detail));
        if (invalid.length) throw new Error(invalid.map((d) => d.message).join('\n'));
        setExecutions(variables); setState(next); setMessage('Aplicado solo a la ejecución de prueba; no se ha escrito en disco.');
      } else {
        if (!currentScope) throw new Error('Selecciona el propietario del ámbito.');
        setState(await call({ action: 'set', sessionId: project.sessionId, input: { scope: currentScope, variables, expectedRevision: set?.revision ?? null }, query: query() }));
        setMessage('Ámbito guardado por el escritor del proyecto.'); onChanged();
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'No se guardó la variable.'); }
    finally { setBusy(false); }
  }
  function edit(variable: Variable): void {
    if (set?.schemaVersion === '1.0.0' && variable.source.kind === 'reference' && Object.hasOwn(variable.source, 'scope')) { setError('El campo scope opaco de E1 requiere revisión en el editor fuente antes de adoptar 1.1.0.'); return; }
    if (variable.items && !['string', 'number', 'boolean', 'reference'].includes(variable.items.valueType)) { setError('Esta lista compuesta se conserva. Edita su declaración JSON con el editor fuente; el formulario no la simplifica.'); return; }
    setName(variable.name); setType(variable.valueType); setSourceMode(variable.source.kind); setOptions(variable.enumValues?.join('\n') ?? '');
    setItemType(variable.items?.valueType ?? 'string'); setReferenceKind(variable.referenceKinds?.[0] ?? 'entity');
    setRaw(variable.source.kind === 'reference' ? variable.source.name : variable.valueType === 'string' || variable.valueType === 'enum' ? String(variable.source.value) : variable.valueType === 'reference' && typeof variable.source.value === 'object' && variable.source.value && 'id' in variable.source.value ? String(variable.source.value.id) : JSON.stringify(variable.source.value));
    setAliasScope(variable.source.kind === 'reference' ? variable.source.scope : undefined); setKeepAliasScope(variable.source.kind === 'reference');
  }
  async function saveVariable(): Promise<void> {
    try {
      const old = ownVariables.find((v) => v.name === name), previous = old ? structuredClone(old) : {};
      if (old?.valueType !== type) for (const key of ['enumValues', 'items', 'referenceKinds', 'minimum', 'maximum']) delete (previous as Record<string, unknown>)[key];
      const value: JsonValue = sourceMode === 'reference' ? null : type === 'reference' ? { kind: referenceKind, id: raw } : type === 'string' || type === 'enum' ? raw : JSON.parse(raw);
      const targetScope = keepAliasScope ? aliasScope : explicitScope();
      const variable: Variable = { ...previous, name, valueType: type,
        ...(type === 'enum' ? { enumValues: options.split('\n').map((v) => v.trim()).filter(Boolean) } : {}),
        ...(type === 'list' ? { items: { ...(old?.items?.valueType === itemType ? old.items : {}), valueType: itemType, ...(itemType === 'reference' ? { referenceKinds: [referenceKind] } : {}) } } : {}),
        ...(type === 'reference' ? { referenceKinds: [referenceKind] } : {}),
        source: sourceMode === 'reference' ? { kind: 'reference', name: raw, ...(targetScope ? { scope: targetScope } : {}) } : { kind: 'literal', value } };
      await persist([...ownVariables.filter((v) => v.name !== name), variable]);
    } catch { setError('Valor inválido: usa JSON para number/boolean/list; las referencias requieren un ID existente.'); }
  }
  async function bind(field: string, remove = false): Promise<void> {
    if (!project || busy) return; const entity = state?.entities.find((e) => e.id === entityId); if (!entity) return;
    setBusy(true); setError(''); loadGeneration.current++;
    try { setState(await call({ action: 'bind', sessionId: project.sessionId, entityId, expectedRevision: entity.revision, field,
      binding: remove ? null : { kind: 'variable', name: bindingName, ...(explicitScope() ? { scope: explicitScope()! } : {}) }, query: query() })); onChanged(); setMessage('Binding guardado. El contenido fuente y los IDs no cambian.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se aplicó el binding.'); } finally { setBusy(false); }
  }
  if (!project) return <p>Abre un proyecto para trabajar con sus variables.</p>;
  return <section className="variables-panel" aria-labelledby="variables-title"><h1 id="variables-title">Variables</h1>
    <p>Valores tipados por proyecto. Ejecución → entidad → workspace → proyecto. No guardes contraseñas, tokens ni claves aquí.</p>
    <div className="variables-context"><label>Workspace de resolución<select data-variable-workspace value={workspaceId} disabled={busy} onChange={(e) => setWorkspace(e.target.value)}><option value="">Sin workspace explícito</option>{state?.workspaces.map((ws) => <option key={ws.id} value={ws.id}>{ws.name}</option>)}</select></label>
      <label>Entidad de resolución<select data-variable-entity value={entityId} disabled={busy} onChange={(e) => setEntity(e.target.value)}><option value="">Sin entidad</option>{state?.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.title} · {entity.id}</option>)}</select></label>
      <label>Referencia explícita / inspector<select data-variable-reference-scope value={referenceMode} disabled={busy} onChange={(e) => setReferenceMode(e.target.value)}><option value="context">Precedencia del contexto</option><option value="project">Proyecto explícito</option><option value="workspace" disabled={!workspaceId}>Workspace explícito</option><option value="entity" disabled={!entityId}>Entidad explícita</option><option value="execution">Ejecución explícita</option></select></label>
      <button className="secondary" disabled={busy} onClick={() => void load()}>Recargar valores para comparar</button></div>
    {error && <p role="alert" className="error" data-variable-error>{error}</p>}{message && <p role="status">{message}</p>}
    <h2>Valor y ámbito efectivo</h2><table data-variable-effective><thead><tr><th>Variable</th><th>Tipo</th><th>Valor / diagnóstico</th><th>Ámbito efectivo</th></tr></thead><tbody>{state?.effective.map(({ name, result }) => <tr key={name} data-variable-name={name}><th><code>{`{{${name}}}`}</code></th><td>{result.ok ? result.value.valueType : 'Sin resolver'}</td><td><code>{result.ok ? JSON.stringify(result.value.value) : result.diagnostics.map((d) => `${d.detail}: ${d.message}`).join(' ')}</code></td><td>{result.ok ? scopeLabel(result.value.scope) : 'Selecciona o corrige el contexto'}{result.ok && result.value.dependencies.length > 0 && <small> · depende de {result.value.dependencies.map((d) => d.name + ' (' + scopeLabel(d.scope) + ')').join(', ')}</small>}</td></tr>)}</tbody></table>
    <h2>Editar una declaración</h2><label>Guardar en ámbito<select data-variable-edit-scope value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="project">Proyecto</option><option value="workspace" disabled={!workspaceId}>Workspace seleccionado</option><option value="entity" disabled={!entityId}>Entidad seleccionada</option><option value="execution">Ejecución temporal de prueba</option></select></label>
    <p>{scope === 'execution' ? 'Se descarta al cerrar el panel o cambiar de proyecto. No es una ejecución de IA.' : `Revisión del ámbito: ${set?.revision ?? 'nuevo'}.`}</p>
    {blocked && <p className="error" role="alert">Ámbito en solo lectura: {blocked.diagnostics.join(' ')}. Sus bytes originales se conservan.</p>}
    <ul className="variables-declarations">{ownVariables.map((variable) => <li key={variable.name}><button className="quiet" onClick={() => edit(variable)}>{variable.name} · {variable.valueType}</button><button className="quiet danger" disabled={busy || scope !== 'execution' && !state?.canEdit} onClick={() => void persist(ownVariables.filter((v) => v.name !== variable.name))}>Quitar declaración {variable.name}</button></li>)}</ul>
    <fieldset className="variables-form" disabled={busy || !!blocked || scope !== 'execution' && !state?.canEdit}><legend>Variable tipada</legend>
      <label>Nombre con namespace<input data-variable-name-input value={name} placeholder="proyecto.nombre" onChange={(e) => setName(e.target.value)} /></label>
      <label>Tipo<select data-variable-type value={type} onChange={(e) => setType(e.target.value as ValueType)}>{types.map((item) => <option key={item}>{item}</option>)}{type === 'json' && <option value="json">json (legado E1)</option>}</select></label>
      <label>Fuente<select data-variable-source value={sourceMode} onChange={(e) => setSourceMode(e.target.value)}><option value="literal">Valor literal</option><option value="reference">Alias de otra variable (nombre)</option></select></label>
      {sourceMode === 'reference' && <label>Ámbito del alias<select value={keepAliasScope ? 'existing' : 'inspector'} onChange={(e) => setKeepAliasScope(e.target.value === 'existing')}><option value="inspector">Usar referencia del inspector</option><option value="existing">Conservar referencia original: {aliasScope ? scopeLabel(aliasScope) : 'precedencia contextual'}</option></select></label>}
      {type === 'enum' && <label>Opciones permitidas (una por línea)<textarea value={options} onChange={(e) => setOptions(e.target.value)} /></label>}
      {type === 'list' && <label>Tipo de cada elemento<select value={itemType} onChange={(e) => setItemType(e.target.value as ValueType)}>{['string', 'number', 'boolean', 'reference'].map((t) => <option key={t}>{t}</option>)}</select></label>}
      {(type === 'reference' || type === 'list' && itemType === 'reference') && <label>Destino por ID<select value={referenceKind} onChange={(e) => setReferenceKind(e.target.value as 'entity' | 'resource')}><option value="entity">Entity</option><option value="resource">Resource</option></select></label>}
      <label>{sourceMode === 'reference' ? 'Nombre de la variable destino' : type === 'reference' ? 'ID del destino' : 'Valor (JSON para number, boolean y list)'}<textarea data-variable-value value={raw} onChange={(e) => setRaw(e.target.value)} /></label>
      {type === 'reference' && sourceMode === 'literal' && <label>Elegir ID<select value={raw} onChange={(e) => setRaw(e.target.value)}><option value="">Selecciona un destino</option>{(referenceKind === 'entity' ? state?.entities.map((e) => ({ id: e.id, label: e.title })) : state?.resources)?.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>)}</select></label>}
      <button className="primary" data-variable-save disabled={!name || scope !== 'execution' && !currentScope} onClick={() => void saveVariable()}>{scope === 'execution' ? 'Aplicar override temporal' : 'Guardar variable en este ámbito'}</button>
    </fieldset>
    {entityId && <section aria-label="Bindings de la entidad"><h2>Campos declarados del nodo</h2><label>Variable a vincular<select data-variable-binding-name value={bindingName} onChange={(e) => setBindingName(e.target.value)}><option value="">Elige variable</option>{state?.effective.map((entry) => <option key={entry.name}>{entry.name}</option>)}</select></label>
      <p>El binding usa el selector de referencia del inspector. Solo afecta el campo declarado; no sustituye palabras ni IDs.</p>
      {!state?.fields.length && <p>El tipo no declara campos compatibles. Se conserva como fallback.</p>}
      {state?.fields.map(({ rule, acceptsBinding, binding, result }) => <div className="variable-field" key={rule.name} data-variable-field={rule.name}><strong>{rule.name} · {rule.valueType}</strong><p>{result.ok ? `${JSON.stringify(result.value.value)} · ${result.value.variable ? scopeLabel(result.value.variable.scope) : 'literal'}` : result.diagnostics.map((d) => d.message).join(' ')}</p>
        {binding && <code>{JSON.stringify(binding)}</code>}<button className="secondary" data-variable-bind disabled={busy || !state.canEdit || !acceptsBinding || !bindingName} onClick={() => void bind(rule.name)}>Vincular campo</button><button className="quiet" disabled={busy || !state.canEdit || !binding} onClick={() => void bind(rule.name, true)}>Quitar binding</button></div>)}
    </section>}
  </section>;
}
