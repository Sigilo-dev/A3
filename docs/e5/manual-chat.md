# E5-A1 · pestaña web manual

Entrega sobre `codex/e3-e7-product`, desde E4-E1 `14a7083`. Fuentes: A3 §19.1–19.3, criterios A3-026/027 y contratos E0/E1 de aislamiento, sesión y separación del dominio. Fecha de evidencia: 2026-10-17. [ADR 0020](../adr/0020-isolated-manual-chat.md) fija estructura, APIs y política.

## Uso y alcance

Chat web abre ChatGPT inicialmente. La barra mantiene URL editable y origen real separados del título remoto; ofrece atrás, adelante, recargar, pestañas, cerrar, entrar al sitio, cerrar sesión local y abrir externamente. Esc o Ctrl+L devuelve el foco a la URL del shell; las pestañas tienen nombres accesibles y selección con flechas. Un fallo de red/carga o renderer se diagnostica sin convertirlo en fallo del proyecto.

Prompts añade «Abrir ChatGPT manual». «Copiar parte» escribe el resultado elegido en el portapapeles mediante el host con validación de sesión y límite de 1 MiB UTF-8. No se concede acceso programático del sitio al portapapeles. La persona cambia a la web, pega y envía; copiar/abrir no inicia agente, registra resultados IA, completa tareas, adjunta archivos ni cambia memoria. Puede copiar respuestas manualmente y usar el editor/pegado existente de A3; no hay scraping ni sincronización de conversaciones.

El estado de navegación se conserva durante la sesión mientras la pestaña esté viva. Cambiar sección o abrir actividad/modal local retira la vista nativa, conservando el formulario. No se suspende ni reinicia automáticamente una página oculta; un stream multimedia ya aprobado puede continuar hasta que el sitio lo detenga, se revoque el permiso o se cierre la pestaña. Cerrar/cambiar proyecto/salir avisa de posible pérdida de texto; cancelar conserva las vistas y el proyecto. Al cambiar de proyecto se cierran las pestañas y cancelan descargas; no se restauran sus IDs en la siguiente sesión. Máximo: ocho vistas, sin afirmar objetivos de memoria para ocho sitios pesados.

## Límites de confianza

`src/main/manual-chat.ts` administra vistas y su partición. `src/shared/manual-chat.ts` valida mensajes, URL y región; el preload solo expone ese contrato al shell local. El renderer remoto no tiene Node, preload A3, API de archivos ni transporte de agente. El controlador no recibe el servicio de archivos del proyecto. Todos los handlers A3 continúan comprobando emisor y frame, incluida la nueva ruta de navegador. Las APIs de ejecución, evaluación de JavaScript remoto y rutas no existen en el contrato.

La partición persistente del proveedor vive bajo `app.getPath('userData')`. No se escribe URL, cookie, token, conversación ni perfil de navegador en `.a3`, memoria, snapshots o Git. Las cookies pueden conservar la cuenta entre proyectos, como identidad web local; las sesiones de trabajo y pestañas están separadas por la sesión vigente del proyecto. La aplicación no convierte la memoria del proveedor o sus conversaciones de cuenta en contexto A3. OAuth del agente permanece independiente.

Las comprobaciones de URL se aplican a controles, frames, redirecciones, popups y recursos. Se aceptan HTTPS público y WSS para recursos; se bloquean `file:`, `a3:`, HTTP, credenciales en URL, hosts locales/IP literales y esquemas de programas. Los data/blob de subrecursos no se convierten en navegación. No se modifican certificados o el user agent. Las reglas por URL no prueban contención de DNS, servicios con nombre público o vulnerabilidades Chromium; el sandbox de renderer no equivale a un launcher seguro de comandos de E0-C2.

Cámara/micrófono requieren consentimiento nativo por origen y frame principal visible; las concesiones duran esta ejecución de A3, con indicador y revocación. Revocar recarga las pestañas de ese origen tras avisar del texto pendiente. No se hereda permiso al navegar a otro origen. Captura de pantalla, dispositivos USB/HID/serial, FileSystem, notificaciones, geolocalización, acceso programático al portapapeles y permisos no definidos se deniegan. Eso no impide usar el menú/teclado manual normal para copiar y pegar texto.

Popups HTTPS requieren aprobación del origen y se abren como otra WebContentsView aislada, sin opener compartido ni preload. Otros protocolos se deniegan. Flujos de login que requieran un opener, browser completo, extensiones o condiciones del proveedor pueden fallar; «Abrir externamente» pide confirmación y entrega únicamente la URL HTTPS al navegador del sistema. No transfiere cookies, prompts, tokens o archivos. El mensaje distingue esta alternativa de un login integrado verificado.

