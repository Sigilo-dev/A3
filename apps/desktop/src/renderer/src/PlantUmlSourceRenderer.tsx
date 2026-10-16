import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { PLANTUML_RENDERER_VERSION, PLANTUML_SOURCE_LIMIT, supportsPlantUmlSourceRenderer } from '@a3/domain/plantuml-source';
import type { CanvasEntitySummary, CanvasPlantUmlRenderOutcome } from '../../shared/desktop-api';

function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed', 'image'],
    FORBID_ATTR: ['href', 'xlink:href'], ALLOW_DATA_ATTR: false, RETURN_TRUSTED_TYPE: false
  }) as string;
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return '';
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || ['href', 'xlink:href'].includes(attribute.name.toLowerCase()) ||
          /url\s*\(\s*(?!#)/i.test(attribute.value) || /javascript\s*:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.localName.toLowerCase() === 'style' && /@import|url\s*\(\s*(?!#)|expression\s*\(|javascript\s*:/i.test(element.textContent ?? '')) element.remove();
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

async function sha256Text(source: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function PlantUmlSourceRenderer({ entity, source, unavailableMessage, sessionId, workspaceId }: {
  entity: CanvasEntitySummary; source: string | null; unavailableMessage?: string; sessionId: string; workspaceId: string;
}): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<CanvasPlantUmlRenderOutcome | null>(null);
  const authoritySupported = supportsPlantUmlSourceRenderer(entity.type, entity.typeVersion, entity.properties);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    setResult(null);
    if (!authoritySupported || source === null || !visible || !window.a3) return () => { current = false; };
    const api = window.a3;
    if (new TextEncoder().encode(source).byteLength > PLANTUML_SOURCE_LIMIT) {
      setResult({ state: 'too-large', message: `La fuente supera el límite de ${PLANTUML_SOURCE_LIMIT} bytes; el original permanece intacto.` });
      return () => { current = false; };
    }
    void (async () => {
      try {
        const response = await api.canvas({ action: 'plantuml-render', sessionId, workspaceId, sourceEntityId: entity.id });
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        const value = response.value;
        if (value.sourceHash && value.sourceHash !== await sha256Text(source)) {
          if (current) setResult({ state: 'invalid', message: 'El archivo cambió durante el render; recarga el nodo antes de mostrarlo.', sourceHash: value.sourceHash });
          return;
        }
        if (value.state === 'rendered') {
          const safeSvg = sanitizeSvg(value.svg);
          if (current) setResult(safeSvg ? { ...value, svg: safeSvg } : { state: 'invalid', message: 'La salida SVG no pasó la sanitización; la fuente permanece intacta.', sourceHash: value.sourceHash });
        } else if (current) setResult(value);
      } catch (error) {
        if (current) setResult({ state: 'unavailable', message: error instanceof Error ? error.message.slice(0, 500) : 'No se pudo iniciar el renderer local.' });
      }
    })();
    return () => { current = false; };
  }, [authoritySupported, entity.id, sessionId, source, visible, workspaceId]);

  const state = !authoritySupported ? 'fallback' : source === null ? 'unavailable' : result?.state ?? (visible ? 'loading' : 'deferred');
  const message = !authoritySupported ? 'No se reconoce la autoridad o versión de esta fuente; solo se muestra el original.' :
    source === null ? unavailableMessage ?? 'No se puede leer la fuente. Se conserva para localizar o revisar permisos.' :
    result?.state === 'rendered' ? '' : result?.state === 'invalid' && result.line ? `Línea ${result.line}: ${result.message}` :
    state === 'deferred' ? 'El render comienza al acercar este nodo al lienzo.' : result?.message ?? 'Renderizando con PlantUML local…';
  return <section ref={container} className="canvas-content-card plantuml-source-card" data-content-renderer="plantuml-source" data-plantuml-state={state}
    aria-label={`Diagrama PlantUML de fuente ${entity.title}`}>
    {result?.state === 'rendered' ? <div className="plantuml-source-output" role="img" aria-label={`Diagrama PlantUML: ${entity.title}`} dangerouslySetInnerHTML={{ __html: result.svg }} /> :
      <p className="canvas-content-state" role={['invalid', 'unavailable', 'timeout', 'too-large', 'fallback'].includes(state) ? 'alert' : 'status'}>{message}</p>}
    {source !== null && <details className="plantuml-source-original"><summary>Fuente PlantUML preservada</summary><pre>{source}</pre></details>}
    <small>{entity.contentResource?.label ?? 'Fuente PlantUML'} · PlantUML {PLANTUML_RENDERER_VERSION}{result?.state === 'rendered' ? ` · Java ${result.javaVersion}` : ''} · authority source</small>
  </section>;
}
