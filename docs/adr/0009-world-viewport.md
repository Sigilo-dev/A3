# ADR 0009: cámara A3 y adaptación visual de React Flow

Estado: aceptada para la implementación E2-A1. Fuentes: especificación §§6, 9–10, 26; Workspace E0-A; evidencia E0-D1; writer, broker y recuperación E1. Base: E1 `b298bb9`, rama `codex/e2-canvas`.

## Representación y precisión

`workspace.json.viewport` conserva `{ x, y, zoom }`: `screen = world * zoom + translation`. `x` e `y` son la traslación del origen del mundo en píxeles CSS respecto de la esquina superior izquierda del área de lienzo; no son píxeles físicos ni posiciones de nodos. `zoom` es una escala adimensional. Los puntos del mundo son independientes del tamaño/resolución de la ventana. Este detalle concreta la forma del contrato E0 existente, compatible con el spike; no cambia esquemas ni añade una representación canónica de React Flow.

El adaptador visual usa un origen cercano a la cámara. Resta ese origen de las coordenadas de los elementos visibles y compensa la transformación de React Flow. Se recalcula al cargar y al terminar gestos; el origen derivado nunca se guarda. La cuadrícula usa el residuo positivo del origen módulo 20 para conservar fase entre rebases. Los cálculos y JSON mantienen números IEEE-754 de doble precisión, sin redondear ni ajustar posiciones al navegar. Si la cámara excede una precisión estimada de un cuarto de píxel CSS, el adaptador diagnostica y conserva los datos, en lugar de recortar coordenadas silenciosamente.

Los gestos y botones de zoom usan 0.05–8. El ajuste explícito de contenido puede usar una escala menor para incluir bounds extensos; un gesto posterior vuelve al rango interactivo. Cargar, redimensionar y reabrir no ejecutan fit. Las conversiones pantalla/mundo reciben coordenadas relativas al área de lienzo; los eventos de rueda descuentan su `getBoundingClientRect`.

## Persistencia y límites de autorización

`a3.core.set-workspace-viewport` modifica únicamente los tres valores conocidos, aumenta la revisión y conserva otros campos del viewport, propiedades y extensiones. `LocalProjectManager` mantiene borradores por sesión/workspace; el renderer envía IDs, revisión y números validados por IPC, sin rutas ni acceso al broker. El dominio y el writer vuelven a comprobar revisiones, permisos y archivos externos.

Se envían borradores al host agrupados por frame. El guardado canónico ocurre tras 500 ms sin cambios, al salir del lienzo, al guardar explícitamente y al cerrar/cambiar de proyecto. El cierre del host drena los borradores aceptados antes de cerrar el writer. Los fallos conservan el borrador para reintentar o descartarlo explícitamente; una revocación o un conflicto no se convierte en guardado exitoso. Proponer conserva su aprobación del host antes de aplicar; Consultar permite navegar de forma temporal sin escribir. Los borradores aún no guardados son memoria de sesión; D1 protege las transacciones iniciadas, no cada evento de puntero ante muerte del renderer.

React Flow se carga bajo demanda como vista controlada, con listas de nodos/aristas vacías en este corte. El fixture SVG opcional no crea Entity, Placement, conectores ni trazos, y no se guarda. Las guías de origen y el fixture usan el mismo viewport. La futura proyección de entidades usará el adaptador de origen y sus propios bounds; no debe persistir `ReactFlowInstance.toObject()`.

Electron declara ahora `type: module` para las fuentes y pruebas TypeScript nativas de Node; las salidas main/preload continúan siendo bundles `.cjs`, con aislamiento y sandbox. El nuevo canal aplica la misma validación de emisor/frame/documento que los canales E1.
