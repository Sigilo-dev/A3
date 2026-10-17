# ADR 0028 · historial local y restauración revisada

Estado: implementada para E6-C1. Base: E1-D snapshots/journal, E6-A2 operaciones Git revisadas, especificación §§8.4/22.5 y A3-038. No altera formatos portables ni añade dependencias.

## Fuentes separadas

La pestaña Historial separa recuperación local, estado del directorio de trabajo/índice Git y commits locales. Cada commit presenta fecha ISO, asunto y OID. Git ausente conserva disponible el catálogo de snapshots. La actividad de agentes se identifica como no disponible hasta que exista un registro persistente dedicado; no se infiere a partir de chats ni de eventos transitorios.

Los snapshots E1 se catalogan desde `.a3/local/recovery/snapshots`. Cada vista previa local prepara una operación E1 sin escribir, muestra hashes, tamaños y diff textual UTF-8 dentro de un presupuesto de 2 MiB. Los binarios, codificaciones no admitidas y diffs que exceden el presupuesto declaran el motivo y muestran hashes/tamaños. Al aplicar, el plan vuelve a validar permisos, revisiones, hashes y rutas. El escritor crea un snapshot del estado actual, registra la intención y los reemplazos en el journal; el punto de vuelta aparece en el mismo catálogo.

## Historial Git

`restore-commit` acepta un OID de commit, enumera las rutas distintas entre HEAD y destino e incorpora rutas rastreadas que tienen ediciones locales sin commit. No borra archivos sueltos ni importa del árbol rutas protegidas. El límite inicial es 128 rutas por revisión; si se excede, la acción falla completa y se pueden revisar archivos desde Operaciones Git locales. La comparación conserva stage/índice y rama. Aplicar usa `prepareVersionRestore` de E1, que valida los documentos reconocidos y deja los desconocidos como bytes, incrementa revisiones de los documentos A3 y genera un snapshot durable antes del journal.

## Exclusiones y límites

Snapshots y previews omiten `.git`, `.a3/local`, `.env*`, rutas de credenciales/secretos, llaves privadas, cachés y `node_modules`. El filtrado se hace por ruta; no detecta toda credencial embebida en un archivo con nombre normal. Un snapshot previo que contenga una ruta ahora protegida no se ofrece para restauración. El historial Git aplica su detector conservador existente de secretos.

Una operación de varios archivos sigue sin ser atómica. El journal decide completar o revertir tras reinicio y conserva conflictos externos; estas pruebas no demuestran tolerancia a pérdida de energía. Los diffs locales grandes/binarios no se expanden en IPC. Git muestra los últimos 30 commits disponibles en el adaptador, no todas las referencias ni historial remoto. No se conecta el historial de agentes en esta entrega.

## Evidencia

Pruebas E6-C1: edición A3 sin commit, revisión/diff local, retorno durable, archivo externo modificado después de revisión, recuperación tras interrupción, fecha Git y restauración completa revisada por commit. Tests dirigidos de Windows en `packages/project-store/test/maintenance.test.mjs`, `packages/project-store/test/history.test.mjs` y `apps/desktop/test/git-versions.test.mjs`.
