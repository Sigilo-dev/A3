# Sign in with ChatGPT y Codex app-server

Consulta de documentación oficial: 2026-10-14. La especificación maestra local es la versión 1.0.0; este informe no modifica sus decisiones.

## Resultado

La ruta OSS es técnicamente compatible con la decisión de A3 de usar el plan autorizado por la persona, sin una API key pagada por el desarrollador. La documentación actual describe OAuth público para apps abiertas y un adaptador local Codex app-server. Aquí se inició un app-server local con un perfil vacío y se completó `initialize` sin credenciales. No se autorizó una cuenta ni se hizo inferencia, por lo que la elegibilidad, el acceso a modelos, los límites y la desconexión siguen sin probarse en una cuenta real.

Estado de E0-B2: **viabilidad preliminar favorable; A3-028, A3-029 y A3-030 no aprobados**. El handshake local confirma disponibilidad del proceso y del primer paso del protocolo, no la integración completa.

## Requisitos que documenta OpenAI

La vía sin API key es específica para apps abiertas y ejecución local. La persona inicia el registro dinámico en el navegador del sistema: A3 enviaría su nombre real como `agent_name_hint`, un `ext_agent_host_id` estable por instalación y `client_id=dynamic_agent_client`. OpenAI devuelve un `client_id` emitido para esa cuenta y workspace; la app lo conserva para autorizaciones posteriores. El flujo público usa PKCE, `state`, `nonce` y callback HTTP loopback en `127.0.0.1`; los endpoints documentados son `https://auth.openai.com/api/accounts/authorize` y `https://auth.openai.com/api/accounts/oauth/token`. No requiere secreto de cliente ni una API key de plataforma. La documentación llama a esta capacidad uso del plan para usuarios elegibles; no permite deducir si una cuenta concreta cumple política, región, workspace o disponibilidad.

Los scopes de identidad son `openid profile email`. Para pedir uso del plan se solicitan además `offline_access resource.invoke chatgpt.tokens.use.direct`; A3 solo podría inferir tras validar los scopes realmente concedidos. La autorización de identidad por sí sola no habilita consultas y ningún scope da acceso a conversaciones, historial o memoria de ChatGPT.

OpenAI indica que la aplicación conserva identidad validada, client ID, access/refresh/ID tokens, scopes y vencimientos en almacenamiento local protegido, fuera del navegador, logs y control de versiones. El access token vive una hora; el refresh token, 30 días, y cada renovación exitosa lo rota. La app debe serializar renovaciones, sustituir el conjunto de credenciales de forma atómica y revocar el refresh token mediante el `revocation_endpoint` publicado por OpenID Discovery al desconectar. ChatGPT no notifica a la app cuando se revoca desde Ajustes; una petición/renovación posterior puede revelar esa desconexión.

Para A3, la inferencia de diseño es mantener las credenciales en el proceso principal, usando el almacén protegido exigido por §21.4, y pasar al proceso hijo solo el access token vigente en `ACCESS_TOKEN`. La guía oficial ejemplifica un archivo local con permisos de propietario; A3 aún debe cerrar la integración concreta con `safeStorage`/almacén del sistema y su recuperación. El token no debe entrar al renderer, al proyecto, al historial ni al registro de diagnóstico.

La configuración oficial de app-server usa `codex app-server --listen stdio://`, proveedor Responses en `https://api.openai.com/v1`, `env_key=ACCESS_TOKEN`, `wire_api=responses`, `requires_openai_auth=false` y `supports_websockets=false`. No requiere otro login de Codex: usa el token OAuth autorizado para el plan. El protocolo externo es JSON por línea en stdin/stdout. Se envía `initialize` con `clientInfo.name/title/version`, se espera la respuesta y se emite `initialized`; luego se usan `thread/start` o `thread/resume`, `turn/start`, eventos como `item/agentMessage/delta` y el resultado `turn/completed`. Solo `turn.status=completed` es éxito. Al renovar el token, la guía indica reiniciar app-server e inicializarlo otra vez antes de reanudar el thread guardado.

