# E5-C2: evidencia de streaming y recuperación

Implementación: [ADR 0022](../adr/0022-resumable-codex-turns.md), especificación §20.3 y criterio A3-030. Base E5-C1 `dfef97c` verificada en `codex/e3-e7-product`; no se cambian contratos portables ni dependencias.

## Comprobaciones reproducibles

Desde la raíz:

```text
npm run test:codex:turns --workspace @a3/desktop
npm run test:codex:app-server --workspace @a3/desktop
npm run typecheck --workspace @a3/desktop
npm run build --workspace @a3/desktop
```

Las pruebas de turnos usan directorios temporales y fixtures de notificaciones documentadas. Cubren duplicación de envelopes/items, cancelación con ACK separado del terminal, confirmación tardía, huella con actor/payload distintos, autorización revocada, recibo de proyecto anterior a la sesión, herramientas concurrentes, reconexión sin replay, deltas provisionales, stream malformado, journal truncado conservado byte a byte y separación de clones/raíces.

Además de fallos inyectados, un fixture inicia un proceso Node independiente y ejecuta `process.exit(91)` sin cierre/finally después de preparar, marcar en ejecución, aplicar el efecto y confirmar. El host siguiente abre el journal, recupera recibos y comprueba que el efecto de prueba permanece en una sola revisión. El efecto/recibo del fixture se sincronizan juntos en un archivo temporal; no son herramientas reales ni sustituyen el journal E1.

La suite del adaptador comprueba framing/handshake E5-C1 y, tras el handshake, correlación de solicitudes, secuencias de conexión, timeout sin retransmisión y propagación de un stream malformado hasta el transcript persistente. No se usa token real ni inferencia en estas pruebas.

Resultado en Windows (2026-10-17): **24 pruebas de turnos + 13 de adaptador aprobadas**, typecheck y build desktop aprobados. También pasó el smoke aislado de handshake con CLI `0.163.0-alpha.10.2`, SHA-256 `f6dbf48cb70f62649c645f26c87dc9bf84cc36986202dfad8e12fb5b8ca70312`; no hubo hilo/turno de inferencia. El artefacto local cambió respecto al de E5-C1 y se verificó con su nueva huella; sigue siendo evidencia local, sin aprobación de distribución. El build conserva el aviso previo sobre tamaño de chunks del renderer.

## Alcance de aceptación

**A3-030:** verificados localmente el modelo/ledger de reanudación, la deduplicación de recibos y los fallos de proceso del fixture. El caso completo con app-server real durante una escritura A3 requiere todavía el puente de herramientas y aplicación E5-D y su evidencia sobre el journal E1. No se declara aceptado de extremo a extremo ni se promete recuperación automática de una herramienta sin recibo.

**A3-028/029:** sin ampliación de aceptación por estas pruebas; no hubo login, consumo del plan ni turno de inferencia. **A3-031/032:** no se habilitaron herramientas, procesos arbitrarios ni una capacidad de sandbox no demostrada. No hay nuevos canales IPC de agente/renderer.

El único estado persistido de la sesión es local por proyecto/raíz. Las credenciales, cookies, errores crudos y payloads de herramientas no forman parte del journal. Los textos del transcript sí son contenido de conversación explícito y deben tratarse como datos del usuario.

El bloque siguiente, E5-D1, define contratos tipados de lectura y validación con scope fijado por el host. Siguen sin registrarse en app-server/MCP hasta validar el transporte; véase [E5-D1](a3-tool-contracts.md).
