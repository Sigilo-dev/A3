# ADR 0022: turnos locales recuperables e identidad de operaciones

Estado: aceptada para E5-C2. Base: E5-C1 `dfef97c`, especificación §20.3/A3-030, contrato E0-A de comandos y journal E1. No cambia datos portables ni concede capacidades nuevas.

## Identidades y persistencia

La sesión A3 tiene UUID propio, `threadId` y `providerSessionId` opacos del proveedor. No se deriva `sessionId` de `threadId`. Cada turno conserva UUID A3, ID del turno remoto y UUID de operación que lo registró. Los IDs de herramientas pertenecen al espacio de operaciones del proyecto; reutilizar un ID con otra solicitud se rechaza.

`userData/codex-turns/<sha256(projectId,rootIdentity)>.jsonl` contiene eventos versionados y encadenados con SHA-256. Cada evento se sincroniza antes de permitir el efecto siguiente. La secuencia del journal, la secuencia de entrega dentro de una conexión y los IDs del proveedor son conceptos distintos. El archivo identifica proyecto y raíz en cada registro; un clon con otra identidad física no hereda contexto ni recibos. El host principal es su único propietario, con exclusión adicional entre instancias del servicio en ese proceso y serialización de comandos. Se conserva el bloqueo de instancia única de Electron; este journal no ofrece un lock distribuido entre procesos independientes.

Un registro inválido/truncado abre el prefijo válido en solo lectura, conserva todos los bytes y diagnostica. Un reinicio marca turnos activos y operaciones en ejecución como inciertos, sin borrar historia. Se mantienen todos los recibos; no hay poda automática que pueda eliminar protección de operaciones pendientes. Hay límites explícitos de 1 MiB por mensaje y 64 MiB por journal; alcanzar el límite bloquea nuevas escrituras y requiere gestión explícita posterior. No se declara tolerancia a corte eléctrico real.

## Idempotencia y frontera del efecto

La huella es SHA-256 del JSON canónico de la solicitud completa E0 (proyecto, actor autenticado, comando, precondiciones, alcance y payload). Se ordenan claves, se preservan arrays y se rechazan datos no JSON/accesores/no finitos; la identidad y las revisiones siguen validándose en el broker/escritor. El journal de sesión solo guarda la huella y recibos con IDs, revisiones y hashes; no almacena el payload de herramientas, cuerpos de error ni credenciales OAuth.

Estados de herramienta: `prepared → running → confirmed`, o `running → uncertain`; una preparación no despachada puede cancelarse. Un recibo durable puede resolver `prepared`, `uncertain` o `cancelled` a `confirmed`. Un estado incierto nunca vuelve a `running`. Antes de despachar se consulta el recibo del proyecto, se revalida autorización y se persiste `running`. Duplicados concurrentes idénticos comparten la ejecución. Una confirmación se devuelve desde el recibo sin repetir el efecto, incluso después de reinicios; un ID con otra huella se rechaza.

`OperationExecutor` es un límite host inyectable, sin IPC ni decodificación de herramientas remotas en este bloque. Su implementación E5-D debe aplicar el broker E1 y asociar efecto/recibo a la misma operación recuperable del proyecto. Si un efecto termina antes de que A3 reciba la confirmación, solo se consulta ese recibo; ausencia de evidencia mantiene incertidumbre. El journal de sesión y el efecto en otro almacén no forman una transacción atómica. No se promete exactamente una vez para una herramienta arbitraria ni para el puente E1 que aún no está conectado.

## Cancelación, stream y recuperación

Cancelar conserva mensajes finales y recibos. Envía `turn/interrupt` una vez; su ACK no es un resultado terminal. `turn/completed` distingue completed/failed/interrupted. El estado remoto se guarda separado del estado efectivo: si quedan efectos inciertos, el turno sigue incierto aunque el proveedor haya terminado. Una confirmación tardía de herramienta se conserva incluso si ignoró la señal de aborto.

La documentación oficial describe `thread/resume` e historia paginada; no establece un cursor de replay de notificaciones stdio ni IDs/secuencias globales de deltas. Por eso A3 no inventa `afterCursor` en RPC. Una reconexión explícita verifica el hilo y la sesión devueltos y marca `STDIO_REPLAY_UNAVAILABLE`. No reenvía turnos ni herramientas. Los deltas tras pérdida de continuidad no se anexan al mensaje provisional anterior; el item final autoritativo puede reconciliarlo por ID.

El host asigna `(connectionId,sequence)` a cada notificación. Reentregar el mismo envelope es idempotente; cambiar su contenido o saltar secuencia bloquea esa conexión y conserva transcript. Los items finales y estados terminales también son idempotentes por IDs estables. Deltas de texto iguales con secuencias distintas pueden ser contenido legítimo: no se eliminan por comparar el texto. No se afirma detectar duplicados sin identidad que el proveedor no suministra.

## Integración y límites

El adaptador stdio expone únicamente RPC tipado de reanudación e interrupción y una suscripción host. No existe un escape a RPC arbitrario; solicitudes de herramientas iniciadas por el servidor cierran la conexión en este bloque. Un stream malformado tras el handshake rechaza peticiones pendientes, diagnostica y detiene el transporte.

`CodexTurnHost` crea servicios/perfiles por proyecto de forma perezosa y cierra el transporte anterior al cambiar raíz. Abrir el host o el proyecto no inicia el binario. `trackTurn` registra un turno ya aceptado por el proveedor; no crea otro turno durante recuperación. El inicio de inferencia, autenticación hacia el hijo, herramientas/MCP y UI de chat no se habilitan aquí; siguen las condiciones E0/E5 y el binario permanece opcional/no empaquetado.

Fuentes oficiales verificadas el 2026-10-17: [protocolo, thread/resume, turn/interrupt e items finales](https://learn.chatgpt.com/docs/app-server) y [flujo autorizado de app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
