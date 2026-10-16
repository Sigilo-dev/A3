import { createContext, useContext, useEffect, useState } from 'react';
import { SHORTCUTS, defaultShortcuts, validateShortcuts, matchesShortcut, type ShortcutBindings, type ShortcutId } from '@a3/domain/shortcuts';
const ShortcutContext = createContext(defaultShortcuts());
const ShortcutLoadErrorContext = createContext('');
export const useShortcuts = (): ShortcutBindings => useContext(ShortcutContext);
export { matchesShortcut };
export function ShortcutProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [bindings, setBindings] = useState(defaultShortcuts);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let live = true;
    void window.a3?.navigation({ action: 'shortcuts-load' }).then((r) => { if (!live) return; if (!r.ok) { setLoadError(r.error.message); return; } const parsed = validateShortcuts(r.value); if (parsed.ok) setBindings(parsed.bindings); else setLoadError(parsed.message); }).catch(() => { if (live) setLoadError('No se pudieron leer los atajos locales.'); });
    const update = (e: Event): void => { const parsed = validateShortcuts((e as CustomEvent).detail); if (parsed.ok) { setBindings(parsed.bindings); setLoadError(''); } };
    window.addEventListener('a3:shortcuts', update); return () => { live = false; window.removeEventListener('a3:shortcuts', update); };
  }, []);
  return <ShortcutContext.Provider value={bindings}><ShortcutLoadErrorContext.Provider value={loadError}>{children}</ShortcutLoadErrorContext.Provider></ShortcutContext.Provider>;
}
export function ShortcutPreferences(): React.JSX.Element {
  const saved = useShortcuts(), [draft, setDraft] = useState(saved), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const loadError = useContext(ShortcutLoadErrorContext);
  useEffect(() => setDraft(saved), [saved]);
  const valid = validateShortcuts(draft);
  async function persist(reset = false): Promise<void> {
    if (!window.a3 || busy || !reset && !valid.ok) return; setBusy(true);
    try { const result = await window.a3.navigation(reset ? { action: 'shortcuts-reset' } : { action: 'shortcuts-save', bindings: draft });
      if (!result.ok) throw new Error(result.error.message);
      const parsed = validateShortcuts(result.value); if (!parsed.ok) throw new Error(parsed.message);
      window.dispatchEvent(new CustomEvent('a3:shortcuts', { detail: parsed.bindings })); setMessage(reset ? 'Atajos predeterminados restaurados.' : 'Atajos guardados en este dispositivo.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'No se guardaron los atajos.'); } finally { setBusy(false); }
  }
  return <section className="shortcut-preferences" aria-label="Atajos de teclado"><h2>Atajos de teclado</h2>
    <p>Aplican a las operaciones disponibles de E1/E2. Formato: Ctrl+Shift+Z; deja vacío para desactivar. Los editores conservan sus atajos nativos de texto.</p>
    {loadError && <p role="alert">{loadError} El archivo original se conserva. Usa Restaurar predeterminados para reemplazarlo explícitamente.</p>}
    {SHORTCUTS.map((s) => <label key={s.id}>{s.label} <small>({s.context})</small><input data-shortcut={s.id} value={draft[s.id]} maxLength={64} onChange={(e) => setDraft((old) => ({ ...old, [s.id]: e.target.value }))} /></label>)}
    {!valid.ok && <p role="alert" data-shortcut-conflict>{valid.message}</p>}<p role="status">{message}</p>
    <button data-shortcuts-save disabled={busy || !valid.ok || !!loadError} onClick={() => void persist()}>Guardar atajos</button>
    <button data-shortcuts-reset disabled={busy} onClick={() => void persist(true)}>Restaurar predeterminados</button>
  </section>;
}
export function shortcutFor(event: React.KeyboardEvent, bindings: ShortcutBindings, ids: readonly ShortcutId[]): ShortcutId | undefined {
  return ids.find((id) => matchesShortcut(event.nativeEvent, bindings[id]));
}
