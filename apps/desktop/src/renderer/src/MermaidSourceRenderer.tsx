import { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';
import { MERMAID_RENDERER_VERSION, MERMAID_SOURCE_LIMIT, renderMermaidSource, supportsMermaidSourceRenderer, type MermaidEngine, type MermaidRenderResult } from '@a3/domain/mermaid-source';
import type { CanvasEntitySummary } from '../../shared/desktop-api';

let engineInitialized = false;
async function loadMermaidEngine(): Promise<MermaidEngine> {
  const { default: mermaid } = await import('mermaid');
  if (!engineInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'default',
      maxTextSize: MERMAID_SOURCE_LIMIT,
      maxEdges: 500,
      suppressErrorRendering: true,
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'theme', 'themeCSS', 'fontFamily', 'maxTextSize', 'maxEdges', 'suppressErrorRendering']
    });
    engineInitialized = true;
  }
  return { parse: (source) => mermaid.parse(source), render: (id, source) => mermaid.render(id, source) };
}

function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed', 'image'],
    FORBID_ATTR: ['href', 'xlink:href'],
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false
  }) as string;
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return '';
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || ['href', 'xlink:href'].includes(attribute.name.toLowerCase()) || /url\s*\(\s*(?!#)/i.test(attribute.value) || /javascript\s*:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.localName.toLowerCase() === 'style' && /@import|url\s*\(|expression\s*\(|javascript\s*:/i.test(element.textContent ?? '')) element.remove();
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

function useDiagram(source: string | null): MermaidRenderResult | null {
  const reactId = useId().replace(/[^\da-z_-]/gi, ''), [result, setResult] = useState<MermaidRenderResult | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    if (source === null) return () => { current = false; };
    void renderMermaidSource(source, `a3-${reactId}`, loadMermaidEngine).then((value) => {
      if (!current) return;
      if (value.state === 'rendered') {
        const svg = sanitizeSvg(value.svg);
        setResult(svg ? { ...value, svg } : { state: 'invalid', message: 'El SVG producido no pasó la sanitización; la fuente original permanece intacta.' });
      } else setResult(value);
    }).catch(() => { if (current) setResult({ state: 'unavailable', message: `El motor Mermaid ${MERMAID_RENDERER_VERSION} no está disponible; la fuente original permanece intacta.` }); });
    return () => { current = false; };
  }, [source, reactId]);
  return result;
}

export function MermaidSourceRenderer({ entity, source, unavailableMessage }: {
  entity: CanvasEntitySummary; source: string | null; unavailableMessage?: string;
}): React.JSX.Element {
  const authoritySupported = supportsMermaidSourceRenderer(entity.type, entity.typeVersion, entity.properties);
  const result = useDiagram(authoritySupported ? source : null);
  const state = !authoritySupported ? 'fallback' : source === null ? 'unavailable' : result?.state ?? 'loading';
  const message = !authoritySupported ? 'No se reconoce la autoridad o versión de esta fuente. Se muestra el original sin renderizarlo.' :
    source === null ? unavailableMessage ?? 'No se puede leer la fuente. El recurso original se conserva y requiere localizar o revisar permisos.' :
    result?.state === 'invalid' ? `${result.line ? `Línea ${result.line}${result.column ? `, columna ${result.column}` : ''}: ` : ''}${result.message}` :
    result?.state === 'unavailable' || result?.state === 'too-large' ? result.message : '';
  const safeSvg = authoritySupported && result?.state === 'rendered' ? result.svg : '';
  return <section className="canvas-content-card mermaid-source-card" data-content-renderer="mermaid-source" data-mermaid-state={state}
    data-mermaid-line={result?.state === 'invalid' ? result.line : undefined} aria-label={`Diagrama Mermaid de fuente ${entity.title}`}>
    {safeSvg ? <div className="mermaid-source-output" role="img" aria-label={`Diagrama Mermaid: ${entity.title}`} dangerouslySetInnerHTML={{ __html: safeSvg }} /> :
      <p className="canvas-content-state" role={state === 'invalid' || state === 'unavailable' || state === 'fallback' ? 'alert' : 'status'}>{message || 'Validando y renderizando Mermaid…'}</p>}
    {source !== null && <details className="mermaid-source-original"><summary>Fuente Mermaid preservada</summary><pre>{source}</pre></details>}
    {entity.contentResource && <small>{entity.contentResource.label} · Mermaid {MERMAID_RENDERER_VERSION} · autoridad source</small>}
  </section>;
}
