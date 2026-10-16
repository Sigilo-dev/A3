# E2-B3: duplicar, disponer y deshacer

Este bloque cubre A3-005–007 de la especificación: duplicar una selección, ordenar y bloquear representaciones, y deshacer/rehacer cambios del lienzo con comandos del dominio.

## Duplicación

- **Duplicar representación** crea nuevos `placementId`, `drawingId` y `groupId`, pero mantiene los `entityId` originales. Se copian los grupos incluidos y sus subgrupos, y se crean trazos vectoriales separados trasladados por el offset. Una entidad canónica puede conservar varias representaciones.
- **Duplicar contenido** crea nuevos IDs de entidades, recursos y placements. Copia los bytes del recurso al destino del proyecto y crea una copia de cada relación semántica cuyos dos extremos fueron seleccionados. Las relaciones con un extremo externo permanecen intactas; no se copian por defecto. Los `VisualEdge` y `RelationView` solo se remapean si ambos placements están dentro del conjunto.
- Las selecciones de grupo incluyen de forma recursiva sus placements, dibujos y subgrupos. Los IDs de la copia se generan en el dominio y los archivos se crean mediante el servicio del proyecto; la UI no conserva un segundo grafo ni asigna IDs canónicos.

## Disposición

La UI ofrece alinear bordes y centros, distribuir horizontal o verticalmente, cambiar el orden mediante `a3.ui.z-index` y bloquear/desbloquear mediante `a3.ui.locked`. Alinear/distribuir omite representaciones bloqueadas. Cambiar el orden o el bloqueo conserva el contenido compartido de la entidad. Insertar un nodo no reorganiza el workspace.

Auto-layout queda fuera de esta entrega. E0 no fijó ni verificó una versión/licencia de Dagre; por eso no se muestra como una acción disponible ni se añade una dependencia sin validar.

## Historial y permisos

Los comandos del store producen eventos reversibles del dominio. La UI usa el historial del host; no mantiene una pila React. Los cursores y eventos se guardan como datos locales del host fuera del proyecto portable, separados por identidad del proyecto y workspace, con límite inicial de 50 comandos y 16 MiB. Una selección expandida admite hasta 512 miembros y un comando reversible hasta 1024 documentos o efectos; si supera el límite, se rechaza antes de escribir. Se registra una intención antes de confirmar el write y se reconcilia al abrir, por lo que un cierre entre ambas fases no debe inventar un paso.

Undo/redo comprueba el estado de cada documento y sus revisiones y avanza revisiones al restaurar. Si un archivo de contenido creado fue editado externamente, el undo se detiene y conserva sus bytes en vez de borrarlo. El cambio de contenido de una entidad se comparte entre representaciones; la geometría, estilo, orden, grupos y trazos siguen siendo propios de la vista.

El broker sigue siendo la autoridad para cada operación. Invertir una creación puede eliminar documentos o archivos, y por ello requiere la capacidad local `delete`; la persona puede solicitar su aprobación en el lienzo. Un perfil o agente sin esa capacidad recibe denegación estructurada. Una revisión obsoleta o una escritura externa bloquea el historial para revisión; no se fuerza la restauración. El historial local no se sincroniza ni se comparte por Git.

La retención es acotada y no constituye una promesa de historial ilimitado. El store rechaza eventos por encima del límite del sidecar y preserva el sidecar inválido para diagnóstico.

## Validación

Las pruebas de dominio cubren IDs nuevos, copias de contenido y representación, relaciones internas y externas, grupos/subgrupos, dibujos, orden, bloqueo y conflicto de undo. Las pruebas del store cubren persistencia tras cierre/reapertura, bytes de recursos, revisión, aprobación de borrado, alineación/orden/bloqueo y redo. Los datos de ensayo se generan en carpetas temporales.
