# E3-E3: importar y renderizar workspaces Structurizr locales

Base: E3-E2, commit `a785542` en `codex/e3-e7-product`, junto con los contratos E0-A y el spike [E0-D2](../e0/compatibility/diagram-engines.md). Fuentes normativas: [A3_ESPECIFICACION_MAESTRA.md, §§13.2 y 14.1–14.4](../../A3_ESPECIFICACION_MAESTRA.md).

## Decisión de parser, UI y licencia

E0-D2 comprobó localmente DSL, workspace JSON, UI y exportación con Structurizr `2026.09.19-playwright` / módulo Java `6.2.3` bajo Java 21. El código fuente principal publica Apache-2.0; la UI abierta publica MIT, pero el paquete WAR de 426,971,336 bytes contiene dependencias cuya licencia transitiva no se auditó completa. La [documentación del parser DSL](https://docs.structurizr.com/dsl/parser), [releases](https://github.com/structurizr/structurizr/releases), [licencia del código Java](https://github.com/structurizr/structurizr/blob/main/LICENSE) y [licencia de la UI](https://github.com/structurizr/ui/blob/main/LICENSE) se consultaron para fijar estos límites.

A3 no descarga, ejecuta ni redistribuye el WAR, el parser Java ni la UI de Structurizr y no usa un servicio alojado. El tamaño del WAR y la auditoría pendiente de dependencias impiden tratar esa distribución completa como un artefacto redistribuible aprobado. En su lugar A3 incorpora dos adaptadores TypeScript pequeños, puros y separados. No son parser completo de Structurizr ni equivalentes a su UI: solo reconocen los subconjuntos documentados abajo. No ejecutan DSL, Java, scripts, plugins, temas ni HTML.

## Flujo en A3

El catálogo crea un nodo `Structurizr DSL · fuente` (`.dsl`) o `Structurizr JSON · fuente` (`.json`). Puede crearse desde texto o apuntar a un recurso interno con esa extensión. El archivo fuente sigue siendo canónico: la previsualización informa su hash y revisión y la aplicación rechaza una fuente obsoleta. No abre recursos montados ni convierte al abrir. Los bytes no se reescriben al previsualizar/importar.

El panel muestra la fuente original, las vistas estáticas detectadas, elementos y relaciones convertibles, un mapa estable de claves a IDs A3, cambios de creación/actualización, claves antiguas sin borrar, diagnósticos localizados y referencias no resueltas. La persona elige `source` o `a3-model`; cambiar esa autoridad no regenera la DSL ni el JSON. La actualización requiere el mapa persistido de esa fuente y presenta otra vez el diff. Colisiones o referencias inválidas impiden aplicar. Los elementos ausentes del archivo se reportan y nunca se eliminan automáticamente.

Cada vista estática se aplica como un comando reversible independiente para respetar el límite actual del historial de canvas, que abarca un workspace por comando. La interfaz renueva el diff y la revisión entre vistas. Las vistas importadas son workspaces C4 A3 normales; el usuario las abre en el selector del lienzo. React Flow renderiza la proyección A3, no la UI original de Structurizr ni su layout/estilos exactos. Las vistas de un mismo origen reutilizan los IDs asignados a elementos y relaciones.

## Subconjunto DSL

Se requiere un bloque `workspace "nombre" { ... }`, con `model { ... }` y opcionalmente `views { ... }`. Los elementos requieren alias para formar identidades estables. Los nombres/alias aceptan identificadores ASCII de hasta 64 caracteres; títulos, descripciones y tecnología son cadenas entre comillas.

```structurizr
workspace "A3" {
  model {
    editor = person "Editor" "Persona que usa A3"
    a3 = softwareSystem "A3" "Diseño de proyectos" {
      files = container "Archivos" "Fuentes locales" "Filesystem"
    }
    editor -> a3 "diseña"
  }
  views {
    systemContext a3 "contexto" {
      include *
      autoLayout lr
    }
    container a3 "contenedores" {
      include editor a3 files
    }
  }
}
```

Convierte declaraciones `person`, `softwareSystem`, `container`, `component` y `deploymentNode`, más relaciones simples `alias -> alias "descripción" "tecnología"`. Convierte vistas `systemContext`, `container`, `component` y `deployment` con `include *` o una lista de alias. En las familias contexto/contenedores/componentes se valida la categoría y el ámbito según C4 A3. El parser conserva la fuente pero no resuelve layout ni instancia de despliegue DSL.

No convierte atributos de elemento, grupos, tags/propiedades, restricciones, límites, relaciones dirigidas personalizadas, `exclude`, animaciones, `autoLayout`, estilos, themes, plugins ni scripts. Un `dynamic` se conserva y se informa como no convertido. Los includes locales no se expanden; los remotos se informan sin petición de red. El broker comprueba `network.access` y en el perfil actual devuelve denegación; si se habilita en el futuro, la resolución aún requerirá un resolver local explícito y seguro. A3 no ejecuta directivas `!script` o `!plugin` bajo ningún perfil.

## Subconjunto workspace JSON

El adaptador JSON no pasa por el parser DSL. Lee `model.people`, `model.softwareSystems` con `containers`/`components`, `model.deploymentNodes` anidados con `instances`, y sus relaciones con IDs y extremos. Lee las listas `views.systemContextViews`, `containerViews`, `componentViews` y `deploymentViews`; importa sus IDs, títulos, ámbitos, elementos, relaciones y coordenadas finitas. Para despliegue conserva el entorno conocido. El atributo `properties.structurizr.dsl` no se vuelve a ejecutar.

Se conservan los bytes JSON originales, incluidos campos desconocidos. Vistas dinámicas, animaciones, `views.configuration.styles/themes` y referencias a elementos ausentes se informan cuando el adaptador las inspecciona. Los demás campos no mapeados permanecen solo en la fuente; no se promete diagnóstico exhaustivo de cada propiedad JSON desconocida ni validación equivalente al parser oficial.

## Límites de tamaño y compatibilidad

El store permite hasta 1 MiB de fuente Structurizr. El parser DSL limita la fuente a 256 KiB, 4.000 líneas y 1.000 caracteres por línea; ambos adaptadores limitan a 1.000 elementos, 2.000 relaciones y 100 vistas. El store solo acepta recursos internos `.dsl`/`.json`. URLs no se descargan; mounts e includes no se siguen. IDs sintéticos DSL derivan de alias y relaciones de sus extremos/línea, por lo que editar/reordenar una relación puede crear una identidad nueva y dejar la antigua en el informe de claves obsoletas. No hay interfaz para reasignar a mano esos IDs en este bloque.

No se ofrece equivalencia de layout, estilos, configuración, etiquetas visuales, exports SVG/PNG del renderer original, DSL↔JSON sin pérdida, edición Structurizr ni sincronización del modelo A3 a la fuente. El texto original es siempre recuperable.

## Criterios y verificación

| Criterio | Cobertura E3-E3 | Pendiente |
|---|---|---|
| A3-012 | Parcial: elementos, relaciones y vistas estáticas compatibles se importan como entidades, relaciones y workspaces C4 A3 con IDs reutilizables. | Conversión completa, componentes/despliegue exhaustivos, estilos y fidelidad a Structurizr. |
| A3-015 | Parcial: conserva fuente, informa el subconjunto, mapping, claves antiguas, conflictos y recursos ausentes; aplica solo tras diff explícito. | Parser oficial completo, edición del mapping, round-trip universal y conversión dinámica. |
| A3-016 / A3-017 | Sin cobertura nueva. | Estilos configurables y exportaciones SVG/PNG/PDF se mantienen en sus etapas. |

En Windows:

- `npm test --workspace @a3/domain`: parser DSL y JSON con fixtures, vistas estáticas, fuentes parciales, diagnósticos JSON, includes no ejecutados y límites.
- `node --test packages/project-store/test/structurizr-import.test.mjs`: usa un proyecto temporal para ambas fuentes, aplica vistas por separado, reabre C4, verifica IDs compartidos entre vistas, autoridad, diff de actualización, bytes originales e include remoto no descargado.
- `npm run build --workspace @a3/desktop`: tipos de host/renderer y build Electron.
- `npm run test:structurizr:smoke --workspace @a3/desktop`: recorrido de la UI Electron para previsualizar, importar las vistas estáticas y comprobar la fuente intacta.

El spike E0-D2 comprobó la UI abierta original con fixtures sintéticos en loopback; esta integración no incorpora esa UI, no inicia servidor, no accede a Cloud ni prueba colaboración.
