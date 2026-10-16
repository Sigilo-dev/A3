/** Built-in content node catalog. These renderers are part of A3, not installable packages. */
export const CONTENT_NODE_CATALOG = [
  { kind: 'page', type: 'a3.core.page', label: 'Página Markdown', source: 'inline', mediaType: 'text/markdown', extension: '.md' },
  { kind: 'short-text', type: 'a3.content.short-text', label: 'Texto breve', source: 'inline', mediaType: 'text/markdown', extension: '.md' },
  { kind: 'image', type: 'a3.content.image', label: 'Imagen', source: 'resource', mediaType: 'image/*' },
  { kind: 'video', type: 'a3.content.video', label: 'Video local', source: 'resource', mediaType: 'video/*' },
  { kind: 'youtube', type: 'a3.content.youtube', label: 'YouTube', source: 'url', mediaType: 'text/uri-list' },
  { kind: 'audio', type: 'a3.content.audio', label: 'Audio', source: 'resource', mediaType: 'audio/*' },
  { kind: 'web-link', type: 'a3.content.web-link', label: 'Enlace web', source: 'url', mediaType: 'text/uri-list' },
  { kind: 'file', type: 'a3.content.file', label: 'Archivo', source: 'resource', mediaType: 'application/octet-stream' },
  { kind: 'code', type: 'a3.content.code', label: 'Código', source: 'inline', mediaType: 'text/plain', extension: '.txt' },
  { kind: 'drawing', type: 'a3.core.drawing', label: 'Dibujo', source: 'inline', mediaType: 'application/vnd.a3.drawing+json', extension: '.a3draw.json' }
] as const;

export type ContentNodeKind = typeof CONTENT_NODE_CATALOG[number]['kind'];
export type ContentNodeType = typeof CONTENT_NODE_CATALOG[number]['type'];
export type ContentNodeSourceKind = typeof CONTENT_NODE_CATALOG[number]['source'];
export const contentNodeDefinition = (kind: ContentNodeKind) => CONTENT_NODE_CATALOG.find((item) => item.kind === kind)!;
export const isBuiltinContentNodeType = (type: string): boolean => CONTENT_NODE_CATALOG.some((item) => item.type === type);

export type PastedContent = { kind: 'text'; value: string } | { kind: 'youtube' | 'web-link' | 'image-url'; value: string; title: string };
/** Classifies pasted text without fetching URLs or invoking network metadata services. */
export function classifyPastedContent(value: string): PastedContent {
  const text = value.trim();
  if (!text || text.length > 1_000_000) return { kind: 'text', value: text.slice(0, 1_000_000) };
  const URLConstructor = (globalThis as unknown as { URL: new (input: string) => {
    protocol: string; username: string; password: string; hostname: string; pathname: string; href: string; searchParams: { get(name: string): string | null };
  } }).URL;
  let url: InstanceType<typeof URLConstructor>;
  try { url = new URLConstructor(text); } catch { return { kind: 'text', value }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { kind: 'text', value };
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (['youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) {
    const id = hostname === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0] : url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).at(-1);
    if (id && /^[\w-]{11}$/.test(id)) return { kind: 'youtube', value: url.href, title: `YouTube · ${id}` };
  }
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(url.pathname)) return { kind: 'image-url', value: url.href, title: `Imagen · ${url.hostname}` };
  return { kind: 'web-link', value: url.href, title: `Enlace · ${url.hostname}` };
}

/** Versioned clipboard envelope reserved for text and URL fragments created by A3. */
export function parseA3ClipboardFragment(value: string): { kind: 'text' | 'url'; value: string } | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.format !== 'a3-clipboard-fragment' || parsed.version !== 1 ||
        !['text', 'url'].includes(String(parsed.kind)) || typeof parsed.value !== 'string' || !parsed.value.trim() || parsed.value.length > 1_000_000) return undefined;
    if (Object.keys(parsed).some((key) => !['format', 'version', 'kind', 'value'].includes(key))) return undefined;
    if (parsed.kind === 'url' && !['youtube', 'web-link', 'image-url'].includes(classifyPastedContent(parsed.value).kind)) return undefined;
    return { kind: parsed.kind as 'text' | 'url', value: parsed.value };
  } catch { return undefined; }
}

export type SmartPasteDecision = { kind: 'text'; value: string } | { kind: 'image'; bytes: Uint8Array; mediaType: string } |
  { kind: 'youtube' | 'web-link' | 'image-url'; value: string; title: string };
/** Resolves clipboard precedence without opening URLs or downloading previews. */
export function resolveSmartPastePayload(payload: { fragment?: string; image?: { bytes: Uint8Array; mediaType: string }; text: string }): SmartPasteDecision {
  if (payload.fragment !== undefined) {
    const fragment = parseA3ClipboardFragment(payload.fragment);
    if (fragment?.kind === 'text') return { kind: 'text', value: fragment.value };
    if (fragment?.kind === 'url') {
      const classified = classifyPastedContent(fragment.value);
      if (classified.kind !== 'text') return classified;
    }
  }
  if (payload.image && payload.image.bytes.length > 0) return { kind: 'image', bytes: payload.image.bytes, mediaType: payload.image.mediaType };
  return classifyPastedContent(payload.text);
}
