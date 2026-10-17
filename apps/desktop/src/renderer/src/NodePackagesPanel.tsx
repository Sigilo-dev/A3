import { useEffect, useState } from 'react';
import { createDeclarativeNodePackage, validateDeclarativeNodePackage, type DeclarativeNodePackage, type FieldRule, type NodeType, type NodeTypeCollection, type NodeTypeMapping, type ValueType } from '@a3/domain';
import type { LocalProjectSession, NodePackagesRequest, NodePackagesResult } from '../../shared/desktop-api';
import type { ProjectNodePackagesState } from '@a3/project-store';

interface FieldDraft { name: string; valueType: ValueType; required: boolean; acceptsBinding: boolean; defaultValue: string; enumValues: string; }
interface PortDraft { id: string; label: string; direction: 'input' | 'output'; dataType: string; min: string; max: string; }
const emptyField = (): FieldDraft => ({ name: 'campo.nombre', valueType: 'string', required: false, acceptsBinding: false, defaultValue: '', enumValues: '' });
const emptyPort = (): PortDraft => ({ id: 'puerto.entrada', label: '', direction: 'input', dataType: 'a3.data.any', min: '0', max: '' });

function mappings(format: string, targetType: string, fields: string, ports: string): NodeTypeMapping[] {
  if (!format.trim()) return [];
  const fieldMap = fields.trim() ? JSON.parse(fields) as Record<string, string> : {};
  const portMap = ports.trim() ? JSON.parse(ports) as Record<string, string> : {};
  return [{ format: format.trim(), ...(targetType.trim() ? { targetType: targetType.trim() } : {}),
    ...(Object.keys(fieldMap).length ? { fields: fieldMap } : {}), ...(Object.keys(portMap).length ? { ports: portMap } : {}) }];
}

function composePackage(input: {
  packageId: string; packageName: string; version: string; license: string; typeName: string; description: string; collectionId: string; collectionName: string;
  fields: FieldDraft[]; ports: PortDraft[]; icon: string; background: string; foreground: string; borderColor: string; borderStyle: 'solid' | 'dashed' | 'dotted'; width: string;
  importFormat: string; importTarget: string; importFields: string; importPorts: string; exportFormat: string; exportTarget: string; exportFields: string; exportPorts: string;
}): DeclarativeNodePackage {
  const namespace = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
  if (![input.packageId, input.typeName, input.collectionId].every((value) => namespace.test(value))) throw new Error('Los IDs de paquete, tipo y colección deben ser namespaces en minúsculas, como comunidad.sensores.');
  const fields: FieldRule[] = input.fields.map((draft) => {
    const spec: FieldRule = { name: draft.name, valueType: draft.valueType, required: draft.required, acceptsBinding: draft.acceptsBinding };
    if (draft.valueType === 'enum') spec.enumValues = draft.enumValues.split(',').map((value) => value.trim()).filter(Boolean);
    if (draft.valueType === 'list') spec.items = { valueType: 'string' };
    if (draft.valueType === 'reference') spec.referenceKinds = ['entity', 'resource'];
    if (draft.defaultValue.trim()) spec.defaultValue = JSON.parse(draft.defaultValue);
    return spec;
  });
  const ports: NodeType['ports'] = input.ports.map((draft) => ({ id: draft.id, ...(draft.label.trim() ? { label: draft.label.trim() } : {}), direction: draft.direction,
    ...(draft.dataType.trim() ? { dataType: draft.dataType.trim() } : {}), multiplicity: { min: Number(draft.min), max: draft.max.trim() ? Number(draft.max) : null } }));
  const nodeType: NodeType = { name: input.typeName, version: input.version, packageId: input.packageId, ...(input.description.trim() ? { description: input.description.trim() } : {}),
    fields, ports, bindingFields: fields.filter((field) => field.acceptsBinding).map((field) => field.name),
    style: { ...(input.icon.trim() ? { icon: input.icon.trim() } : {}), ...(input.background ? { background: input.background } : {}),
      ...(input.foreground ? { foreground: input.foreground } : {}), ...(input.borderColor ? { borderColor: input.borderColor } : {}),
      borderStyle: input.borderStyle, ...(input.width.trim() ? { width: Number(input.width) } : {}) },
    importMappings: mappings(input.importFormat, input.importTarget, input.importFields, input.importPorts),
    exportMappings: mappings(input.exportFormat, input.exportTarget, input.exportFields, input.exportPorts), extensions: {} };
  const collection: NodeTypeCollection = { id: input.collectionId, name: input.collectionName, typeRefs: [{ name: nodeType.name, version: nodeType.version }] };
  const types = [nodeType], collections = [collection];
  return createDeclarativeNodePackage({ id: input.packageId, name: input.packageName, version: input.version, license: input.license,
    a3ApiVersion: '1.0.0', nodeTypes: types, collections });
}

