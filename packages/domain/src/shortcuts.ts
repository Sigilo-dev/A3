export const SHORTCUTS = [
  { id: 'save', label: 'Guardar documento', context: 'document', keys: 'Ctrl+S' },
  { id: 'close', label: 'Cerrar pestaña', context: 'global', keys: 'Ctrl+W' },
  { id: 'back', label: 'Volver', context: 'global', keys: 'Alt+ArrowLeft' },
  { id: 'forward', label: 'Avanzar', context: 'global', keys: 'Alt+ArrowRight' },
  { id: 'undo', label: 'Deshacer lienzo', context: 'canvas', keys: 'Ctrl+Z' },
  { id: 'redo', label: 'Rehacer lienzo', context: 'canvas', keys: 'Ctrl+Shift+Z' },
  { id: 'duplicate', label: 'Duplicar contenido', context: 'canvas', keys: 'Ctrl+D' },
  { id: 'group', label: 'Agrupar selección', context: 'canvas', keys: 'Ctrl+G' },
  { id: 'fit', label: 'Ajustar contenido', context: 'canvas', keys: 'Home' },
  { id: 'remove', label: 'Borrar trazo/línea', context: 'canvas', keys: 'Delete' },
  { id: 'file-duplicate', label: 'Duplicar archivo', context: 'files', keys: 'Ctrl+D' },
  { id: 'file-rename', label: 'Renombrar archivo', context: 'files', keys: 'F2' },
  { id: 'file-trash', label: 'Papelera', context: 'files', keys: 'Delete' },
] as const;
export type ShortcutId = typeof SHORTCUTS[number]['id'];
export type ShortcutBindings = Record<ShortcutId, string>;
export const defaultShortcuts = (): ShortcutBindings => Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys])) as ShortcutBindings;
export function normalizeShortcut(value: string): string | null {
  if (value === '') return '';
  const parts = value.split('+').map((s) => s.trim()), key = parts.pop()!;
  if (!key || !/^(?:[a-z0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|Home|End|Delete|Escape|Enter)$/i.test(key)) return null;
  if (parts.some((s) => !['ctrl', 'alt', 'shift'].includes(s.toLowerCase())) || new Set(parts.map((s) => s.toLowerCase())).size !== parts.length) return null;
  // Leave normal typing and native editing keys to editors. Unmodified navigation keys are supported.
  if (key.length === 1 && !parts.some((s) => ['ctrl', 'alt'].includes(s.toLowerCase()))) return null;
  const canonicalKey = key.length === 1 ? key.toUpperCase() : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Delete', 'Escape', 'Enter', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)].find((s) => s.toLowerCase() === key.toLowerCase())!;
  return [...['Ctrl', 'Alt', 'Shift'].filter((s) => parts.some((p) => p.toLowerCase() === s.toLowerCase())), canonicalKey].join('+');
}
export function validateShortcuts(value: unknown): { ok: true; bindings: ShortcutBindings } | { ok: false; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== SHORTCUTS.length) return { ok: false, message: 'El mapa de atajos no es válido.' };
  const result = defaultShortcuts();
  for (const action of SHORTCUTS) { const raw = (value as Record<string, unknown>)[action.id], normalized = typeof raw === 'string' ? normalizeShortcut(raw) : null;
    if (normalized === null || (raw as string).length > 64) return { ok: false, message: `Atajo inválido: ${action.label}.` }; result[action.id] = normalized; }
  for (const action of SHORTCUTS) if (['global', 'document'].includes(action.context) && result[action.id] && !/^(?:Ctrl\+|Alt\+|F\d+$)/.test(result[action.id])) return { ok: false, message: `El atajo de ${action.label} requiere Ctrl, Alt o una tecla de función para conservar la edición de texto.` };
  for (let i = 0; i < SHORTCUTS.length; i++) for (const b of SHORTCUTS.slice(i + 1)) {
    const a = SHORTCUTS[i]!;
    if (result[a.id] && result[a.id] === result[b.id] && (a.context === b.context || a.context === 'global' || b.context === 'global')) return { ok: false, message: `Colisión: ${a.label} / ${b.label} (${result[a.id]}).` };
  }
  // Ctrl+C/V/X/A/F, native text undo/redo, tab and IME remain editor/browser commands.
  for (const action of SHORTCUTS) if (['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+F', 'Ctrl+Shift+F', 'Alt+F4'].includes(result[action.id]) || action.context === 'global' && ['Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y'].includes(result[action.id])) return { ok: false, message: `Atajo reservado por el editor o el sistema: ${result[action.id]}.` };
  return { ok: true, bindings: result };
}
export function matchesShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, binding: string): boolean {
  if (event.isComposing || !binding) return false;
  const actual = [...(event.ctrlKey || event.metaKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.key.length === 1 ? event.key.toUpperCase() : event.key].join('+');
  return actual === binding;
}
