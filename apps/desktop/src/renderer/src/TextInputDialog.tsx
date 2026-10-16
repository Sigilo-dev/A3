import { useRef, useState } from 'react';
interface Prompt { title: string; value: string; resolve: (s: string | null) => void; origin: Element | null; }
export function useTextPrompt(): [(title: string, value?: string) => Promise<string | null>, React.ReactNode] {
  const [prompt, setPrompt] = useState<Prompt | null>(null), pending = useRef<Prompt | null>(null);
  function finish(value: string | null): void { const p = pending.current; if (!p) return; pending.current = null; setPrompt(null); p.resolve(value); if (p.origin instanceof HTMLElement && p.origin.isConnected) p.origin.focus(); }
  return [(title, value = '') => new Promise((resolve) => { if (pending.current) { resolve(null); return; } const p = { title, value, resolve, origin: document.activeElement }; pending.current = p; setPrompt(p); }),
    prompt && <div className="modal-backdrop"><form className="delete-dialog" role="dialog" aria-modal="true" aria-label={prompt.title} onSubmit={(e) => { e.preventDefault(); finish(prompt.value); }} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      if (e.key === 'Tab') { const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('input,button')], i = controls.indexOf(document.activeElement as HTMLElement); e.preventDefault(); controls[(i + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus(); }
    }}><h2>{prompt.title}</h2><label>{prompt.title}<input autoFocus data-text-prompt value={prompt.value} maxLength={1024} onChange={(e) => setPrompt((p) => p && ({ ...p, value: e.target.value }))} /></label>
      <button type="submit" data-text-confirm disabled={!prompt.value.trim()}>Confirmar</button><button type="button" data-text-cancel onClick={() => finish(null)}>Cancelar</button></form></div>];
}
