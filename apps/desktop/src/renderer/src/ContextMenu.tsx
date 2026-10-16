import { useEffect, useRef, useState } from 'react';
import type { MenuPermissions } from '../../shared/desktop-api';
export interface ContextAction { id: string; label: string; run: () => void; capability?: keyof MenuPermissions; reason?: string; }
export interface MenuState { x: number; y: number; origin: Element | null; context: string; actions: ContextAction[]; }
export function useMenuPermissions(sessionId: string | undefined): MenuPermissions | null {
  const [value, setValue] = useState<MenuPermissions | null>(null);
  useEffect(() => {
    let live = true; setValue(null);
    async function refresh(): Promise<void> { if (!sessionId) return; try { const r = await window.a3?.navigation({ action: 'permissions', sessionId }); if (live && r?.ok && 'read' in r.value) setValue(r.value); } catch { if (live) setValue(null); } }
    void refresh(); window.addEventListener('focus', refresh); window.addEventListener('a3:menu-open', refresh);
    return () => { live = false; window.removeEventListener('focus', refresh); window.removeEventListener('a3:menu-open', refresh); };
  }, [sessionId]); return value;
}
export function menuAt(event: React.MouseEvent | React.KeyboardEvent, context: string, actions: ContextAction[]): MenuState {
  event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new Event('a3:menu-open'));
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: 'clientX' in event && event.clientX ? event.clientX : rect.left + 12, y: 'clientY' in event && event.clientY ? event.clientY : rect.top + 16, origin: event.target instanceof Element ? event.target : null, context, actions };
}
export function ContextMenu({ menu, permissions, onClose }: { menu: MenuState; permissions: MenuPermissions | null; onClose: () => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ x: menu.x, y: menu.y });
  const close = (restore = true): void => { onClose(); const target = menu.origin?.closest<HTMLElement>('[tabindex],button,a,input'); if (restore && target?.isConnected && typeof target.focus === 'function') target.focus(); };
  useEffect(() => {
    const element = root.current; if (element) { const box = element.getBoundingClientRect(); setPosition({ x: Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4)) }); element.querySelector<HTMLButtonElement>('button')?.focus(); }
    const outside = (e: PointerEvent): void => { if (!root.current?.contains(e.target as Node)) close(false); };
    window.addEventListener('pointerdown', outside, true); return () => window.removeEventListener('pointerdown', outside, true);
  }, [menu]);
  return <div ref={root} className="context-menu" role="menu" aria-label={`Acciones: ${menu.context}`} data-context-menu={menu.context} style={{ left: position.x, top: position.y }} onKeyDown={(e) => {
    if (['Escape', 'Tab'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); close(); return; }
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
  }}>
    {menu.actions.map((a) => { const reason = a.reason || (a.capability && (!permissions ? 'Comprobando permisos del host…' : !permissions[a.capability].allowed ? permissions[a.capability].reason : ''));
      return <button key={a.id} role="menuitem" data-context-action={a.id} aria-disabled={!!reason} title={reason || undefined} onClick={() => { if (reason) return; close(); a.run(); }}><span>{a.label}</span>{reason && <small>{reason}</small>}</button>; })}
  </div>;
}
