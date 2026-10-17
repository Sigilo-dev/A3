# E5-B2 · ciclo de autorización Codex

Base: rama `codex/e3-e7-product`, encima de E5-B1. Especificación §§20.2–20.3 y criterios A3-028/029. Contratos: E0-B2 separa identidad, permiso de plan, catálogo y uso efectivo; E0-A mantiene secretos en el host; E0-C2 no habilita procesos arbitrarios. La autorización OAuth está descrita en [E5-B1](chatgpt-authorization.md) y [ADR 0021](../adr/0021-official-chatgpt-authorization.md).

## Estados y efectos

El host conserva, por registro de cuenta, la última condición de proveedor junto a la sesión OAuth cifrada. Una respuesta exitosa puede acreditar que hubo una inferencia completada; esto solo significa que funcionó esa consulta, no que un modelo vaya a estar disponible en consultas futuras.

| Estado | Señal aceptada | Efecto | Acción visible |
|---|---|---|---|
| Desconectado | No hay credenciales o se desconectó OAuth | Limpia tokens/condición de ese registro; conserva su identidad local | Conectar o usar chat manual |
| No elegible | `subscription_sharing_user_not_eligible` | Conserva tokens; impide otro turno y repetir login para ese registro | Agregar otra cuenta/workspace o usar chat manual |
| Límite agotado | `subscription_sharing_usage_limit_exceeded` | Conserva tokens; impide otro turno. No adivina hora de reinicio ni compra créditos | Ver uso de ChatGPT o usar chat manual |
| No disponible | indisponibilidad/denegación temporal, ruta o consulta interrumpida | Conserva tokens; informa un diagnóstico fijo; no cambia de facturación | Reintentar luego o usar chat manual |
| Token vencido/rechazado | Expiración local, refresh terminal o rechazo de credencial | Un rechazo solicita un solo refresh oficial; un refresh terminal borra tokens inutilizables y exige nueva autorización | Renovar o volver a autorizar |
| Conectado | Tokens vigentes con scopes de uso del plan | Permite que el futuro adaptador evalúe una consulta; el scope no demuestra acceso efectivo | Elegir proveedor/modelo cuando exista el adaptador |

`chatpass_v2_scope_not_authorized` y `chatpass_v2_invalid_authorization_context` se presentan como denegación de permiso; `subscription_sharing_route_not_supported` como acceso/ruta no disponible. El código explícito `subscription_sharing_usage_limit_exceeded` marca límite agotado; un 429 sin ese código queda como rate limit temporal y no se etiqueta como cuota agotada. Las respuestas 401/403/503 genéricas reciben mensajes seguros. El clasificador solo retorna códigos constantes; no guarda cuerpos, mensajes, request IDs ni credenciales del proveedor. Los errores de solicitud sin estado conocido no mutan el registro.

Refresh obtiene endpoints del discovery oficial ya validado y usa client ID y refresh token del registro activo. Revocación usa el endpoint oficial publicado; si no se confirma, A3 informa que solo eliminó credenciales localmente. Desconectar OAuth no limpia cookies ni cierra la sesión de la pestaña web manual. Ningún estado compra créditos, usa API key del desarrollador o cambia a facturación de API. El enlace «Ver uso de ChatGPT» abre únicamente `https://chatgpt.com/settings/usage`.

El estado de inferencia se marca solo con el resultado terminal `completed`; catálogo, login y scopes no lo marcan. Las señales entran a `CodexProviderStatusAdapter` en el host, fuera de IPC/proyectos/plugins. El gate host impide turnos en estados no elegible y límite agotado. Los fallos no disponibles mantienen credenciales para un intento futuro. La política de reintento/backoff del app-server se completará con su adaptador E5 posterior.

## Verificación

```powershell
npm run test:auth --workspace @a3/desktop
npm run typecheck --workspace @a3/desktop
npm run build --workspace @a3/desktop
npm run test:auth:smoke --workspace @a3/desktop
npm run test:chat:policy --workspace @a3/desktop
npm run test:chat --workspace @a3/desktop
```

`fixtures/e5/codex-auth/provider.json` agrega únicamente cuerpos sintéticos de los errores oficiales. Los tests usan adapter y vault fake; prueban no elegible, límite agotado, indisponibilidad, consulta completada, rechazo de credencial, refresh oficial exitoso/terminal, desconexión y selección de cuenta. Verifican retención de credenciales ante fallos no terminales, redacción de detalles, URL fija de uso y que el diagnóstico siga a la cuenta seleccionada. No imprimen tokens reales ni acceden a una cuenta.

## Criterios y límites

| Criterio | Evidencia | Pendiente |
|---|---|---|
| A3-028 | Ciclo de registro/refresh/revocation sintético y almacenamiento DPAPI del host verificado por E5-B1; el adapter solo renueva/revoca por endpoints oficiales. | Cuenta real elegible, autorización real, turno real, refresh/revocación real de extremo a extremo. |
| A3-029 | Estados sintéticos diferenciados para elegibilidad, token vencido/rechazado, cuota, proveedor no disponible y ruta/modelo denegado; sin fallback de pago. | Conectar el clasificador a un app-server fijado, comprobar rechazos/turnos reales, catálogo y límites de una cuenta. |

No hay llamadas de inferencia ni app-server integrados en E5-B2, así que el adaptador fake verifica el contrato y la interfaz de estado; no acredita disponibilidad real. El modo manual sigue independiente. La guía de OpenAI indica que una cuenta no elegible no debe reintentar en bucle OAuth, que agotamiento/indisponibilidad debe mostrarse sin inferir su reinicio y que los rechazos no cambian de facturación; refresh y logout siguen el flujo oficial. Fuentes: [errores y recuperación](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [sesiones y logout](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), consultadas el 2026-10-17.
