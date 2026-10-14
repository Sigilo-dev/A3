# Contrato mínimo de comandos y migración

Base: especificación local 1.0.0, §§5, 7–8, 20.5, 28 y 30. Contrato conceptual; no hay bus, journal, permisos efectivos ni migrador implementados.

## Comandos

Toda entrada de UI, importador, extensión o agente pasa por el mismo núcleo. Envelope propuesto:

```json
{
  "operationId": "10000000-0000-4000-8000-000000000001",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "actor": { "kind": "user", "id": "local-user" },
  "command": "a3.core.update-entity",
  "expectedRevisions": [
    { "kind": "entity", "id": "00000000-0000-4000-8000-000000000002", "revision": 1 }
  ],
  "scope": { "entityIds": ["00000000-0000-4000-8000-000000000002"] },
  "payload": { "title": "Visión revisada" }
}
```

El host autentica el actor (`user`, `agent`, `extension`, `importer`); el campo recibido no prueba identidad ni concede privilegios. `scope` limita la solicitud, no amplía permisos. La revisión esperada abarca cada documento leído que condiciona el cambio y cada documento modificado; para fuentes externas se añaden hashes. La forma exacta de precondición de creación (ausente) y revisión de borrados queda para ADR.

Orden requerido: resolver identidad y capacidades; validar sintaxis/esquema; resolver referencias y reglas del tipo; comprobar revisiones/hashes sobre el estado actual; preparar y validar el conjunto resultante; persistir como unidad recuperable; emitir resultado/eventos solo después de confirmación. La validación previa sin escritura no reserva revisiones: `apply_changes` debe repetir las comprobaciones críticas.

Una revisión obsoleta produce `REVISION_CONFLICT`, con documento, revisión esperada/actual y recuperación propuesta (releer y revisar diff). No se aplica parcialmente ni se sobreescribe silenciosamente. Cambios externos sin aumento de revisión se detectarán con hash; archivos inválidos se preservan y abren con diagnóstico.

Idempotencia: repetir `(projectId, operationId)` con la misma solicitud confirmada devuelve el mismo resultado/IDs sin repetir efectos. Reutilizar el ID con payload, actor o alcance distintos se rechaza; propuesta E0: `VALIDATION_FAILED` con detalle `operation-id-reused`. Reintentar una operación pendiente debe consultar su estado y recuperación antes de ejecutarla. Deben definirse por ADR la huella canónica, retención, persistencia de resultados, tratamiento de fallos y frontera transaccional del registro de idempotencia. No hay garantía de exactamente una vez por haber definido este envelope.

Respuestas incluyen `operationId`, estado, IDs/revisiones resultantes y diagnósticos. Error mínimo: código estable, mensaje, recurso afectado y acción recuperable. Códigos de la especificación: `VALIDATION_FAILED`, `REVISION_CONFLICT`, `PERMISSION_DENIED`, `RESOURCE_MISSING`, `PATH_UNAVAILABLE`, `ENGINE_UNAVAILABLE`, `AUTH_REQUIRED`, `RATE_LIMITED`, `EXTERNAL_SERVICE_FAILED`, `IO_FAILED`, `CANCELLED`. No confundir un diagnóstico de relación rota con una orden de borrarla.

## Evolución y migración

Separar versión de aplicación, formato de proyecto, esquema de documento, tipo de nodo y API de extensión. El perfil E0 solo valida documentos 1.0.0; rechazar otro número en estos esquemas significa “no soportado por este perfil”, no autorización para degradarlo.

Un lector futuro inspecciona versión antes de escribir. Un major superior permite inspección y solo lectura; conserva datos. Para una versión menor desconocida debe decidir compatibilidad explícitamente o mantener solo lectura, nunca eliminar campos para hacerla pasar.

Migraciones secuenciales con versión origen/destino y paquete exacto: preview del conjunto afectado, copia recuperable, validación previa, cambios revisables, validación del conjunto nuevo y activación solo al confirmar. Interrupción exige completar o revertir determinísticamente; cambios externos posteriores requieren conflicto, no reversión destructiva. No ejecutar código de migración desconocido por abrir el proyecto.

El servicio de proyecto será escritor único; temporales, journal y reemplazos de archivos no equivalen por sí solos a atomicidad de varios archivos. E0-C/E1 deben probar recuperación, concurrencia externa y durabilidad real en Windows. No se ha ejecutado aquí ninguna migración, transacción ni prueba de permisos.
