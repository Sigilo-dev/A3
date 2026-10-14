# E0-B1 — ChatGPT manual en WebContentsView

**Fecha de consulta y ejecución:** 2026-10-14. **Estado:** acceso manual parcialmente demostrado. La página pública cargó dentro del spike en Windows; el flujo de sesión y envío manual no se probó.

## Documentación y versión

La API elegida es `WebContentsView`, creada desde el proceso principal y colocada junto a otra vista en una `BaseWindow`. Electron 44.7.2 fue la estable publicada al ejecutar; incluye Chromium 152.0.7977.149 y Node.js 24.21.0. La instalación del spike fija exactamente `electron: 44.7.2`. La API `BrowserView` figura como obsoleta desde Electron 29 y sustituida por `WebContentsView`.

Fuentes oficiales consultadas el 2026-10-14:

- [WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view) — clase de vista disponible en el proceso principal.
- [Electron Releases](https://releases.electronjs.org/) — 44.7.2 como estable al ejecutar.
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) y [Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) — aislamiento de contexto, renderer sandbox y tratamiento de permisos remotos.
- [BrowserView API](https://www.electronjs.org/docs/latest/api/browser-view) — marcada obsoleta desde 29.
- [Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0) — portapapeles ahora usa lecturas y escrituras asíncronas; no se expone directamente a renderer.
- [What is ChatGPT? FAQ](https://help.openai.com/en/articles/12677804-what-is-chatgpt-faq) — ChatGPT web está en `chatgpt.com`; probar sin cuenta solo está disponible en regiones admitidas.
- [The ChatGPT home page](https://help.openai.com/en/articles/9125172-the-chatgpt-home-page) — el acceso sin cuenta está en despliegue por países compatibles y no guarda la conversación tras cerrar la sesión.

La documentación de OpenAI consultada describe el acceso desde la web, pero no declara compatibilidad específica de ChatGPT con Electron `WebContentsView`. La disponibilidad de conversación sin cuenta depende de la región y el despliegue. El resultado de esta máquina solo acredita la carga pública observada en esta ejecución.

## Diseño del spike

En `experiments/e0/chat-web/src/main.cjs`, la UI local y el contenido remoto viven en dos `WebContentsView` dentro de la misma `BaseWindow`. Las preferencias verificadas al ejecutar son `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webviewTag: false`, sin preload en el WebContents remoto y `allowRunningInsecureContent: false`. `webSecurity` conserva su valor seguro predeterminado.

El preload existe solo en la UI local y expone operaciones limitadas: copiar una cadena, reintentar ChatGPT, navegar atrás/adelante y aprobar la apertura de un enlace externo. Cada handler comprueba que el emisor sea el WebContents local. La vista remota no recibe API A3 ni IPC. Las solicitudes de permisos se rechazan, las descargas se cancelan y los popups no crean una vista nueva. Una redirección de página solo permanece integrada en `chatgpt.com` o un subdominio de `openai.com`; HTTPS de otro origen muestra una aprobación en la UI local antes de ofrecer abrirlo con `shell.openExternal`. Esquemas no HTTPS se bloquean.

La partición `a3-e0-b1-memory-only` no tiene prefijo `persist:` y `getStoragePath()` no informó una ruta persistente. `test/run.cjs` crea un perfil temporal exclusivo, espera que Electron termine y elimina ese directorio. No se inicia sesión ni se inspeccionan cookies.

Para abrir la PoC con ventana visible: `npm start --prefix experiments/e0/chat-web`. Al cerrar la ventana, el runner espera al proceso Electron y retira su directorio temporal. Al ejecutar la validación automática el perfil está vacío y se elimina después de cada corrida.

El texto seleccionado en el control de contexto se copia al portapapeles desde el main process mediante una llamada asíncrona. El prompt preparado usa la misma operación. La persona puede pegar el texto en la web; no hay lectura del DOM remoto, automatización de botones ni envío por A3.

## Comprobación ejecutada

Comando reproducible, desde la raíz del checkout:

```powershell
npm test --prefix experiments/e0/chat-web
```

Resultado de la ejecución final: exit code 0, `Electron 44.7.2`, `pass: true`, `E0_B1_PROFILE_CLEANUP=passed`. El reporte observó:

- Flags seguros efectivos en ambos renderers; la vista remota no tenía preload.
- Una página hostil sintética en `127.0.0.1` no encontró `process`, `require`, Electron, `ipcRenderer` ni el puente `a3Demo`. Un `fetch(file://...)` al manifiesto sintético del fixture falló.
- El demo copió realmente al portapapeles el texto de contexto seleccionado (30 caracteres) y el prompt (23 caracteres). No se pegaron en la página de ChatGPT durante la prueba.
- La navegación atrás/adelante funcionó en dos páginas locales de prueba. Se comprobaron las rutas permitidas para ChatGPT/OpenAI, la oferta de enlace HTTPS externo y el bloqueo de `javascript:`. No se lanzó un navegador externo, para no abrir un destino por automatización.
- `https://chatgpt.com/` terminó de cargar; el origen observado fue `https://chatgpt.com`. No se inspeccionó su DOM ni se enviaron consultas.
- El estado de error de la UI se verificó con un evento simulado desde la UI local; la carga pública real no produjo error.

El spike requiere instalar Electron por primera vez. `experiments/e0/chat-web/package.json` y su lockfile fijan esa dependencia local al spike; no se añadió al proyecto raíz ni a producción. Las licencias declaradas para los 13 paquetes fijados son:

| Paquete | Licencia |
|---|---|
| `electron@44.7.2`, `@electron/get@5.1.0`, `@types/node@24.19.2`, `debug@4.4.3`, `env-paths@3.0.0`, `ms@2.1.3`, `progress@2.0.3`, `undici@7.30.0`, `undici-types@7.24.6` | MIT |
| `@electron-internal/extract-zip@1.0.5` | BSD-2-Clause |
| `graceful-fs@4.2.11`, `semver@7.8.5` | ISC |
| `sumchecker@3.0.1` | Apache-2.0 |

Se leyeron `LICENSE` y `LICENSES.chromium.html` del paquete Electron descargado. La tabla cubre metadata del lockfile del spike y no es un inventario para distribuir un producto Electron; los binarios incluidos requieren su propio aviso completo.

## Estado respecto a aceptación y límites

**A3-026 — parcialmente demostrado.** La vista integrada cargó la web pública, el control copió texto al portapapeles y la UI muestra el camino manual para pegarlo en ChatGPT. No se pegó en ChatGPT, no se inició sesión y no se envió un mensaje; por tanto, no se declara exitoso el flujo manual completo. No se encontró una restricción externa al cargar la página pública en esta máquina. OpenAI documenta que la opción sin cuenta varía según país/región; esa condición no se intentó cambiar ni eludir.

**A3-027 — parcialmente demostrado.** Los flags de Electron, ausencia de preload y la sonda sintética muestran que el WebContents remoto de este spike no recibe Node, APIs A3 ni acceso de archivos vía `fetch(file://...)`. No equivale a una prueba de sandbox del sistema operativo frente a todas las técnicas, subprocesos, servicios locales, bugs Chromium/Electron o futuras regresiones. La sonda localhost es una página controlada, no el código de ChatGPT; no se inyectó JavaScript en la página de OpenAI.

No se probó autenticación, cookies de sesión, persistencia tras reinicio, logout, ventanas OAuth, cámara/micrófono, descargas permitidas, navegación externa real, compatibilidad de extensiones de navegador ni términos para un despliegue de A3. La denegación general de popups es una elección del spike y podría bloquear un flujo futuro de acceso; hay que probarlo manualmente dentro de la autorización del usuario antes de decidir el diseño de producto.

Si el proveedor impide el acceso integrado en otro equipo, A3 puede ofrecer “Abrir ChatGPT en el navegador externo”. El demo implementa una oferta de enlace HTTPS y requiere aprobación explícita, pero no abrió un navegador real durante estas comprobaciones. Ese fallback no cuenta como éxito de A3-026 dentro de la vista integrada.
