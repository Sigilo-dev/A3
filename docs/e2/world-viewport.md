# E2-A1: viewport persistente del lienzo

Se integra React Flow `12.12.0`, el candidato ensayado en E0-D1, en una sección Lienzo con selector de workspace. El archivo canónico sigue siendo el Workspace E0 y el writer E1 guarda sus cambios con revisiones, broker, snapshots y journal. La decisión de coordenadas y origen visual está en [ADR 0009](../adr/0009-world-viewport.md).

## Uso

- Arrastrar con botón izquierdo o central desplaza el lienzo. La rueda y el desplazamiento de dos dedos también desplazan; Shift+rueda vertical desplaza horizontalmente. Ctrl/Cmd+rueda o el evento de pellizco de trackpad hace zoom sobre el cursor. Se normalizan deltas en píxeles, líneas y páginas.
- Los botones +/− y teclas +/− hacen zoom alrededor del centro. Con el lienzo enfocado, las flechas desplazan 40 píxeles CSS. El rango interactivo es 5–800 %, con escala inicial de 100 %.
- La cuadrícula inicial tiene 20 unidades de mundo, snap desactivado y guías de origen activadas. No hay herramientas de nodos, conectores ni dibujo en este corte.
- «Referencia de prueba» muestra dos formas SVG aisladas. «Ajustar contenido» se activa para esa geometría y solo se ejecuta al pedirlo. La referencia no se guarda, y un workspace sin geometría mantiene fit desactivado. Cambiar tamaño de ventana no mueve la cámara ni ajusta contenido.
- La interfaz indica escala, origen visible y guardado. Si guardar falla, se puede reintentar o descartar el cambio de vista. Solo lectura permite navegación temporal; un perfil que permita preparar cambios puede requerir aprobación humana al guardarlos.

## Verificación reproducible

Desde la raíz: `npm ci`, `npm run build`, `npm test`, `npm run test:desktop`. Las pruebas nuevas también se ejecutan de forma dirigida mediante `npm run test:canvas --workspace @a3/desktop` y `node --test packages/project-store/test/canvas.test.mjs` después del build del store.

| Caso | Evidencia automatizada |
|---|---|
| Pantalla ↔ mundo | Escalas 0.05, 0.73, 1 y 8; puntos hasta ±10¹² unidades; error comprobado ≤0.001 unidades/píxeles según conversión. |
| Zoom al cursor | 1.000 ciclos de acercar/alejar con tolerancia 10⁻⁸ unidades; límites 5–800 %. |
| Rueda/trackpad | Normalización pixel/line/page, dos ejes, Ctrl como pellizco y eventos nativos `mouseWheel` en Electron. |
| Ajustar contenido | Bounds extensos, escala fuera del rango interactivo y contención con margen; fit explícito de fixture en Electron. |
| Pan y resize | Arrastre nativo de React Flow; resize conserva exactamente los tres números de cámara. |
| Persistencia | Dos workspaces independientes; borradores guardados al cerrar proyecto; reapertura repetida conserva los valores exactos y un no-op no cambia bytes/revisión. |
| Escena extensa | Electron reabre una cámara de ±10¹² y verifica transformaciones visuales cercanas a cero, escala intacta y fase SVG de cuadrícula válida. |
| Seguridad y conflicto | Sesión vieja, ventana ajena, IPC malformado, revisión obsoleta, revocación y edición externa rechazados. Los bytes externos se conservan. |
| Campos futuros | Comando y codec preservan campos desconocidos dentro del viewport y extensiones del workspace. |

Equipo observado el 2026-10-15: Windows 10 Pro 10.0.19045 x64, AMD Ryzen 7 3700X, aproximadamente 32 GiB de RAM; Electron 44.7.2 / Chromium 152.0.7977.149. Pruebas ejecutadas con perfiles y carpetas temporales. El host no es el equipo de referencia Windows 11 de §26; no se declara aceptación de FPS, consumo, 1.000 nodos ni de un trackpad físico concreto. Tampoco se valida instalador de publicación o corte de energía.

React Flow genera un chunk diferido de aproximadamente 188 kB JS y 15.3 kB CSS sin gzip en el build local; no se carga al iniciar en Proyectos. No se inicia ningún proceso auxiliar para el lienzo. A3-006 y A3-007 tienen evidencia parcial de navegación/geometría; selección, herramientas de nodos, trazos, historial y presión siguen pendientes de sus respectivos bloques.

## Dependencias y licencias

La versión directa queda fijada en `apps/desktop/package.json` y `package-lock.json`, sin actualizar los pins de E1. Se comprobaron metadata npm, LICENSE instalado y árbol resuelto. Integridad npm de `@xyflow/react@12.12.0`: `sha512-74oXI0Rgm1Eu33cHQAd74J6oVgCH9mbFyTVQbsGgp2kmWwh0HdtBr2VP04z8mbPD+M/xO69nqG5dDEt7/EN2rQ==`.

| Paquetes nuevos | Versiones | Licencia declarada |
|---|---|---|
| @xyflow/react; @xyflow/system | 12.12.0; 0.0.83 | MIT |
| zustand; classcat; use-sync-external-store | 4.5.7; 5.0.5; 1.7.0 | MIT |
| d3-color; d3-dispatch; d3-drag | 3.1.0; 3.0.1; 3.0.0 | ISC |
| d3-interpolate; d3-selection; d3-timer; d3-transition; d3-zoom | 3.0.1; 3.0.0; 3.0.1; 3.0.1; 3.0.0 | ISC |
| d3-ease | 3.0.1 | BSD-3-Clause |
| @types/d3-color, drag, interpolate, selection, transition, zoom | 3.1.3; 3.0.7; 3.0.4; 3.0.12; 3.0.9; 3.0.9 | MIT |

ISC y BSD-3-Clause son excepciones permisivas sin pago, compatibles con la decisión del producto. Se conserva la atribución visual de React Flow. `npm audit` devolvió ocho avisos moderados en la cadena ya fijada de electron-builder → global-agent/roarr/sprintf-js; el árbol nuevo de React Flow no aparece en esos avisos. Su resolución global queda fuera de este cambio y no se aplicaron actualizaciones automáticas.

Referencias primarias consultadas: [React Flow props](https://reactflow.dev/api-reference/react-flow), [Viewport](https://reactflow.dev/api-reference/types/viewport), [ViewportPortal](https://reactflow.dev/api-reference/components/viewport-portal) y [licencia](https://github.com/xyflow/xyflow/blob/main/LICENSE). El comportamiento integrado también se contrastó con el código instalado 12.12.0.