La página de app-server no asigna un número independiente de versión al protocolo. La documentación del CLI dice que `generate-json-schema` y `generate-ts` producen contratos específicos de la versión de Codex ejecutada. A3 debe fijar el binario/paquete exacto y generar o verificar el esquema contra ese mismo artefacto; el identificador semántico será la versión del artefacto mientras OpenAI no documente otra versión del protocolo.

`model/list` puede devolver un catálogo empaquetado o cacheado, no una prueba de derechos. Un turno de inferencia completado verifica el modelo únicamente para esa solicitud. La ruta de uso del plan requiere Responses API con `store: false` y `stream: true`; hay campos y herramientas no admitidos, entre ellos audio/video, Files API, transcripción, generación de imágenes, file search, Code Interpreter, computer use nativo y MCP alojado. Las herramientas locales de app-server/MCP son otro plano: su disponibilidad no concede permiso de proyecto; A3 aún debe aplicar sus capacidades y sandbox.

La guía de inicio menciona ChatGPT Plus y Pro elegibles. Para Plus, el límite de cinco horas se comparte entre apps; el límite de cinco horas no aplica a Pro, aunque pueden existir límites por app/plan o créditos. Los errores de elegibilidad, uso agotado o indisponibilidad deben permanecer visibles: OpenAI describe respuestas 401/403/429/503 y prohíbe tratar el catálogo como permiso. El diseño de A3 no debe cambiar silenciosamente a facturación de API.

OpenAI publica el CLI y app-server como componentes de código abierto y señala el repositorio donde vive su fuente. Las páginas oficiales consultadas no fijan aquí la licencia exacta del binario que A3 distribuiría. Antes de empaquetar, el propietario debe fijar una release, revisar su `LICENSE`, avisos y licencias de dependencias, y confirmar que el modo de distribución está cubierto. La afirmación “es open source” no sustituye ese inventario.

## Evidencia ejecutada localmente

Se detectó Codex CLI `0.162.0-alpha.17.2` en Windows, con Node.js `24.13.1` y npm `11.10.0`. El spike de `experiments/e0/codex-app-server/` inicia `codex app-server --listen stdio://` con un `CODEX_HOME` temporal aislado y un entorno permitido que excluye `ACCESS_TOKEN`, `OPENAI_API_KEY` y `CODEX_API_KEY`. El test envía `initialize` con metadatos A3, recibe respuesta sin error, emite `initialized`, cierra stdin y limpia el perfil temporal. Ejecutado con `npm test --prefix experiments/e0/codex-app-server`: pasó. No se ejecutó `thread/start`, `turn/start`, `model/list`, una renovación ni una llamada de red de inferencia. La prueba acredita arranque y handshake de esta build sin login, no una consulta efectiva ni el acceso a modelos.

La guía oficial describe eventos y métodos del ciclo de conversación, pero la prueba local solo cubre inicialización. No se simularon turnos ni se utilizó una cuenta real. Un mock de eventos probaría únicamente el parser de un futuro adaptador, que aún no existe, y no cambiaría este resultado.

## Matriz de evidencia y siguiente acción

