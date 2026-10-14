import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): ReactNode {
    if (this.state.failed) return <main className="fatal" role="alert">
      <h1>No se pudo mostrar la interfaz</h1>
      <p>Recarga A3 para volver a intentar el inicio.</p>
      <button onClick={() => window.location.reload()}>Recargar interfaz</button>
    </main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><StartupBoundary><App /></StartupBoundary></StrictMode>
);