async function call(request: NodePackagesRequest): Promise<ProjectNodePackagesState> {
  const result: NodePackagesResult | undefined = await window.a3?.nodePackages(request);
  if (!result) throw new Error('El puente local de paquetes no está disponible.');
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
  return result.value;
}

export function NodePackagesPanel({ project }: { project: LocalProjectSession | null }): React.JSX.Element {
  const [state, setState] = useState<ProjectNodePackagesState | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [packageId, setPackageId] = useState('comunidad.mi-paquete'), [packageName, setPackageName] = useState('Mi paquete de nodos'), [version, setVersion] = useState('1.0.0'), [license, setLicense] = useState('MIT');
  const [typeName, setTypeName] = useState('comunidad.mi-paquete.mi-nodo'), [description, setDescription] = useState(''), [collectionId, setCollectionId] = useState('comunidad.mi-paquete.nodos'), [collectionName, setCollectionName] = useState('Mis nodos');
  const [fields, setFields] = useState<FieldDraft[]>([emptyField()]), [ports, setPorts] = useState<PortDraft[]>([emptyPort()]);
  const [preview, setPreview] = useState<{ value: DeclarativeNodePackage; diagnostics: string[]; source: 'form' | 'import' } | null>(null);
  const [icon, setIcon] = useState(''), [background, setBackground] = useState('#222c34'), [foreground, setForeground] = useState('#e8edf0'), [borderColor, setBorderColor] = useState('#526472');
  const [borderStyle, setBorderStyle] = useState<'solid' | 'dashed' | 'dotted'>('solid'), [width, setWidth] = useState('260');
  const [importFormat, setImportFormat] = useState(''), [importTarget, setImportTarget] = useState(''), [importFields, setImportFields] = useState('{}'), [importPorts, setImportPorts] = useState('{}');
  const [exportFormat, setExportFormat] = useState(''), [exportTarget, setExportTarget] = useState(''), [exportFields, setExportFields] = useState('{}'), [exportPorts, setExportPorts] = useState('{}');

  useEffect(() => { let alive = true; setState(null); setError('');
    if (project) void call({ action: 'load', sessionId: project.sessionId }).then((next) => { if (alive) setState(next); }).catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : 'No se cargó el catálogo.'); });
    return () => { alive = false; };
  }, [project?.sessionId]);
  async function save(value: DeclarativeNodePackage): Promise<void> {
    if (!project || busy) return; setBusy(true); setError(''); setMessage('');
    try { setState(await call({ action: 'save', sessionId: project.sessionId, package: value })); setPreview(null); setMessage(`Paquete ${value.manifest.id}@${value.manifest.version} guardado como datos JSON del proyecto.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se guardó el paquete.'); }
    finally { setBusy(false); }
  }
  function buildPreview(): void {
    try { const value = composePackage({ packageId, packageName, version, license, typeName, description, collectionId, collectionName, fields, ports, icon, background, foreground, borderColor, borderStyle, width,
      importFormat, importTarget, importFields, importPorts, exportFormat, exportTarget, exportFields, exportPorts });
      setPreview({ value, diagnostics: validateDeclarativeNodePackage(value).map((item) => item.message), source: 'form' }); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Corrige el formulario antes de guardar.'); }
  }
  function savePreview(): void {
    if (!preview) return;
    if (preview.source === 'import') { void save(preview.value); return; }
    try {
      const current = composePackage({ packageId, packageName, version, license, typeName, description, collectionId, collectionName, fields, ports, icon, background, foreground, borderColor, borderStyle, width,
        importFormat, importTarget, importFields, importPorts, exportFormat, exportTarget, exportFields, exportPorts });
      if (JSON.stringify(current) !== JSON.stringify(preview.value)) { buildPreview(); setError('Los datos cambiaron después de la vista previa. Revisa la vista previa actualizada antes de guardar.'); return; }
      void save(current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Corrige el formulario antes de guardar.'); }
  }
  async function importFile(file?: File): Promise<void> {
    if (!file) return; setError('');
    try {
      const value: unknown = JSON.parse(await file.text()), diagnostics = validateDeclarativeNodePackage(value);
      if (diagnostics.length) { setError(diagnostics.map((item) => item.message).join('\n')); return; }
      setPreview({ value: value as DeclarativeNodePackage, diagnostics: [], source: 'import' }); setMessage('Paquete validado para vista previa. Pulsa Guardar para agregarlo al proyecto.');
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'El archivo no es un JSON de paquete A3 válido.'); }
  }
  function exportFile(value: DeclarativeNodePackage): void {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${value.manifest.id}--${value.manifest.version}.json`; anchor.click(); URL.revokeObjectURL(url);
  }
  function updateField(index: number, patch: Partial<FieldDraft>): void { setFields((items) => items.map((item, at) => at === index ? { ...item, ...patch } : item)); }
  function updatePort(index: number, patch: Partial<PortDraft>): void { setPorts((items) => items.map((item, at) => at === index ? { ...item, ...patch } : item)); }
  const previewType = preview?.value.nodeTypes[0];

  return <section className="node-packages-panel" aria-labelledby="node-package-title">
    <header className="node-package-heading"><div><p className="eyebrow">Paquetes del proyecto</p><h1 id="node-package-title">Creador de nodos declarativos</h1><p>Define campos, puertos, estilo y mappings como datos JSON versionados. A3 nunca ejecuta este paquete.</p></div>
      <label className="secondary node-package-import">Importar JSON<input aria-label="Importar paquete JSON" type="file" accept=".json,application/json" disabled={!state?.canWrite || busy} onChange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} /></label></header>
    {!project && <p role="status">Abre un proyecto para editar sus paquetes.</p>}
    {project && <><p className="node-package-access" role="status">{state?.canWrite ? 'Edición documental disponible: estos paquetes son datos inertes del proyecto.' : 'Solo lectura o permiso document.edit denegado.'}</p>
      {state?.diagnostics.map((item, index) => <p className="node-package-diagnostic" key={`${item.path}:${item.detail}:${index}`} role="status">{item.path}: {item.message}</p>)}
      <form className="node-package-builder" onSubmit={(event) => { event.preventDefault(); buildPreview(); }}>
        <fieldset disabled={!state?.canWrite || busy}><legend>Identidad del paquete y su colección</legend><div className="node-package-grid">
          <label>ID del paquete<input value={packageId} onChange={(e) => setPackageId(e.target.value)} placeholder="comunidad.iot-nodos" /></label>
          <label>Nombre visible<input value={packageName} onChange={(e) => setPackageName(e.target.value)} /></label>
          <label>Versión inmutable<input value={version} onChange={(e) => setVersion(e.target.value)} /></label>
          <label>Licencia declarada<input value={license} onChange={(e) => setLicense(e.target.value)} /></label>
          <label>ID del tipo<input value={typeName} onChange={(e) => setTypeName(e.target.value)} placeholder="comunidad.iot-nodos.sensor" /></label>
          <label>Nombre de colección<input value={collectionName} onChange={(e) => setCollectionName(e.target.value)} /></label>
          <label>ID de colección<input value={collectionId} onChange={(e) => setCollectionId(e.target.value)} /></label>
          <label className="node-package-wide">Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
        </div></fieldset>
        <fieldset disabled={!state?.canWrite || busy}><legend>Campos tipados</legend>
          {fields.map((field, index) => <div className="node-package-member" key={index}>
            <label>Nombre<input value={field.name} onChange={(e) => updateField(index, { name: e.target.value })} /></label>
            <label>Tipo<select value={field.valueType} onChange={(e) => updateField(index, { valueType: e.target.value as ValueType })}>{['string', 'number', 'boolean', 'enum', 'list', 'reference', 'json'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Predeterminado (JSON)<input value={field.defaultValue} onChange={(e) => updateField(index, { defaultValue: e.target.value })} placeholder={'"valor"'} /></label>
            {field.valueType === 'enum' && <label>Opciones separadas por coma<input value={field.enumValues} onChange={(e) => updateField(index, { enumValues: e.target.value })} /></label>}
            <label className="node-package-check"><input type="checkbox" checked={field.required} onChange={(e) => updateField(index, { required: e.target.checked })} />Obligatorio</label>
            <label className="node-package-check"><input type="checkbox" checked={field.acceptsBinding} onChange={(e) => updateField(index, { acceptsBinding: e.target.checked })} />Acepta variable</label>
            <button type="button" className="quiet danger" onClick={() => setFields((items) => items.filter((_, at) => at !== index))}>Quitar campo</button>
          </div>)}<button type="button" className="secondary" onClick={() => setFields((items) => [...items, emptyField()])}>Añadir campo</button>
        </fieldset>
        <fieldset disabled={!state?.canWrite || busy}><legend>Puertos input/output</legend>
          {ports.map((port, index) => <div className="node-package-member" key={index}>
            <label>ID estable<input value={port.id} onChange={(e) => updatePort(index, { id: e.target.value })} /></label>
            <label>Etiqueta<input value={port.label} onChange={(e) => updatePort(index, { label: e.target.value })} /></label>
            <label>Dirección<select value={port.direction} onChange={(e) => updatePort(index, { direction: e.target.value as PortDraft['direction'] })}><option value="input">input</option><option value="output">output</option></select></label>
            <label>Tipo de dato/señal<input value={port.dataType} onChange={(e) => updatePort(index, { dataType: e.target.value })} /></label>
            <label>Mínimo<input type="number" min="0" value={port.min} onChange={(e) => updatePort(index, { min: e.target.value })} /></label>
            <label>Máximo (vacío = sin límite)<input type="number" min="0" value={port.max} onChange={(e) => updatePort(index, { max: e.target.value })} /></label>
            <button type="button" className="quiet danger" onClick={() => setPorts((items) => items.filter((_, at) => at !== index))}>Quitar puerto</button>
          </div>)}<button type="button" className="secondary" onClick={() => setPorts((items) => [...items, { ...emptyPort(), id: `puerto.${ports.length + 1}` }])}>Añadir puerto</button>
        </fieldset>
        <fieldset disabled={!state?.canWrite || busy}><legend>Estilo declarativo</legend><div className="node-package-grid">
          <label>Icono (nombre o símbolo)<input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={64} /></label>
          <label>Fondo<input type="color" value={background} onChange={(e) => setBackground(e.target.value)} /></label>
          <label>Texto<input type="color" value={foreground} onChange={(e) => setForeground(e.target.value)} /></label>
          <label>Borde<input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} /></label>
          <label>Trazo del borde<select value={borderStyle} onChange={(e) => setBorderStyle(e.target.value as typeof borderStyle)}><option value="solid">solid</option><option value="dashed">dashed</option><option value="dotted">dotted</option></select></label>
          <label>Ancho de vista<input type="number" min="120" max="800" value={width} onChange={(e) => setWidth(e.target.value)} /></label>
        </div></fieldset>
        <fieldset disabled={!state?.canWrite || busy}><legend>Mappings declarativos de importación y exportación</legend><p>Solo describen nombres de formato, campos y puertos. No ejecutan transformaciones ni código.</p>
          <div className="node-package-mapping"><h3>Importación</h3><label>Formato<input value={importFormat} onChange={(e) => setImportFormat(e.target.value)} placeholder="mermaid.class" /></label><label>Tipo destino<input value={importTarget} onChange={(e) => setImportTarget(e.target.value)} /></label><label>Campos · objeto JSON<input value={importFields} onChange={(e) => setImportFields(e.target.value)} /></label><label>Puertos · objeto JSON<input value={importPorts} onChange={(e) => setImportPorts(e.target.value)} /></label></div>
          <div className="node-package-mapping"><h3>Exportación</h3><label>Formato<input value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} placeholder="plantuml.class" /></label><label>Tipo destino<input value={exportTarget} onChange={(e) => setExportTarget(e.target.value)} /></label><label>Campos · objeto JSON<input value={exportFields} onChange={(e) => setExportFields(e.target.value)} /></label><label>Puertos · objeto JSON<input value={exportPorts} onChange={(e) => setExportPorts(e.target.value)} /></label></div>
        </fieldset>
        <div className="node-package-actions"><button className="secondary" type="submit" disabled={busy}>Vista previa</button>
          <button className="primary" type="button" disabled={!state?.canWrite || busy || !preview || preview.diagnostics.length > 0} onClick={savePreview}>{busy ? 'Guardando…' : 'Guardar versión declarativa'}</button></div>
      </form>
      {preview && previewType && <section className="node-package-preview" aria-label="Vista previa del paquete">
        <h2>Vista previa · {previewType.name}@{previewType.version}</h2>
        <p>{previewType.description || 'Tipo personalizado'} · {preview.value.nodeTypes.length} tipo(s) · {preview.value.collections.length} colección(es)</p>
        <div className="canvas-node-preview" style={{ background: previewType.style?.background, color: previewType.style?.foreground,
          borderColor: previewType.style?.borderColor, borderStyle: previewType.style?.borderStyle, width: previewType.style?.width }}>
          <strong>{previewType.style?.icon || '◇'} {previewType.name.split('.').at(-1)}</strong>
          <ul>{previewType.ports.map((port) => <li key={port.id}>{port.direction} · {port.label || port.id} · {port.dataType || 'tipo desconocido'}</li>)}</ul>
        </div>
        <h3>Ejemplo de instancia</h3><pre>{JSON.stringify({ type: previewType.name, typeVersion: previewType.version,
          properties: Object.fromEntries(previewType.fields.map((field) => [field.name, field.defaultValue ?? (field.valueType === 'number' ? 0 : field.valueType === 'boolean' ? false : field.valueType === 'list' ? [] : field.valueType === 'json' ? {} : field.valueType === 'reference' ? null : field.valueType === 'enum' ? field.enumValues?.[0] ?? '' : 'ejemplo')])) }, null, 2)}</pre>
        {preview.diagnostics.map((item, index) => <p role="alert" key={`${item}:${index}`}>{item}</p>)}
      </section>}
      {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="node-package-success">{message}</p>}
      <section aria-label="Paquetes instalados en este proyecto"><h2>Paquetes del proyecto ({state?.packages.length ?? 0})</h2>
        {!state?.packages.length && <p>No hay paquetes declarativos. Añade uno con el formulario o importa un JSON existente.</p>}
        {state?.packages.map((pkg) => <article className="node-package-card" key={`${pkg.manifest.id}@${pkg.manifest.version}`}><div><strong>{pkg.manifest.name}</strong><span>{pkg.manifest.id}@{pkg.manifest.version}</span></div>
          <p>Licencia declarada: {pkg.manifest.license} · {pkg.nodeTypes.length} tipo(s) · {pkg.collections.length} colección(es)</p>
          <ul>{pkg.nodeTypes.map((type) => <li key={`${type.name}@${type.version}`}>{type.name}@{type.version} · {type.fields.length} campos · {type.ports.length} puertos</li>)}</ul>
          <button type="button" className="secondary" onClick={() => exportFile(pkg)}>Exportar JSON</button></article>)}
      </section>
    </>}
  </section>;
}
