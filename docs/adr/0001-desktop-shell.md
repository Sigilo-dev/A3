# ADR 0001 — Base de escritorio E1-A

Estado: implementado para desarrollo local; fecha: 2026-10-14. Base Git: E0-E `a6d8c13`, rama `codex/e0-foundation`. Detalle compatible con DEC-01–03/09 y §§5, 9, 27–30 de la especificación local; no cambia los contratos E0-A.

## Decisión

El root pasa a ser un workspace npm privado. `apps/desktop` contiene Electron main, preload, renderer React y un contrato de consulta compartido. Se conserva `npm test` para los contratos E0 y no se reorganizan spikes ni esquemas. Se mantienen npm 11.10.0 y Node host 24.13.1; `.node-version`, engines y el lock raíz documentan reproducción. No se crean paquetes de dominio vacíos.

Se fijan Electron 44.7.2, React/React DOM 19.3.1 y Vite 8.3.4 desde los candidatos E0. Los paquetes no fijados en E0 se seleccionan por versión estable publicada y compatibilidad declarada: electron-vite 6.0.0 acepta Vite 8, el plugin React 6.1.2 requiere Vite 8, TypeScript 7.0.2 y electron-builder 26.15.3. Tipos: Node 24.19.2, React/React DOM 19.3.0. Cada pin se verificó en el registry npm oficial; todos se conservan exactos en package.json y el árbol/integridades en package-lock.json. No se actualizan los locks de los spikes.

## Frontera de la ventana

Main y preload se compilan en CommonJS explícito. El preload sandboxed es un bundle único: importa Electron y el contrato compilado, sin requerir módulos Node adicionales. El renderer se construye para navegador y tiene Node desactivado, contextIsolation, sandbox, webSecurity y webviewTag desactivado. Solo se expone `window.a3.getAppInfo()`, que consulta versión/plataforma; no recibe rutas, canales, comandos o actores. Main valida WebContents, frame principal, documento exacto y ausencia de argumentos. La forma del resultado usa códigos ya definidos por E0; no implementa el envelope de comandos del dominio.

Producción carga `a3://desktop/index.html`, mediante un protocolo registrado como estándar/seguro y limitado a los assets compilados. Se evita dar al renderer un origen file con acceso a rutas del sistema. En desarrollo solo se acepta el servidor HTTP de loopback entregado por electron-vite; el documento permitido no incluye URLs remotas. La CSP de producción no permite scripts inline, conexiones, frames, formularios ni objetos. Desarrollo admite inline para el preámbulo React/HMR y WebSocket local; no se incorpora esa concesión al paquete.

La sesión de shell deniega permisos, descargas, ventanas nuevas, webviews y navegación ajena al documento. Futuras vistas web requieren una sesión y WebContents propios; esta sesión no se reutiliza para ChatGPT. No se implementan procesos de agente ni permisos de proyecto; se mantiene P-E0-02.

Fallos de carga, preload o proceso renderer muestran un error nativo y terminan con código 1. Un watchdog cubre la ausencia de handshake de inicio. React presenta errores de render y de consulta con recuperación visible. El cierre de la última ventana termina Electron y retira el handler IPC; no existen workers/hijos de producto. Las pruebas usan perfiles temporales, ventanas ocultas y recursos sintéticos.

## Empaquetado

Se mantiene electron-builder, elegido por §4; E0 no había fijado su versión. `npm run pack:win` produce solo un directorio Windows x64 con ASAR y `--publish never`. React/React DOM se declaran como dependencias de build porque el renderer las incorpora al bundle; evita distribuir otra copia de sus módulos. Incluye licencia original A3, textos de React/React DOM/Scheduler y avisos de Electron/Chromium. No firma, no publica y no construye NSIS/portable ni actualizador. `npmRebuild: false` es válido mientras no haya addons nativos de producción; se revisará al incorporarlos. La configuración usa icono predeterminado de Electron hasta contar con un asset propio.

## Alternativas y consecuencias

Un package único raíz reduciría configuración, pero mezclaría shell y contratos E0. Exponer ipcRenderer genérico o usar preload ESM exigiría una frontera más amplia o sería incompatible con el sandbox; se mantiene la API por método y CJS. Guardar estado de dominio en componentes o habilitar servicios de proyecto aquí anticiparía E1-B–F: las secciones son placeholders explícitos con navegación real y estado de sesión efímero.

La prueba de directorio no demuestra instalación, actualización ni recuperación de una actualización. A3-050 recibe evidencia de compilación/arranque y permanece abierto. Inventario y comprobaciones: [E1-A](../e1/desktop-foundation.md).

## Fuentes consultadas

- [E0: resumen](../e0/summary.md), [decisiones](../e0/decisions.md), [dependencias](../e0/dependencies.md).
- [electron-vite: estructura y preload sandboxed](https://electron-vite.org/guide/dev), [construcción](https://electron-vite.org/guide/build).
- [Electron: seguridad](https://www.electronjs.org/docs/latest/tutorial/security), [IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), [protocol](https://www.electronjs.org/docs/latest/api/protocol).
- [electron-builder: configuración](https://www.electron.build/configuration/), [registry npm oficial](https://registry.npmjs.org/).
