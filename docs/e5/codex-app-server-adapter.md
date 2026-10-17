# E5-C1 · Codex app-server session adapter

Evidencia histórica de E5-C1 (`dfef97c`). Continuación del transporte y las sesiones: [E5-C2](resumable-turns.md) y [ADR 0022](../adr/0022-resumable-codex-turns.md).

## Contrato aplicado

La implementación usa el contrato oficial de app-server: JSON-RPC 2.0 sobre JSONL por `stdio`, con la cabecera `jsonrpc` omitida en el transporte. Cada petición incluye `method`, `params` e `id`; la respuesta correlaciona el ID. El cliente manda un único `initialize` por conexión y, solo si recibe un resultado válido, responde con la notificación `initialized`. A3 no envía `thread/start`, `turn/start` ni solicitudes de herramientas en este bloque. La documentación oficial indica que los esquemas generados son específicos de la versión exacta de Codex ejecutada y no publica una versión independiente del protocolo.

El adaptador valida el binario contra una versión y SHA-256 aprobados por la distribución antes de iniciarlo. El proceso usa argumentos fijos, `shell: false`, un `CODEX_HOME` exclusivo en `userData` y un entorno permitido; no hereda `ACCESS_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME` ni la ruta del proyecto. stdout es solo protocolo; stderr se drena y descarta. Los errores son códigos A3 con mensajes fijos y no contienen texto arbitrario del proveedor.

La instancia host se crea sin binario configurado. `start()` es la única acción que inicia el hijo; abrir o cambiar de proyecto no lo ejecuta. El perfil del proveedor vive fuera de los proyectos. Al cerrar A3, el host cierra stdin, espera el cierre y aplica una terminación acotada si hace falta.

## Versión y distribución

En este entorno se verificó localmente Codex CLI `0.163.0-alpha.10.2`, usando el esquema JSON generado por ese mismo artefacto. El smoke test confirmó el handshake local sin OAuth y sin iniciar hilos o turnos. Esta build alpha no se incluye en A3 ni se declara candidata de publicación. E0 no auditó la licencia, avisos ni dependencias de una release redistribuible; la distribución debe proporcionar explícitamente un artefacto aprobado, versión y SHA-256. El adaptador falla cerrado si falta esa configuración o si difiere el hash o la versión.

## Límites y trazabilidad

Este bloque cubre el límite del proceso, framing JSONL, handshake, errores tipados, verificación del artefacto y cierre. La respuesta inicial no se interpreta más allá de verificar que sea un resultado JSON; no se procesan eventos, conversaciones, OAuth ni turnos. La ejecución de herramientas, permisos por proyecto y sandbox siguen siendo responsabilidad de etapas posteriores. A3-028 no queda aceptado por un handshake sin cuenta, y A3-030 requiere pruebas de interrupción/idempotencia que aún no forman parte de E5-C1.

Pruebas: ejecutables ausentes/no configurados, huella y versión incorrectas, respuesta fragmentada válida, JSON malformado, línea truncada, límite de tamaño, timeout y limpieza. `npm run test:codex:app-server` ejecuta fixtures; `npm run test:codex:app-server:smoke` requiere `A3_CODEX_BIN`, `A3_CODEX_VERSION` y `A3_CODEX_SHA256`, y usa un perfil temporal sin credenciales.

## Fuentes oficiales

- [Codex app-server: protocolo, JSONL y esquemas por versión](https://learn.chatgpt.com/docs/app-server)
- [Codex app-server para uso autorizado del plan](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
