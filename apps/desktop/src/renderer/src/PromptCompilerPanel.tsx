import { useEffect, useMemo, useState } from 'react';
import type { PromptTemplate, PromptTemplateInput, JsonValue } from '@a3/domain';
import { BUILTIN_PROMPT_TEMPLATES, serializePromptTemplate } from '@a3/domain/prompt-templates';
import type { ProjectVariablesState, ProjectPromptContextResult, PromptContextCatalog, PromptContextEntityRole, PromptContextSelection } from '@a3/project-store';
import type { VariablesRequest } from '../../shared/variables';
import type { LocalProjectSession } from '../../shared/desktop-api';

const manualTemplate = '# {{proyecto.nombre}}\n\nDescribe el objetivo usando {{tecnologia.backend}}.';
const emptyInputs = (): Record<string, JsonValue> => ({});
function defaultInputs(template: PromptTemplate): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const item of template.inputs) if (item.valueType === 'boolean') values[item.name] = false; else if (item.valueType === 'list') values[item.name] = [];
  return values;
}
function inputText(value: JsonValue | undefined): string { return Array.isArray(value) ? value.map((entry) => String(entry)).join('\n') : value === undefined ? '' : String(value); }

export function PromptCompilerPanel({ project, onOpenChat }: { project: LocalProjectSession | null; onOpenChat: () => void }): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProjectVariablesState | null>(null), [contextCatalog, setContextCatalog] = useState<PromptContextCatalog | null>(null), [workspaceId, setWorkspaceId] = useState(''), [entityId, setEntityId] = useState('');
  const [templateId, setTemplateId] = useState(BUILTIN_PROMPT_TEMPLATES[0]!.id), [body, setBody] = useState(BUILTIN_PROMPT_TEMPLATES[0]!.markdown);
  const [inputs, setInputs] = useState<Record<string, JsonValue>>(() => defaultInputs(BUILTIN_PROMPT_TEMPLATES[0]!)), [manualSource, setManualSource] = useState(manualTemplate), [required, setRequired] = useState('proyecto.nombre');
  const [entityRoles, setEntityRoles] = useState<Record<string, PromptContextEntityRole>>({}), [resourceIds, setResourceIds] = useState<string[]>([]), [relationIds, setRelationIds] = useState<string[]>([]);
  const [maxBytes, setMaxBytes] = useState(64 * 1024), [split, setSplit] = useState(false), [partIndex, setPartIndex] = useState(0);
  const [result, setResult] = useState<ProjectPromptContextResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const selected = useMemo(() => BUILTIN_PROMPT_TEMPLATES.find((item) => item.id === templateId) ?? null, [templateId]);
  useEffect(() => {
    let live = true; setResult(null); setError(''); setStatus(''); setCatalog(null); setContextCatalog(null); setWorkspaceId(''); setEntityId('');
    setEntityRoles({}); setResourceIds([]); setRelationIds([]); setPartIndex(0);
    if (project) void window.a3?.variables({ action: 'load', sessionId: project.sessionId, query: {} }).then((response) => {
      if (!live) return; if (!response?.ok || !('sets' in response.value)) setError(response && !response.ok ? response.error.message : 'No se cargó el contexto del proyecto.');
      else setCatalog(response.value);
    }).catch(() => { if (live) setError('No se pudo cargar el contexto del proyecto.'); });
    if (project) void window.a3?.variables({ action: 'context-catalog', sessionId: project.sessionId }).then((response) => {
      if (!live) return; if (!response?.ok || !('visualEdgeCount' in response.value)) setError(response && !response.ok ? response.error.message : 'No se cargó el catálogo de contexto.');
      else setContextCatalog(response.value);
    }).catch(() => { if (live) setError('No se pudo cargar el catálogo de contexto.'); });
    return () => { live = false; };
  }, [project?.sessionId]);

  function selectTemplate(next: string): void {
    setTemplateId(next); setResult(null); setStatus(''); setError('');
    const choice = BUILTIN_PROMPT_TEMPLATES.find((item) => item.id === next);
    if (choice) { setBody(choice.markdown); setInputs(defaultInputs(choice)); } else setInputs(emptyInputs());
  }
  function setInputValue(definition: PromptTemplateInput, raw: string | boolean): void {
    let value: JsonValue;
    if (definition.valueType === 'boolean') value = Boolean(raw);
    else if (definition.valueType === 'number') value = raw === '' ? '' : Number(raw);
    else if (definition.valueType === 'list') value = String(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    else value = String(raw);
    setInputs((previous) => ({ ...previous, [definition.name]: value })); setResult(null);
  }

  async function compile(): Promise<void> {
    if (!project || busy) return; setBusy(true); setError(''); setStatus('');
    const query = { ...(workspaceId ? { workspaceId } : {}), ...(entityId ? { entityId } : {}) };
    const selection: PromptContextSelection = { entities: Object.entries(entityRoles).map(([entityId, role]) => ({ entityId, role })), resourceIds, relationIds, excludedSourceKeys: [] };
    const request: VariablesRequest = { action: 'compile-context', sessionId: project.sessionId, input: {
      mode: selected ? 'template' : 'manual', source: selected ? serializePromptTemplate({ ...selected, markdown: body }) : manualSource, inputs,
      requiredNames: required.split(/\r?\n/).map((name) => name.trim()).filter(Boolean), query, selection, maxBytes, split
    } };
    try {
      const response = await window.a3?.variables(request); if (!response) throw new Error('El puente local no está disponible.');
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      if (!('parts' in response.value)) throw new Error('La compilación no devolvió el manifiesto de contexto.'); setResult(response.value); setPartIndex(0);
      const diagnostics = response.value.templateDiagnostics.length;
      setStatus(diagnostics ? 'La plantilla tiene errores; el manifiesto conserva las fuentes y diagnósticos.' : response.value.omitted.length ? 'Contexto compilado con fuentes omitidas visibles en el manifiesto.' : 'Contexto compilado localmente; origen y hashes guardados en el registro del proyecto.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo compilar la plantilla.'); }
    finally { setBusy(false); }
  }
  async function copyOutput(): Promise<void> {
    if (!result || !result.parts[partIndex]) return;
    try {
      if (!project || !window.a3) throw new Error();
      const copied = await window.a3.manualChat({ action: 'copy-text', sessionId: project.sessionId, text: result.parts[partIndex]!.markdown });
      if (!copied.ok) throw new Error(copied.error.message);
      setStatus(`Parte ${partIndex + 1} copiada como Markdown. Pégala y envíala manualmente en Chat web; no inicia un agente.`);
    }
    catch { setError('El portapapeles no está disponible; selecciona el resultado para copiarlo.'); }
  }
  function downloadOutput(): void {
    if (!result || !result.parts[partIndex]) return; const url = URL.createObjectURL(new Blob([result.parts[partIndex]!.markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `a3-prompt-context-${partIndex + 1}.md`; link.click(); URL.revokeObjectURL(url); setStatus(`Parte ${partIndex + 1} exportada a Markdown.`);
  }
  function setEntityRole(id: string, value: string): void {
    setEntityRoles((previous) => { const next = { ...previous }; if (!value) delete next[id]; else next[id] = value as PromptContextEntityRole; return next; }); setResult(null);
  }
  function toggleResource(id: string, checked: boolean): void { setResourceIds((previous) => checked ? [...previous, id] : previous.filter((entry) => entry !== id)); setResult(null); }
  function toggleRelation(id: string, checked: boolean): void { setRelationIds((previous) => checked ? [...previous, id] : previous.filter((entry) => entry !== id)); setResult(null); }
  function renderInput(definition: PromptTemplateInput): React.JSX.Element {
    const value = inputs[definition.name]; const common = { id: `prompt-input-${definition.name}`, required: definition.required, 'aria-describedby': `prompt-description-${definition.name}` };
    return <label key={definition.name} htmlFor={common.id}>{definition.label}{definition.required && <span aria-hidden="true"> *</span>}
      {definition.description && <small id={`prompt-description-${definition.name}`}>{definition.description}</small>}
      {definition.valueType === 'boolean' ? <input {...common} type="checkbox" checked={value === true} onChange={(event) => setInputValue(definition, event.currentTarget.checked)} /> :
        definition.valueType === 'enum' ? <select {...common} value={inputText(value)} onChange={(event) => setInputValue(definition, event.currentTarget.value)}><option value="">Selecciona…</option>{definition.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> :
          definition.multiline || definition.valueType === 'list' ? <textarea {...common} rows={definition.valueType === 'list' ? 4 : 6} value={inputText(value)} placeholder={definition.valueType === 'list' ? 'Un elemento por línea' : ''} onChange={(event) => setInputValue(definition, event.currentTarget.value)} /> :
            <input {...common} type={definition.valueType === 'number' ? 'number' : 'text'} value={inputText(value)} onChange={(event) => setInputValue(definition, event.currentTarget.value)} />}
    </label>;
  }

  return <section className="intro prompt-compiler" aria-labelledby="prompt-compiler-title">
    <p className="eyebrow">Markdown · contexto explícito · manifiesto verificable</p><h1 id="prompt-compiler-title">Plantillas y contexto para prompts</h1>
    {!project && <p>Abre un proyecto local para compilar referencias.</p>}
    {project && <>
      <p className="lead">Las plantillas usan bloques Handlebars limitados y no ejecutan código. El contexto se reúne solo de las fuentes que selecciones; las conexiones visuales no añaden información. A3 muestra el manifiesto, omite fuentes grandes con diagnóstico y nunca las recorta en silencio.</p>
      <div className="variables-context"><label>Ejemplo de plantilla<select aria-label="Ejemplo de plantilla" value={templateId} onChange={(event) => selectTemplate(event.currentTarget.value)}><option value="manual">Plantilla manual (solo variables A3)</option>{BUILTIN_PROMPT_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Workspace<select aria-label="Contexto workspace" disabled={!catalog} value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)}><option value="">Sin workspace</option>{catalog?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Entidad<select aria-label="Contexto entidad" disabled={!catalog} value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)}><option value="">Sin entidad</option>{catalog?.entities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      <fieldset className="prompt-context-selection"><legend>Fuentes elegidas para este contexto</legend>
        <p>Selecciona explícitamente memoria, entidades, requisitos, criterios, recursos y relaciones semánticas. Elegir una entidad también incluye su propio recurso de contenido, si lo tiene. No se sigue la red de relaciones ni se incluyen VisualEdge.</p>
        <label>Presupuesto por parte<select aria-label="Presupuesto de contexto por parte" value={maxBytes} onChange={(event) => { setMaxBytes(Number(event.currentTarget.value)); setResult(null); }}>
          {[16, 32, 64, 128, 256, 512, 1024].map((kib) => <option key={kib} value={kib * 1024}>{kib < 1024 ? `${kib} KiB` : '1 MiB'}</option>)}
        </select></label>
        <label><input type="checkbox" checked={split} onChange={(event) => { setSplit(event.currentTarget.checked); setPartIndex(0); setResult(null); }} /> Dividir fuentes grandes en partes completas</label>
        {split && <small>Las partes repiten la plantilla, tienen su propio límite de bytes y conservan el orden de cada fuente; ninguna sección se descarta sin aparecer en el manifiesto.</small>}
        {!contextCatalog && <p role="status">Cargando catálogo de fuentes…</p>}
        {contextCatalog && <>
          <section aria-label="Entidades seleccionables"><h3>Entidades, requisitos y criterios</h3>
            {contextCatalog.entities.length === 0 ? <p>No hay entidades en el proyecto.</p> : <ul>{contextCatalog.entities.map((item) => <li key={item.id}>
              <span>{item.title} <small>({item.type}, rev. {item.revision})</small></span>
              <label>Incluir como<select aria-label={`Categoría de contexto para ${item.title}`} value={entityRoles[item.id] ?? ''} onChange={(event) => setEntityRole(item.id, event.currentTarget.value)}>
                <option value="">No incluir</option><option value="selection">Selección</option><option value="requirement">Requisito</option><option value="acceptance-criterion">Criterio de aceptación</option>
              </select></label>
              {item.contentResourceId && <small>Incluye contenido propio · resource {item.contentResourceId}</small>}
            </li>)}</ul>}
          </section>
          <section aria-label="Recursos textuales seleccionables"><h3>Memoria y archivos de texto</h3>
            {contextCatalog.resources.length === 0 ? <p>No hay recursos.</p> : <ul>{contextCatalog.resources.map((item) => <li key={item.id}>
              <label><input type="checkbox" disabled={!item.readableAsText} checked={resourceIds.includes(item.id)} onChange={(event) => toggleResource(item.id, event.currentTarget.checked)} />
                {item.category === 'project-memory' ? 'Memoria · ' : ''}{item.label} <small>({item.originPath})</small></label>
              {!item.readableAsText && <small role="note">No se puede incluir: {item.unavailableReason}. No se descargan URLs ni se procesa contenido binario.</small>}
            </li>)}</ul>}
          </section>
          <section aria-label="Relaciones semánticas seleccionables"><h3>Relaciones semánticas</h3>
            {contextCatalog.relations.length === 0 ? <p>No hay relaciones semánticas.</p> : <ul>{contextCatalog.relations.map((item) => <li key={item.id}>
              <label><input type="checkbox" checked={relationIds.includes(item.id)} onChange={(event) => toggleRelation(item.id, event.currentTarget.checked)} />
                {item.type} · {contextCatalog.entities.find((entity) => entity.id === item.sourceEntityId)?.title ?? item.sourceEntityId} → {contextCatalog.entities.find((entity) => entity.id === item.targetEntityId)?.title ?? item.targetEntityId}
              </label><small>Relación {item.id} · rev. {item.revision}. Incluirla no agrega sus extremos.</small>
            </li>)}</ul>}
          </section>
          <p role="note">Se ignoran {contextCatalog.visualEdgeCount} líneas visuales. Solo las relaciones semánticas seleccionadas aparecen en el contexto.</p>
        </>}
      </fieldset>
      {selected && <section className="prompt-template-meta" aria-label="Definición de plantilla"><h2>{selected.name}</h2><p>{selected.objective}</p><p>{selected.descriptionMarkdown}</p><p>Formato: {selected.outputFormat}. Variables obligatorias: {selected.requiredVariables.join(', ') || 'ninguna'}.</p>
        <p>Reglas de contexto sugeridas: {selected.contextSelection.map((rule) => rule.description).join(' · ') || 'ninguna'}. La selección efectiva se define arriba.</p>
        <div className="prompt-inputs">{selected.inputs.map(renderInput)}</div>
      </section>}
      {selected ? <label>Contenido Markdown y Handlebars permitido<textarea className="prompt-source" aria-label="Contenido Markdown de la plantilla" rows={14} value={body} onChange={(event) => { setBody(event.currentTarget.value); setResult(null); }} /></label> : <>
        <label>Plantilla Markdown<textarea className="prompt-source" aria-label="Plantilla Markdown" rows={12} value={manualSource} onChange={(event) => setManualSource(event.currentTarget.value)} /></label>
        <label>Variables obligatorias, una por línea<textarea aria-label="Variables obligatorias" rows={3} value={required} onChange={(event) => setRequired(event.currentTarget.value)} /></label>
      </>}
      <button className="primary" disabled={busy || !catalog || !contextCatalog} onClick={() => void compile()}>{busy ? 'Compilando…' : 'Previsualizar prompt y contexto'}</button>
      {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
      {result && <section className="prompt-result" aria-label="Resultado compilado" data-auto-send-allowed={result.canSendAutomatically}>
        <h2>Preview y manifiesto de contexto</h2><p role="status">{result.canSendAutomatically ? 'No hay variables obligatorias sin resolver ni fuentes elegidas pendientes de revisión.' : 'Uso automático bloqueado: corrige variables/sintaxis, revisa fuentes omitidas o usa las partes manualmente.'}</p>
        <p>Proyecto: {result.projectName} · presupuesto {result.maxBytesPerPart.toLocaleString()} bytes por parte · {result.split ? 'división activada' : 'sin división'} · VisualEdge incluidos: {result.visualEdgesIncluded}.</p>
        <p>Trazabilidad local: {result.traceSaved ? 'guardada' : 'no guardada'} · ID {result.executionId} · <code>{result.tracePath}</code>.</p>
        {'templateDiagnostics' in result && result.templateDiagnostics.length > 0 && <ul aria-label="Diagnósticos de plantilla">{result.templateDiagnostics.map((item, index) => <li key={`${item.detail}:${item.offset ?? index}`}>Línea {item.line ?? '—'}, columna {item.column ?? '—'} · {item.detail}: {item.message}</li>)}</ul>}
        {result.unresolved.length > 0 && <ul aria-label="Diagnósticos de variables">{result.unresolved.map((item, index) => <li key={`${item.name ?? 'template'}:${item.offset ?? 'required'}:${index}`}>{item.name ?? 'Plantilla'} · línea {item.line ?? '—'}, columna {item.column ?? '—'} · {item.detail}: {item.message}</li>)}</ul>}
        <p>Variables incluidas: {result.variables.map((item) => `${item.name} (${item.scope.kind}${item.scope.kind === 'execution' ? '' : `:${item.scope.ownerId}`})`).join(', ') || 'ninguna'}.</p>
        <h3>Fuentes incluidas ({result.included.length})</h3>{result.included.length ? <ul aria-label="Manifiesto de fuentes incluidas">{result.included.map((item) => <li key={item.key}>
          <strong>{item.category}</strong> · {item.label} · {item.kind}:{item.id} · origen <code>{item.originPath}</code> · rev. {item.revision} · SHA-256 <code>{item.sourceHash}</code> · {item.sourceBytes} bytes originales · {item.includedBytes} bytes en contexto · partes {item.parts.join(', ')}
        </li>)}</ul> : <p>No hay fuentes adicionales seleccionadas.</p>}
        <h3>Fuentes omitidas o excluidas ({result.omitted.length})</h3>{result.omitted.length ? <ul aria-label="Manifiesto de fuentes omitidas">{result.omitted.map((item) => <li key={`${item.key}:${item.reason}`}>
          {item.category} · {item.label} · {item.kind}:{item.id} · {item.reason}{item.sourceBytes !== undefined ? ` · ${item.sourceBytes} bytes` : ''}
        </li>)}</ul> : <p>Ninguna.</p>}
        {result.parts.length > 0 ? <>
          {result.parts.length > 1 && <label>Parte<select aria-label="Parte de contexto" value={partIndex} onChange={(event) => setPartIndex(Number(event.currentTarget.value))}>{result.parts.map((part, index) => <option key={part.index} value={index}>Parte {part.index} · {part.bytes.toLocaleString()} bytes · {part.sourceKeys.length} fragmentos</option>)}</select></label>}
          <label>Vista previa Markdown<textarea aria-label="Vista previa exportable" rows={14} readOnly value={result.parts[partIndex]?.markdown ?? ''} /></label>
          <p role="note">Copiar o exportar crea un prompt manual. Abrir ChatGPT no lo pega ni lo envía y no inicia un turno de Codex.</p>
          <div className="prompt-actions"><button className="secondary" onClick={() => void copyOutput()}>Copiar parte</button><button className="secondary" onClick={onOpenChat}>Abrir ChatGPT manual</button><button className="secondary" onClick={downloadOutput}>Exportar parte Markdown</button></div>
        </> : <p role="alert">La plantilla excede el presupuesto por parte. Aumenta el límite o reduce la plantilla; no se ha recortado.</p>}
      </section>}
    </>}
  </section>;
}
