# E1-B — API y evidencia del núcleo de dominio

Base: E1-A `4985d08` en `codex/e1-base`; fecha: 2026-10-14. Implementación en `packages/domain`; decisiones y asuntos E0 resueltos para este corte: [ADR 0002](../adr/0002-domain-kernel.md).

## Modelos y validación

Se exportan Project, Workspace, Entity, Resource (unión de ubicación), Relation, Placement, VisualEdge, RelationView, Group, Collection, Variable/VariableSet y NodeType. RelationType declara reglas externas; TypeRegistry es un catálogo de definiciones, separado de documentos de proyecto. El formato/nombres de los ocho documentos E0 se conservan. [Esquemas E0](../../schemas/e0/) y [complementos E1](../../schemas/e1/) se integran estáticamente durante build.

Funciones públicas: `validateRecord`, `validateDefinition`, `validateRegistry`, `validateSnapshot`, `resolveVariable`, `prepareCommand`, `revalidatePlan`, `defaultRegistry`, `refOf`, `refKey`, `revisionsOf`, `getRecord`, `indexSnapshot`. Este último crea una consulta derivada por identidad para un snapshot validado; no es otra fuente editable. El consumidor importa desde `@a3/domain` después de build; los tipos se publican como declaraciones TypeScript. No se modifica el IPC de E1-A para exponer comandos sin el broker de E1-E.

## Superficie de comandos

| Comando | Payload / comportamiento |
|---|---|
| `a3.core.create-project` | Project + Workspace principal, snapshot vacío. |
| `a3.core.create-document` | DomainRecord validado; no otro manifiesto ni dibujo de geometría no soportada. |
| `a3.core.rename` | Ref + name; Project/Workspace/Entity/Group/Collection, ID estable. |
| `a3.core.update-entity` | Payload directo title/tags/properties/ports/bindings; exactamente una entidad en scope. |
| `a3.core.move-placement` | Ref + position; solo cambia esa vista. |
| `a3.core.move-resource` | resourceId + location local de la misma clase; efecto al host + hash. |
| `a3.core.move-group` | Ref + offset; placements únicos alcanzables; trazo desconocido bloquea. |
| `a3.core.set-group-members` | Ref + miembros locales; valida ausencia/duplicado/ciclo. |
| `a3.core.set-collection-members` | collectionId + entityIds. |
| `a3.core.set-variables` | Scope + variables; crea/actualiza un contenedor revisado. |
| `a3.core.delete` | Ref; cascada revisada según tipo. Workspace principal requiere reemplazo. |
| `a3.core.duplicate-selection` | Workspace, placements, modo, offset, mapas de IDs nuevos y ubicaciones de copias; opción externa false por defecto declarada en payload. |
| `a3.core.register-node-type` | Definición nueva por name/version; no reemplaza esa versión. |
| `a3.core.unregister-node-type` | name/version; conserva instancias y diagnósticos de fallback. |

No hay rename de IDs, ejecución arbitraria, comandos de archivo nativos ni interpretación técnica C4/UML/IoT. Los comandos con contratos todavía ausentes devuelven diagnóstico en vez de inventar geometría/reglas.

## Uso por el host

Ejemplo conceptual, con snapshot/catálogo y puerto de permisos ya provistos por el host:

```ts
import { prepareCommand, revisionsOf } from '@a3/domain';

const result = prepareCommand(snapshot, {
  operationId, projectId, actor: authenticatedActor,
  command: 'a3.core.rename',
  scope: { entityIds: [entityId] },
  expectedRevisions: revisionsOf(snapshot),
  payload: { ref: { kind: 'entity', id: entityId }, name: 'Visión revisada' }
}, { authenticatedActor, authorization: permissionPort, registry, contentHashes });

if (result.ok) {
  // Mostrar changes/contentEffects/diagnostics al usuario según la política.
  // No mostrar Guardado aquí: el plan está en memoria.
  const plan = result.value;
  // El futuro ProjectCommitPort revalida bajo lock y confirma datos + ledger.
}
```

Para crear documentos se añaden precondiciones `{...ref, revision: null}`. Para mover/copiar fuentes locales, request lleva `expectedContentHashes` y el contexto lleva SHA-256 observados por el host. El kernel no calcula esos hashes leyendo disco. Permisos deben inspeccionar `changes` y `nodeTypeChanges`, no solo el scope solicitado. El actor en JSON nunca prueba identidad.

Un éxito de preparación puede incluir diagnósticos previos o advertencias de tipos/mínimos; no certifica exportación técnica ni persistencia. `revalidatePlan` también detecta propuesta alterada o permiso revocado. E1-C/D implementarán ProjectCommitPort y ledger; los fingerprints contienen metadata en memoria, no deben enviarse a logs/Git como si fueran resúmenes seguros.

## Verificación

```sh
npm ci
npm run typecheck
npm run build
npm test
```

`npm run test:domain` ejecuta solo este paquete. Las 44 pruebas del dominio leen fixtures E0 sintéticos y comprueban comandos/invariantes: vistas compartidas, IDs/revisiones, datos desconocidos y puertos, relaciones visuales/semánticas, duplicación interna/externa explícita, fuentes independientes, hashes, permisos/scope, cascadas, cardinalidades, grupos, variables, catálogo versionado, revalidación y entradas malformadas. No requieren Electron ni cuentas/red para ejecutarse una vez instalado el lock. La consulta de fixture no se convierte en lector de proyectos de producto.

Trazabilidad: **A3-004**, una Entity/Resource compartida por varias vistas y movimiento independiente, verificado en memoria; falta edición real de fuente y UI. **A3-005**, IDs nuevos, relaciones/vistas internas y otra representación, verificado en memoria; falta que el writer copie bytes y que la selección real de UI use estos comandos. Ambos criterios completos siguen pendientes de integración.

Ajv 8.20.0 (MIT) y su árbol ya verificado en E0 se reutilizan; TypeScript 7.0.2 (Apache-2.0) sigue como herramienta existente. No se actualizan versiones/transitivas de E1-A o spikes. El build de desktop conserva su shell de E1-A. Los comandos de dominio no están conectados a archivo/IA/renderer hasta los siguientes bloques.
