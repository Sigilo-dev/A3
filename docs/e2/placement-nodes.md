# E2-A2: placements en el lienzo

E2-A2 conecta las vistas guardadas del dominio con React Flow según [A3 §§6, 9–11, 26 y 28](../../A3_ESPECIFICACION_MAESTRA.md). El documento canónico sigue siendo `.a3/workspaces/<id>/placements/<placement-id>.json`; React Flow recibe una proyección temporal y nunca se serializa como proyecto.

E2-A3 amplía esta base con [selección, bloqueo y líneas visuales](selection-visual-edges.md); los límites sobre conexiones descritos más abajo corresponden a la entrega E2-A2.

## Proyección

El host carga los placements de un workspace y los une por `entityId` con sus entidades canónicas. Si una entidad aparece en dos workspaces, ambos reciben el mismo ID, título, propiedades, puertos y recurso de contenido. Cada placement conserva por separado su posición, tamaño, estilo e ID. La lista para crear otra representación contiene solo identificadores y títulos; los metadatos completos se transfieren únicamente para entidades ya representadas.

Se usa un renderer React Flow genérico para esta primera entrega. Cuando falta el tipo o paquete, la tarjeta indica el tipo ausente y conserva para inspección propiedades, puertos y contenido. Las previews de recursos se solicitan al host cuando React Flow monta una tarjeta visible. El lector aplica broker, revisión y raíz de recurso, limita la preview a 64 KiB y entrega Markdown como texto; no monta editores ni carga multimedia pesada. Los nodos no visibles no mantienen ese lector activo.

## Escritura y límites

- Crear una representación conserva `entityId` y genera un `placementId` nuevo mediante `a3.core.create-document`, con precondición `revision: null`.
- Arrastrar usa el comando existente `a3.core.move-placement`.
- Redimensionar y cambiar estilo usan el nuevo comando E2 `a3.core.update-placement-view`. Solo actualiza los campos ya declarados en `Placement` (`position`, `size`, `style`); mantiene revisiones, valida tamaño positivo y combina mapas de estilo para conservar claves desconocidas. No cambia los esquemas E0 ni altera `move-placement`.
- `a3.ui.accent` es una clave namespaced de estilo que este renderer entiende como acento hexadecimal. Las demás claves se conservan y se muestran como datos opacos.
- Cada comando entra al writer, journal y broker actuales. Las revisiones obsoletas se rechazan. La colocación React Flow, selección, mediciones y estado de resize solo viven en memoria del renderer.

El renderer mantiene referencias React Flow de las tarjetas sin cambios y sustituye solo el nodo editado tras una respuesta del host. También usa `onlyRenderVisibleElements`, nodos memoizados y preview bajo demanda. El viewport solo reubica nodos si el origen visual se rebasa; pan/zoom normal no escribe posiciones.

Todavía no se ejecuta código aportado por paquetes ni se eligen componentes arbitrarios desde `NodeType`; la tarjeta genérica permite abrir documentos con tipos desconocidos. No se implementan conectores, relaciones visuales, contenido editable en línea, conversión de multimedia ni una migración de formatos. Los previews y el panel de propiedades siguen siendo lectores ligeros.

## Comprobaciones

Ejecutar desde la raíz:

```powershell
npm run build
npm test
npm run test:desktop
```

Las pruebas cubren la misma Entity en dos workspaces, actualización del recurso Markdown visible en ambas vistas, movimiento/tamaño/estilo aislados, creación de una representación, revisión, permisos, reapertura sin deriva y ausencia de líneas. El smoke de Electron abre una copia temporal del fixture E0, comprueba la tarjeta fallback y su preview, crea otro placement por la interfaz, muestra el control de resize de React Flow, aplica un tamaño mediante el comando validado y verifica la representación reabierta. No escribe en los fixtures versionados.

La aceptación A3-004 y A3-006 está probada para esta proyección básica. A3-005, paquetes con renderers propios, 1.000 nodos, FPS objetivo, memoria de 600 MB y experiencias de edición de página siguen fuera de este bloque; el smoke no mide esos presupuestos.