| Afirmación o comprobación | Documentación oficial | Prueba local ejecutada | Requiere cuenta/registro de usuario | Acción del propietario de A3 | No comprobable aquí |
|---|---|---|---|---|---|
| Existe una vía de plan para apps OSS locales sin API key del desarrollador | Verificado | — | Cuenta compatible y consentimiento para usarla | Implementar el flujo OSS y mantener la app distribuida como abierta | Admisión real de A3 y elegibilidad concreta |
| Registro OAuth dinámico, PKCE, scopes y renovación | Verificado | — | Sí, para emitir credenciales reales | Implementar callback, validación OIDC, almacenamiento protegido, refresh rotatorio y revocación | Consentimiento, scopes efectivos y ciclo real |
| Codex app-server puede iniciar y completar `initialize` sin login | El protocolo está documentado | Verificado con CLI `0.162.0-alpha.17.2`, sin tokens | No para inicializar | Fijar versión y perfil aislado; no heredar configuración personal | Compatibilidad con la release final que A3 distribuirá |
| Catálogo de modelos equivale a acceso efectivo | La documentación dice que no | No se consultó `model/list` | Sí para demostrar uso del plan | Mostrar catálogo como informativo y errores reales de acceso | Acceso de una cuenta/modelo en esta región y workspace |
| Turno Responses completado mediante token del plan | Requisito documentado | No ejecutado | Sí: cuenta elegible, registro y autorización | Implementar proveedor, stream, errores y no-fallback de pago | Inferencia y límites reales |
| Renovar, revocar y desconectar una sesión | Procedimiento documentado | No ejecutado | Sí, para prueba de extremo a extremo | Implementar rotación segura y estados de revocación | Respuesta real del endpoint en esta cuenta |
| Interrumpir y reanudar sin duplicar cambios A3 (A3-030) | `thread/resume` existe; la idempotencia de efectos A3 no está garantizada por ello | No ejecutado | Turno real para probar ciclo externo | Conservar `operationId`, revisión/resultado y deduplicación según contrato E0-A; probar recuperación | Reanudación real y no duplicación de cambios persistidos |
| Licencia para redistribuir la versión elegida | OpenAI identifica app-server como fuente abierta, sin fijar aquí la licencia del artefacto | No se inspeccionó una release para distribuir | — | Elegir release y auditar LICENSE/NOTICE/dependencias | Permiso de distribución del bundle concreto |

## Implicaciones para A3-028–030

**A3-028:** la arquitectura aprobada sí tiene una vía compatible sin API key pagada por A3, pero el caso de aceptación exige conectar una cuenta elegible, autorizar el scope de uso, completar un turno y desconectar. Solo se verificó que el proceso local inicia sin login; A3-028 queda abierto.

**A3-029:** están documentados catálogo frente a acceso, límites compartidos y códigos de error; no se simularon o provocaron en esta prueba un modelo no permitido, token vencido o límite agotado. A3 debe representar esos estados y no cambiar de facturación silenciosamente. El caso sigue abierto.

**A3-030:** el servidor permite reanudar el historial mediante `thread/resume`, pero eso no hace idempotentes las herramientas que modifican datos A3. El contrato E0-A de `operationId` y revisiones sigue siendo necesario; se requiere después una prueba de interrupción durante una escritura real y una reanudación sin duplicación. A3-030 sigue abierto.

La arquitectura puede continuar con un adaptador a app-server, pero su estado debe ser `not-configured` hasta que exista OAuth válido y `access-denied`/`temporarily-unavailable` cuando correspondan. La apertura del proceso o la lista de modelos no deben activar el estado `available`. La conexión OAuth no concede permisos al proyecto ni a herramientas locales. Si el usuario no puede o no desea autorizar el plan, el fallback de diseño es el flujo manual de A3-026 o un proveedor que configure explícitamente; no se usa API key del desarrollador.

## Fuentes oficiales consultadas el 2026-10-14

| Fuente | Uso |
|---|---|
| [Sign in with ChatGPT: Quickstart](https://developers.openai.com/siwc/quickstart) | Oferta OSS, usuarios elegibles, identidad frente a scopes de plan. |
| [Uso local OSS: visión general](https://developers.openai.com/siwc/token-sharing-open-source) | Registro dinámico, client ID, host ID y flujo general. |
| [Registro y acceso](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | PKCE, callback, scopes, consentimiento y validación. |
| [Sesiones y renovación](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | Almacenamiento, refresh y revocación. |
| [Codex app-server para uso del plan](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | Configuración Responses, stdio, métodos y eventos. |
| [Modelos e inferencia](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Catálogo frente a acceso e inferencia completada. |
| [Errores y recuperación](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | Denegación, elegibilidad, límites, desconexión y refresh. |
| [Limitaciones de vista previa](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Campos, herramientas y transportes admitidos. |
| [Codex app-server](https://developers.openai.com/codex/app-server) | Contrato general, schema por versión y ciclo de vida del protocolo. |
| [Componentes open source de Codex](https://developers.openai.com/codex/open-source) | Ubicación oficial del source y alcance de componentes abiertos. |

La documentación SIWC consultada no declara un número de versión independiente del protocolo. El protocolo debe verificarse con el esquema generado por la versión exacta del CLI que se fije para A3.
