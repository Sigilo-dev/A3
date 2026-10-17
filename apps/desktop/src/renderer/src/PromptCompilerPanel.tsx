import { useEffect, useMemo, useState } from 'react';
import type { PromptTemplate, PromptTemplateCompilationResult, PromptTemplateInput, JsonValue, VariableTextResolution } from '@a3/domain';
import { BUILTIN_PROMPT_TEMPLATES, serializePromptTemplate } from '@a3/domain/prompt-templates';
import type { ProjectVariablesState } from '@a3/project-store';
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

export function PromptCompilerPanel({ project }: { project: LocalProjectSession | null }): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProjectVariablesState | null>(null), [workspaceId, setWorkspaceId] = useState(''), [entityId, setEntityId] = useState('');
  const [templateId, setTemplateId] = useState(BUILTIN_PROMPT_TEMPLATES[0]!.id), [body, setBody] = useState(BUILTIN_PROMPT_TEMPLATES[0]!.markdown);
  const [inputs, setInputs] = useState<Record<string, JsonValue>>(() => defaultInputs(BUILTIN_PROMPT_TEMPLATES[0]!)), [manualSource, setManualSource] = useState(manualTemplate), [required, setRequired] = useState('proyecto.nombre');
  const [result, setResult] = useState<PromptTemplateCompilationResult | VariableTextResolution | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const selected = useMemo(() => BUILTIN_PROMPT_TEMPLATES.find((item) => item.id === templateId) ?? null, [templateId]);
  useEffect(() => {
    let live = true; setResult(null); setError(''); setStatus(''); setCatalog(null); setWorkspaceId(''); setEntityId('');
    if (project) void window.a3?.variables({ action: 'load', sessionId: project.sessionId, query: {} }).then((response) => {
      if (!live) return; if (!response?.ok || !('sets' in response.value)) setError(response && !response.ok ? response.error.message : 'No se cargó el contexto del proyecto.');
      else setCatalog(response.value);
    }).catch(() => { if (live) setError('No se pudo cargar el contexto del proyecto.'); });
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
    const request: VariablesRequest = selected ? {
      action: 'compile-template', sessionId: project.sessionId, templateSource: serializePromptTemplate({ ...selected, markdown: body }), inputs, query
    } : {
      action: 'compile', sessionId: project.sessionId, source: manualSource,
      requiredNames: required.split(/\r?\n/).map((name) => name.trim()).filter(Boolean), query
    };
    try {
      const response = await window.a3?.variables(request); if (!response) throw new Error('El puente local no está disponible.');
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      if ('sets' in response.value) throw new Error('La compilación no devolvió una vista compilada.'); setResult(response.value);
      const diagnostics = 'templateDiagnostics' in response.value ? response.value.templateDiagnostics.length : 0;
      setStatus(diagnostics ? 'La plantilla tiene errores y no se compiló.' : response.value.unresolved.length ? 'Vista compilada con marcadores de resolución.' : 'Plantilla compilada en una vista derivada.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo compilar la plantilla.'); }
    finally { setBusy(false); }
  }
  async function copyOutput(): Promise<void> {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.markedExport); setStatus('Resultado exportable copiado.'); }
    catch { setError('El portapapeles no está disponible; selecciona el resultado para copiarlo.'); }
  }
  function downloadOutput(): void {
    if (!result) return; const url = URL.createObjectURL(new Blob([result.markedExport], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'a3-prompt-preview.md'; link.click(); URL.revokeObjectURL(url); setStatus('Vista exportada a Markdown.');
  }
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
    <p className="eyebrow">Markdown · variables A3 · bloques seguros</p><h1 id="prompt-compiler-title">Plantillas de prompts</h1>
    {!project && <p>Abre un proyecto local para compilar referencias.</p>}
    {project && <>
      <p className="lead">Las plantillas usan un subconjunto de Handlebars registrado por A3: <code>{'{{#if ...}}'}</code>, <code>{'{{#each ...}}'}</code> y helpers de texto/JSON. No ejecutan JavaScript ni leen archivos. La compilación solo produce una vista para copiar o exportar; no envía nada a un agente.</p>
      <div className="variables-context"><label>Ejemplo de plantilla<select aria-label="Ejemplo de plantilla" value={templateId} onChange={(event) => selectTemplate(event.currentTarget.value)}><option value="manual">Plantilla manual (solo variables A3)</option>{BUILTIN_PROMPT_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Workspace<select aria-label="Contexto workspace" disabled={!catalog} value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)}><option value="">Sin workspace</option>{catalog?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Entidad<select aria-label="Contexto entidad" disabled={!catalog} value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)}><option value="">Sin entidad</option>{catalog?.entities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      {selected && <section className="prompt-template-meta" aria-label="Definición de plantilla"><h2>{selected.name}</h2><p>{selected.objective}</p><p>{selected.descriptionMarkdown}</p><p>Formato: {selected.outputFormat}. Variables obligatorias: {selected.requiredVariables.join(', ') || 'ninguna'}.</p>
        <p>Selección de contexto declarada (todavía no se recopila automáticamente): {selected.contextSelection.map((rule) => rule.description).join(' · ') || 'ninguna'}.</p>
        <div className="prompt-inputs">{selected.inputs.map(renderInput)}</div>
      </section>}
      {selected ? <label>Contenido Markdown y Handlebars permitido<textarea className="prompt-source" aria-label="Contenido Markdown de la plantilla" rows={14} value={body} onChange={(event) => { setBody(event.currentTarget.value); setResult(null); }} /></label> : <>
        <label>Plantilla Markdown<textarea className="prompt-source" aria-label="Plantilla Markdown" rows={12} value={manualSource} onChange={(event) => setManualSource(event.currentTarget.value)} /></label>
        <label>Variables obligatorias, una por línea<textarea aria-label="Variables obligatorias" rows={3} value={required} onChange={(event) => setRequired(event.currentTarget.value)} /></label>
      </>}
      <button className="primary" disabled={busy || !catalog} onClick={() => void compile()}>{busy ? 'Compilando…' : 'Previsualizar compilación'}</button>
      {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
      {result && <section className="prompt-result" aria-label="Resultado compilado" data-auto-send-allowed={result.canSendAutomatically}>
        <h2>Resultado derivado</h2><p role="status">{result.canSendAutomatically ? 'No hay variables obligatorias sin resolver.' : 'Uso automático bloqueado: corrige entradas, sintaxis o variables obligatorias.'}</p>
        {'templateDiagnostics' in result && result.templateDiagnostics.length > 0 && <ul aria-label="Diagnósticos de plantilla">{result.templateDiagnostics.map((item, index) => <li key={`${item.detail}:${item.offset ?? index}`}>Línea {item.line ?? '—'}, columna {item.column ?? '—'} · {item.detail}: {item.message}</li>)}</ul>}
        {result.unresolved.length > 0 && <ul aria-label="Diagnósticos de variables">{result.unresolved.map((item, index) => <li key={`${item.name ?? 'template'}:${item.offset ?? 'required'}:${index}`}>{item.name ?? 'Plantilla'} · línea {item.line ?? '—'}, columna {item.column ?? '—'} · {item.detail}: {item.message}</li>)}</ul>}
        <p>Variables incluidas: {result.variables.map((item) => `${item.name} (${item.scope.kind}${item.scope.kind === 'execution' ? '' : `:${item.scope.ownerId}`})`).join(', ') || 'ninguna'}.</p>
        {'helpersUsed' in result && <p>Helpers usados: {result.helpersUsed.join(', ') || 'ninguno'}.</p>}
        <label>Vista previa exportable<textarea aria-label="Vista previa exportable" rows={14} readOnly value={result.markedExport} /></label>
        <div className="prompt-actions"><button className="secondary" onClick={() => void copyOutput()}>Copiar resultado</button><button className="secondary" onClick={downloadOutput}>Exportar Markdown</button></div>
      </section>}
    </>}
  </section>;
}
