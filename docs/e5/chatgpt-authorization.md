# E5-B1 · autorización oficial ChatGPT

Base: `codex/e3-e7-product`, E5-A1 `637f616`. Fecha: 2026-10-17. Contratos: A3 §§20.1–20.2/21.4; E0-B2 identidad frente a permiso del plan; E0-A separación de secretos/datos y autoridad del host; E0-C2 capacidades externas no demostradas. [ADR 0021](../adr/0021-official-chatgpt-authorization.md) explica endpoints, controles, dependencia y límites.

## Uso

«Agente» ofrece «Continue with ChatGPT», cancelación y alternativa «Abrir chat manual». La autorización se abre en el navegador del sistema. Después de validar la identidad se muestra el permiso realmente concedido; identidad sin scope del plan ofrece «Autorizar uso del plan», con consentimiento explícito. No se simula inferencia con un login exitoso. No se toma la sesión del navegador embebido.

Se pueden añadir registros de otra cuenta/workspace, seleccionarlos, renovar y desconectar OAuth. Los IDs y etiquetas opacas distinguen registros aunque la persona use el mismo email; los claims no salen al renderer. Reautorizar reutiliza el client ID de ese registro y el host ID de la instalación. No se modifican permisos del proyecto. Desconectar conserva la asociación para un próximo login, borra los tokens y muestra si la revocación remota no se confirmó.

Tokens y host ID se cifran con DPAPI en el perfil local de A3; no se usan recursos ni memoria del proyecto. Un archivo protegido ilegible se conserva con diagnóstico. Un sistema sin backend validado conserva el modo manual. La sesión guardada se restaura localmente sin red; expirar impide marcar permiso vigente. La revocación remota efectiva se comprobará en refresh o en las consultas del futuro adaptador, nunca se deduce del estado guardado.

## Evidencia reproducible

```powershell
npm run test:auth --workspace @a3/desktop
npm run build --workspace @a3/desktop
npm run test:auth:smoke --workspace @a3/desktop
npm run test:chat:policy --workspace @a3/desktop
npm run test:chat --workspace @a3/desktop
```

Fixture: `fixtures/e5/codex-auth/provider.json`, solo metadatos sintéticos. Los tests generan claves efímeras y tokens de prueba en memoria; no leen una cuenta ni credenciales reales. Los fakes de transporte están en tests, no en un endpoint o variable de entorno de producción.

Resultado observado: 24 pruebas dirigidas, 2 ejecuciones Electron sucesivas del smoke OAuth y regresión E5-A1 (2 pruebas de política y su smoke) correctas. La compilación local y los tipos pasaron; permanece el aviso previo de chunks grandes del renderer.

Pruebas dirigidas: endpoints/redirect/PKCE, callback Host/ruta/origen, state inválido/duplicado, consentimiento rechazado, cancelación antes/durante exchange y durante reemplazo de credenciales, firma/issuer/audience/nonce/exp/azp inválidos, identidad sin permiso, reconsentimiento, mismatch de cuenta/client, registro emitido tras `invalid_grant`, cuentas separadas, refresh rotatorio/serializado, ID token opcional de refresh, errores terminales/temporales, revocación no confirmada, expiración/restauración, motor seguro ausente/corrupto, discovery no admitido, timeout, navegador no disponible y payloads no permitidos.

El smoke ejecuta Electron 44.7.2 en Windows con perfil y proyecto temporales. Abre la UI «Agente», usa callback HTTP loopback real con proveedor interceptado, cancela y rechaza state incorrecto sin intercambiar código. Prueba cifrado/descifrado DPAPI real, ciphertext sin marcador sensible, respuestas IPC sin secretos y guards instalados frente a WebContents/frame remoto real. Dos procesos consecutivos comprueban reapertura sin reautorizar y desconexión. Logout manual y OAuth permanecen independientes en ambos sentidos. Los archivos portables del fixture se comparan byte a byte y los logs se revisan contra los marcadores sintéticos. Se limpia solo el temporal verificado.

## Criterios y límites

| Criterio | Evidencia de esta entrega | Pendiente |
|---|---|---|
| A3-028 OAuth | Flujo oficial implementado; validación y ciclo sintéticos; credenciales host con DPAPI real; sin API key. | Cuenta elegible, consentimiento/renovación/revocación reales y turno completado. No se cierra el criterio completo. |
| A3-029 acceso/límites | Scope ausente, expiración, 401/403/429/503 de autorización con diagnóstico y modo manual, sin fallback de pago. | Verificar admisión real, modelo no accesible y límites de inferencia del adaptador. |
| A3-027 aislamiento | Canal nuevo accesible solo al shell; pestaña remota sin puente; regresión E5-A1. | Restricciones/login reales de cada proveedor siguen sin acreditarse. |
| A3-031–033 permisos | La conexión de cuenta no concede capacidades ni expone operaciones del proyecto. | Integrar cada futura herramienta del agente al broker aceptado. |

No hay app-server, catálogo, turno, herramientas, comandos arbitrarios ni lectura de chats en E5-B1. La renovación es explícita, sin temporizador de consultas o consumo. Linux permanece manual hasta validar un almacén protegido. No se declara instalador de publicación ni resistencia a corte eléctrico/host comprometido. Fuente vigente: [registro](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [sesiones](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [errores](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) y [discovery público](https://auth.openai.com/.well-known/openid-configuration), consultados el 2026-10-17.
