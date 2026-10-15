# E1-D2 — snapshots, migraciones y apertura degradada

Base: E1-D1 `0fad416`, especificación maestra §§7–8 y criterios A3-038, A3-045 y A3-048.

## Decisiones

- Los snapshots completos por lote guardan preimágenes y estados ausentes en `.a3/local/recovery/snapshots/`; este contenido queda fuera de Git. Las escrituras normales crean un snapshot antes de abrir el journal D1. Migrar, importar o restaurar puede declarar su motivo explícitamente.
- Un snapshot se publica solo después de escribir y sincronizar sus blobs y manifiesto. Se verifica contra hashes/identidades observados antes de aceptar la operación. Restaurar siempre crea primero un snapshot de retorno nuevo y trata la restauración como un lote D1 independiente; nunca se reutilizan revisiones antiguas de documentos administrados.
- La retención inicial es 30 días y 2 GiB de bytes de contenido; ambos límites son configurables. Se eliminan snapshots antiguos primero. Una copia vinculada a una transacción D1 sin cierre permanece protegida; si las copias protegidas exceden el presupuesto, se conserva y se devuelve diagnóstico en vez de borrarlas.
- No existe en E0 un formato histórico concreto. El motor recibe migraciones de código de confianza registradas por versión origen/destino, y cada paso incluye un validador de su forma de entrada y una transformación. Aplica solo una cadena exacta y secuencial, incrementa revisión y versión en cada paso, valida la salida con el esquema activo, conserva `extensions` y rechaza cambios fuera de los JSON Pointers declarados. El repositorio no registra conversores históricos por defecto. Una versión mayor desconocida nunca se migra ni reescribe.
- Cada migración guarda salida preparada y hashes en `.a3/local/migrations/<operationId>/`. Al reabrir, si los hashes destino ya están aplicados se cierra; si sigue intacto el estado origen, se reaplican los mismos bytes preparados en una transacción D1 nueva; cambios externos producen conflicto. D1 resuelve primero cualquier intento parcial.
- Un documento inválido no se normaliza ni reemplaza al abrir. Los demás documentos válidos continúan disponibles en modo degradado. Una restauración explícita debe validar el snapshot y el documento resultante; si hace falta elevar una revisión, se incrementa sobre la actual o sobre la revisión de la copia cuando el original esté corrupto.
- No existe todavía flujo de importación en la app. Su integración debe llamar `createSnapshot(..., 'import', ...)` y confirmar esa copia antes de aplicar efectos; la API ya valida y registra esa intención.

## Límites y verificación

Las pruebas usan proyectos fixture temporales en Windows; no acceden a snapshots reales del usuario. Los límites de directorio y energía siguen siendo los documentados por E0-C1/E1-D1. Restauración validada de catálogos solo se confirma si la lectura final mantiene referencias coherentes. A3-038 cubre snapshots locales y vía de retorno, no historial Git; A3-045 cubre corrupción localizada y recuperación explícita, no edición automática de bytes inválidos; A3-048 cubre las cadenas de migración registradas, interrupción reanudable y bloqueo de versiones mayores desconocidas.
