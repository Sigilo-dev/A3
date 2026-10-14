import type { DesktopAPI } from '../../shared/desktop-api';

declare global {
  interface Window { readonly a3?: DesktopAPI; }
}
