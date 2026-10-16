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
