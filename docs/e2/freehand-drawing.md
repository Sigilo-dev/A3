# E2-B1: dibujo vectorial persistente

E2-B1 implementa las anotaciones del lienzo de A3-007 y la conversión vectorial descrita en la sección 10.4 de la especificación. Los trazos son documentos versionados y locales al workspace. Su fuente canónica son puntos en coordenadas de mundo, con presión opcional, parámetros de Perfect Freehand y mapa namespaced de estilo. SVG se deriva al renderizar; no se guarda una captura como sustituto de los datos.

## Uso y datos

- **Dibujar a mano (D)** captura mouse, lápiz o touch; **Seleccionar (V)** permite selección con clic o teclado, y Supr elimina la selección de trazos tras aprobación del permiso local `delete`.
- Cada documento vive en `.a3/workspaces/<workspace-id>/drawings/<id>.json`. Se guardan puntos, `size`, `thinning`, `smoothing`, `streamline`, `simulatePressure` y extensiones. Cambiar estilo o parámetros incrementa revisión mediante el store existente.
- Mouse y dispositivos sin presión guardan puntos sin el campo `pressure`, y generan presión simulada. La interfaz conserva la presión informada por Pointer Events de lápiz/touch cuando el dispositivo la expone. La prueba Electron de este bloque usa mouse nativo y un PointerEvent sintético con valores de presión; no hubo hardware de lápiz disponible para verificar presión física.
- El viewport transforma puntos de mundo sin alterarlos. La ruta visible se deriva con Perfect Freehand dentro de `ViewportPortal`, por lo que permanece alineada con placements al desplazar o escalar el lienzo.
- El inspector permite apariencia limpia o de boceto. Rough.js dibuja un contorno determinista a partir de la misma geometría; el modo y su intensidad se guardan en `style` (`a3.ui.stroke.rendering`, `a3.ui.stroke.roughness`). El ID del trazo fija la semilla para mantener la apariencia al reabrir. Esta entrega aplica estilo Rough.js a contornos trazados a mano; no añade un editor de ilustración ni un catálogo de primitivas geométricas.
- **Convertir selección a nodo Dibujo** crea una entidad `a3.core.drawing`, un recurso JSON vectorial bajo `assets/drawings/` y su placement dentro de la operación transaccional. Se copian puntos, presión, parámetros, estilo y extensiones; las anotaciones seleccionadas se eliminan al confirmar la conversión. El recurso es editable y no contiene una fuente `data:image/` raster.

## Comandos reversibles e historial

El dominio expone `ReversibleCanvasCommand`, que proyecta las modificaciones `before`/`after` y los efectos de contenido de un `PreparedPlan` validado y confirma que pertenecen a un solo workspace. E2-B3 conecta esos eventos con el historial local del store para invertir documentos y el archivo vectorial creado al convertir, sujeto a revisiones y a la capacidad de borrado requerida.

## Dependencias

| Paquete | Versión fijada | Licencia declarada |
|---|---:|---|
| perfect-freehand | 1.2.3 | MIT |
| roughjs | 4.6.6 | MIT |

Las dos dependencias directas están fijadas en `apps/desktop/package.json` y `package-lock.json`; Rough.js se usa solo para representar el modo de boceto. Los metadatos de npm y los avisos de licencia instalados declaran MIT. `npm install` conserva ocho avisos moderados del árbol existente de electron-builder; este cambio no aplica actualizaciones automáticas.

## Evidencia y límites

`packages/domain/test/drawing.test.mjs` valida geometría/presión, revisiones, aislamiento por workspace, extensión de grupos, vectorización al convertir y forma del contrato reversible. `packages/project-store/test/canvas-drawings.test.mjs` valida escritura/reapertura, edición de parámetros y estilo, permisos/revocación, bytes vectoriales y conservación de documentos semánticos. `apps/desktop/test/canvas-interactions.cjs` recorre dibujo con mouse, presión sintética, selección por teclado, borrado, modo Rough.js, zoom, guardar/reabrir y conversión.

No se mide todavía latencia de miles de trazos, presión física de stylus, selección por rectángulo de dibujo, primitivas de dibujo independientes, exportación del canvas ni undo/redo común. Rough.js no amplía el alcance a ilustración libre avanzada.