Descargas directas HTTPS exigen gesto manual y origen iniciador (`getInitiatorOrigin`) coincidente con el frame principal visible. Un diálogo nativo síncrono en `will-download` muestra ese origen y el del archivo, exige destino y confirmación de sobrescritura antes de fijar la ruta. Cancelado/interrumpido no se anuncia como completado. No se abre ni ejecuta el resultado ni se registra un Resource automáticamente. Otros flujos, incluidos blob, descargas sin gesto y origen desconocido/subframe distinto, se bloquean con aviso y alternativa externa. No se incorpora la descarga al journal A3 como una edición de proyecto; guardar voluntariamente dentro de una carpeta del proyecto sigue siendo una elección explícita del diálogo, no importación del recurso por A3.

«Cerrar sesión web local» confirma el cierre de todas las pestañas del proveedor y cancela descargas, elimina cookies/almacenamiento/caché y autenticación local mediante Session. No revoca sesiones del servicio en otros equipos ni cierra el navegador externo/app-server. Una limpieza fallida se diagnostica y bloquea nuevas vistas hasta reintentar, sin anunciar logout exitoso.

## Pruebas y reproducción

```powershell
npm run typecheck
npm run build --workspace @a3/desktop
npm run test:chat:policy --workspace @a3/desktop
npm run test:chat --workspace @a3/desktop
npm run test:focus --workspace @a3/desktop
npm run test:planning --workspace @a3/desktop
npm run test:variables --workspace @a3/desktop
```

Fixtures: `fixtures/e5/manual-chat/urls.json` y `provider.html`. Los dos tests puros cubren clasificación de URL, recursos, contratos acotados, credenciales, protocolos locales y payloads con scripts/rutas/campos extra. No se cambian dependencias ni el lockfile; Electron sigue fijado en 44.7.2.

El smoke crea dos proyectos temporales, un perfil nuevo y respuestas HTTPS sintéticas en la partición del proveedor. Usa WebContentsView real y compara todos los bytes portables antes/después. Comprueba:

- Flags de aislamiento, proceso distinto, ausencia de `require/process/a3/ipcRenderer`, intento real de invocar el puente desde la página, `fetch(file://...)` y `fetch(a3://...)` denegados.
- Los handlers instalados de proyectos/archivos/Markdown/planificación/chat rechazan tanto el WebContents remoto como una combinación de shell con frame remoto. Esta segunda prueba invoca los guards desde el arnés; no presupone que el remoto tenga IPC disponible.
- Copy de un resultado del compilador y acceso por su botón a Chat web, sin pegado/envío automático; interacción manual del fixture, ocultar/restaurar texto, modal local, resize, atrás/adelante/recargar y retorno de foco por teclado.
- Cookies separadas del shell, ruta de perfil fuera del proyecto, autorización/revocación de micrófono con dispositivos falsos, solicitudes de otro origen/subframe y FileSystem denegadas.
- Popup denegado/aprobado con nueva vista aislada, cancelación de cierre, error de carga de login, alternativa externa cancelada/aprobada, descarga controlada, cambio de proyecto cancelado/aprobado, sesiones/IDs anteriores denegados y logout que elimina cookies/localStorage. Destruir una vista libera su pestaña y permite abrir otra.

El arnés sustituye el portapapeles para no leer ni modificar el del usuario, y registra la llamada de apertura externa sin abrir un navegador real. En la descarga comprueba rechazo sin gesto, cancelación y destino elegido; sustituye el retorno del diálogo nativo por una ruta temporal y verifica sus opciones de origen/confirmación, sin automatizar el diálogo del SO. No inicia sesión ni inyecta código en una web real. Las sondas con `executeJavaScript` pertenecen solo al arnés y al HTML de fixture; producción no las tiene.

Resultado en Windows x64, Node host 24.13.1 y Electron 44.7.2: **2/2 tests puros**, smoke de chat con sus escenarios aprobado, regresión de focus en dos procesos (preparar/restaurar), planificación/intercambio y variables/compilador aprobados. Tipos de todos los paquetes y build desktop aprobados; permanece el aviso previo de chunks de diagramas mayores de 500 kB. No se repite toda la suite de producto, no se prueba Linux ni un instalador distribuible.

## Relación con aceptación

| Criterio | Evidencia de esta entrega | Límite |
|---|---|---|
| A3-026 · chat manual | Navegación/pestañas/URL, copia explícita y botón del compilador, entrada/respuesta de un sitio controlado, sesiones locales y fallback externo con consentimiento. | **Parcial para el proveedor real:** login de cuenta, pegado y envío manual efectivo a ChatGPT no ensayados. No se afirma compatibilidad universal o que fallback equivalga a éxito integrado. |
| A3-027 · aislamiento web | WebContentsView real sin Node/preload, proceso separado, probes de archivos y A3 bloqueados, guards de sender/frame, permisos por origen, partición separada y bytes del proyecto intactos. | Límite de aplicación/renderers de esta versión, no prueba exhaustiva de sandbox del SO, red, vulnerabilidades o canales laterales. E0-C2 no se declara resuelto para procesos arbitrarios. |

No se entregan agente, OAuth, automatización de chats, acceso a conversaciones privadas, plugins de proveedores, captura de pantalla, restauración de formularios web tras reinicio, descarga universal ni suspensión automática. El formato, permisos y memoria del proyecto conservan su autoridad anterior.
