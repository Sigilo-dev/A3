# E1-A — Base Electron para Windows

Fecha: 2026-10-14. Base aceptada: E0-E `a6d8c13`; rama de entrega `codex/e1-base`. La especificación y los prompts siguen locales/excluidos; sus contratos E0-A y evidencias E0 continúan publicados sin modificación.

## Entrega

`apps/desktop/src/main` administra una ventana, sesión local, protocolo de assets, errores de inicio y cierre. `src/preload` ofrece solo `getAppInfo`; `src/shared` contiene el contrato tipado. `src/renderer` es React sin Node, con navegación inicial a las 14 áreas de §9.2, estado de conexión, actividad plegable y recuperación visible de errores. Las áreas indican explícitamente que sus funciones se implementarán en etapas posteriores. No se construyó dominio, persistencia, chat remoto o agente.

La [ADR 0001](../adr/0001-desktop-shell.md) explica el workspace, la frontera IPC, CJS sandboxed, protocolo `a3`, CSP, dev server y empaquetado de prueba. No se conceden capacidades de proyecto por esta consulta de versión.

## Reproducción

Desde el root con Node.js 24.13.1/npm 11.10.0:

```sh
npm ci
npm run dev
```

Cerrar la ventana termina Electron. Puedes terminar la sesión de desarrollo cerrando la ventana o con Ctrl+C en la terminal.

Para compilar y ejecutar el resultado:

```sh
npm run typecheck
npm run build
npm start
npm run test:desktop
npm run pack:win
node apps/desktop/test/run-smoke.mjs --packaged
node apps/desktop/test/run-smoke.mjs --development
```

El modo `--packaged` prueba el main/preload/renderer contenido en el ASAR con el runtime Electron fijado; no ejecuta un instalador. El modo `--development` arranca Vite con `--rendererOnly`, conecta el main compilado y termina ese servidor al finalizar. Los tests no añaden switches ni métodos privilegiados a la aplicación. Ocultan ventanas y sustituyen el diálogo nativo en el harness para poder verificar el mensaje sin interacción. El modo normal añade dos fixtures negativos con renderer/preload ausentes.

## Dependencias y licencias

Pins nuevos del workspace, verificados con metadata del registry npm oficial y los paquetes instalados:

| Paquete | Versión | Licencia declarada |
|---|---|---|
| Electron | 44.7.2 | MIT; binario contiene otras licencias |
| React / React DOM | 19.3.1 | MIT |
| Vite | 8.3.4 | MIT |
| electron-vite | 6.0.0 | MIT |
| electron-builder | 26.15.3 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| @vitejs/plugin-react | 6.1.2 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/react / @types/react-dom | 19.3.0 | MIT |

Ajv 8.20.0 permanece sin cambio en E0. React/React DOM/Scheduler se incorporan al JavaScript del renderer, por lo que son deps de build y no se distribuye otra copia de node_modules. Scheduler y todas las transitivas quedan fijados por el lock. Este modelo no elimina obligaciones de sus licencias.

Se revisaron los textos LICENSE instalados de Electron y React, y la presencia del inventario completo `LICENSES.chromium.html` del runtime. El directorio Windows incluye `LICENSE.a3.txt`, `LICENSE.electron.txt`, `LICENSES.chromium.html` y los textos MIT de React/React DOM/Scheduler bajo `licenses/`. El código original A3 incluye MIT en la raíz. La metadata del lock no presenta licencias ausentes; también declara ISC/BSD/Apache, Python-2.0, CC-BY-4.0, BlueOak, MPL-2.0, 0BSD, CC0 y WTFPL en herramientas/transitivas. No se considera una auditoría jurídica del bundle final.

`npm audit` encontró 8 alertas moderadas en el árbol de desarrollo de electron-builder, propagadas desde `sprintf-js <=1.1.3` por roarr/global-agent/@electron/get. No hubo alertas altas o críticas. [Advisory GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). El fix sugerido cambia electron-builder a 26.5.0; no se aplicó un downgrade sin revalidar. Estas herramientas no se incluyen en el ASAR. Se conserva como pendiente del toolchain; las advertencias de paquetes deprecados se registran y no se ocultan. No se incorporó FFmpeg, Java, Git, Codex ni los paquetes del spike Milkdown.

## Evidencia y límites

Los resultados finales de instalación, build, smoke y paquete se registran en [AUDIR.md](../../AUDIR.md). Entorno real: Windows 10 x64, build 19045, Node host 24.13.1 y npm 11.10.0; Electron 44.7.2 contiene Chromium 152.0.7977.149 y Node 24.21.0.

El smoke verifica aislamiento de renderer, API mínima, rechazo de otro WebContents, navegación/actividad, CSP de producción, bloqueo de popups/navegación externa, y cierre de la ventana con salida normal. Los casos negativos verifican que renderer/preload ausentes produzcan el diálogo de inicio y salida 1. La versión A3 leída en el harness puede ser la del ejecutable Electron de test; no se usa como comprobación del recurso de versión del EXE. No se prueba aislamiento de procesos arbitrarios ni todas las capacidades futuras.

**A3-050: abierto, con evidencia parcial de compilación/arranque.** Se construye un directorio x64 unsigned; falta instalador NSIS/portable, icono propio, firma opcional, actualizador, rollback de actualización, proyectos reales y aceptación en Windows 11. No se publica release ni se cambia un proyecto del usuario. La integración de E1-B–F sigue pendiente.
