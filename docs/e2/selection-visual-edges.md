# E2-A3: selección y líneas de organización

Implementa el subconjunto de A3-006 correspondiente a selección, movimiento y conexiones visuales, según la especificación §§6 y 10 y los contratos E0-A. Los esquemas y documentos portables mantienen su versión y estructura.

## Herramientas y navegación

- **Seleccionar (V):** clic, Shift/Ctrl+clic, rectángulo con botón izquierdo y Ctrl+A. Arrastrar una cabecera mueve los nodos seleccionados. La selección es temporal: no edita Entity, Placement ni Workspace. Los nodos y líneas admiten Tab y Enter; Esc limpia la selección.
- **Dibujar conexión (C):** conecta los handles visuales izquierdo/derecho de placements y permite reconectar extremos. Los handles `visual-source`/`visual-target` son identificadores del adaptador React Flow, no puertos semánticos. El formulario Origen/Destino ofrece las mismas operaciones mediante teclado.
- **Editar etiqueta (T):** selecciona una línea y enfoca el campo de su etiqueta. Los campos de texto reciben las flechas, Supr y caracteres sin ejecutar atajos del lienzo. Este modo no modifica el contenido global de la entidad. El dibujo libre y la edición de páginas pertenecen a bloques posteriores.
- Botón central o Espacio+arrastrar desplazan la cámara; rueda y Ctrl+rueda conservan las reglas E2-A1. Las flechas mueven una selección un paso de mundo (Shift: 20 unidades); sin selección desplazan la vista. El bloqueo impide arrastrar, mover por teclado y redimensionar.

El arrastre múltiple se confirma con `a3.core.move-placements`, un plan lógico revisado y recuperable que escribe varios documentos mediante el writer/journal existente. No se presenta como un reemplazo atómico de todos los archivos. Un placement bloqueado en un lote solicitado rechaza el plan completo; mover un grupo existente mantiene intactos los miembros bloqueados. Desbloquear es una edición de estilo separada.

## Contrato portable de presentación

Las líneas se guardan solo en `.a3/workspaces/<workspace-id>/visual-edges/<id>.json` con los campos E0: extremos por placement ID, etiqueta, waypoints, estilo y extensiones. La creación usa `a3.core.create-document`; reconexión/etiqueta/estilo usan `a3.core.update-visual-edge`; eliminación usa `a3.core.delete`. Se validan revisiones, referencias locales al workspace, permiso y plan resultante. Reconectar conserva ID, claves desconocidas y waypoints.

El renderer interpreta las siguientes claves del mapa `style`, permitido por E0. Las claves restantes se conservan opacas; el formulario envía solo campos modificados y no reemplaza valores desconocidos por sus defaults visuales al editar una etiqueta:

| Documento | Clave | Valores interpretados |
|---|---|---|
| Placement | `a3.ui.locked` | `true` bloquea geometría; `false` o ausencia permite editarla con permiso. |
| VisualEdge | `a3.ui.line.color` | Hexadecimal `#rrggbb`; predeterminado `#9bc279`. |
| VisualEdge | `a3.ui.line.width` | 1–12 unidades de vista; predeterminado 2. |
| VisualEdge | `a3.ui.line.pattern` | `solid` o `dashed`; predeterminado `solid`. |
| VisualEdge | `a3.ui.line.route` | `straight`, `curved` u `orthogonal`; predeterminado `curved`. |
| VisualEdge | `a3.ui.line.direction` | `none`, `forward`, `backward` o `both`; predeterminado `none`. |

Los waypoints manuales existentes se representan como una polilínea en coordenadas de mundo y prevalecen sobre el recorrido automático. Este bloque no añade una herramienta de edición de waypoints. La dirección solo dibuja flechas. No establece dependencia, contención C4, cardinalidad UML ni conectividad eléctrica; tampoco convierte un VisualEdge en Relation/RelationView ni amplía contexto de IA. Los exportadores técnicos futuros deberán leer relaciones semánticas validadas, nunca inferirlas de estas flechas.

React Flow recibe proyecciones temporales. Se conserva la referencia de nodos/aristas sin cambios de revisión para limitar repintados, y se mantienen previews ligeras solo en nodos visibles. Selección, handles, medidas y estado de gestos nunca se guardan como proyecto.

Los UUID equivalentes con mayúsculas/minúsculas se resuelven al ID exacto del placement para React Flow, sin reescribir las referencias portables.

## Permisos

La edición requiere `diagram.edit`; borrar exige además `delete`. Cuando falta, el formulario ofrece solicitar el permiso local del proyecto: usa `setGrant(delete, approval)` y la confirmación humana del host. La operación de borrado vuelve a pasar por broker y confirmación; leer un documento o elegir una herramienta no concede permisos. La concesión corresponde al proyecto y dispositivo, no solo a una línea, y se comunica así en la solicitud. Cancelar conserva documentos.

## Evidencia y límites

`packages/domain/test/visual-edges.test.mjs` cubre pureza, separación semántica, endpoints locales, patches inválidos, revisiones, bloqueo y movimiento múltiple. `packages/project-store/test/canvas-edges.test.mjs` usa copias temporales para conectar/reconectar/borrar/reabrir, conservar estilos y waypoints, denegar revisiones/permisos y mantener idénticos los bytes de entidades y `.a3/relations`.

El smoke de Electron prueba selección por rectángulo, arrastre de selección, movimiento por teclado, bloqueo, foco del editor, creación/reconexión/estilo mediante formulario accesible, persistencia y eliminación con aprobación local. Combina eventos de ratón nativos con un `pointerup` DOM explícito para finalizar la captura en la ventana oculta de prueba. No hay exportador técnico de C4/UML/IoT todavía: la comprobación de exportación en este bloque consiste en que las fuentes semánticas portables permanecen idénticas y los nuevos documentos solo aparecen en `visual-edges`.

Comprobaciones: `npm test`, `npm run build` y `npm run test:desktop`. Alineación, agrupación, historial/deshacer y dibujo libre completarán otros apartados de A3-006. No se han medido los presupuestos de 1.000 nodos, FPS ni memoria total.
