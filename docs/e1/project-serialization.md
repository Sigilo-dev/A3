# E1-C1 — Serialización y lectura validada

Base comprobada: E1-B `c141918`, rama `codex/e1-base`, origin `https://github.com/Sigilo-dev/A3.git`, árbol limpio al iniciar. Fuentes: especificación local §§6–8/28, contratos E0-A, schemas/fixtures E0 y suplementos E1-B. E0 permanece sin modificar. La [ADR 0003](../adr/0003-project-codecs.md) fija orden, preservación, compatibilidad y límites.

## API del paquete

`packages/project-store` exporta `@a3/project-store` para el host Node. No importa React, React Flow ni Electron. Reutiliza `@a3/domain@0.1.0-dev.0`; TypeScript 7.0.2 y tipos Node 24.19.2 son pins existentes. El lock añade únicamente este workspace; no hay nuevas bibliotecas externas ni actualizaciones masivas. Código original MIT; las licencias de dependencias existentes siguen en E1-A/B. Desde E1-E1, los lectores que reciben una ruta raíz son internos al paquete y no se exportan como vías de acceso de la aplicación; la app debe leer mediante el servicio autorizado con broker.

| API | Resultado y garantía |
|---|---|
| `decodeDocument(location, bytes)` | Retiene una copia de los bytes, SHA-256 y diagnóstico. Estado valid/invalid/read-only; árbol de inspección si es representable sin pérdida, registro tipado solo si valida. `originalBytes()` devuelve una copia nueva. |
| `encodeDocument(document, edits?)` | No-op exacto o bytes JSON canónicos. Los edits por JSON Pointer preservan lo no mencionado; un cambio exige siguiente revisión e identidad constante. Rechaza documentos inválidos, futuros y dibujos opacos. No escribe. |
| `serializeRecord(location, record)` | Bytes canónicos para un registro completo nuevo. Valida shape, versión y ubicación; no autoriza creación ni reemplazo de un archivo existente. |
| `reader.ts: readProject/readProjectResource` | Funciones internas de catálogo, documentos originales y bytes. No se exportan en el punto de entrada público; el broker sigue siendo obligatorio para la aplicación. |
| `resolvePortablePath(root, path)` | Validación lógica interna de ruta relativa y aliases Windows. No equivale a permiso ni se exporta como autorización de acceso. |

Ejemplo después de compilar los workspaces:

```ts
import { decodeDocument, encodeDocument } from '@a3/project-store';

const entity = decodeDocument(location, bytesReadByTheAuthorizedService);
if (entity.status === 'valid' && entity.record) {
  const preview = encodeDocument(entity, [
    { op: 'set', pointer: '/title', value: 'Nuevo título' },
    { op: 'set', pointer: '/revision', value: entity.record.value.revision + 1 }
  ]);
  // El codec es puro; solo ProjectService puede validar permisos y guardar.
}
```

Los codecs no reemplazan los comandos de dominio. El futuro writer debe tomar una propuesta autorizada, validar el grafo final, revalidar permisos/revisiones/hashes y aplicar su protocolo recuperable. Una línea visual se conserva separada de Relation, y varios placements siguen compartiendo una Entity/Resource.

## Apertura y diagnóstico

Se cargan manifiesto, entidades, recursos, relaciones, colecciones, workspaces, placements, aristas visuales, vistas de relación, grupos y variables persistidas. Drawings se preservan como encabezado/inspección opaca. Las definiciones declarativas se suministran mediante `options.registry`, sin ejecución ni descubrimiento automático de paquetes.

`ready` indica catálogo leído sin errores; `degraded` permite inspeccionar documentos sanos junto a errores; `read-only` conserva algún formato/dato que no puede reescribirse con este perfil; `unavailable` indica que no se pudo descubrir el proyecto desde su manifiesto. `catalogComplete` señala si la lectura del layout conocido terminó sin rutas omitidas por IO/presupuesto. No certifica que los documentos hayan pasado el esquema. Un JSON inválido sigue en `documents` con sus bytes y sin registro tipado. No se sustituye por `{}` ni se borra una relación que apunte a él.

Un manifiesto futuro solo se inspecciona; no se infiere su layout. Un documento futuro en un catálogo 1.0.0 no entra al snapshot tipado, pero se conserva en documents y se leen sus vecinos. JSON con claves duplicadas/números no representables se inspecciona únicamente por bytes. Los archivos de código/Markdown se abren como recursos originales, incluyendo UTF-16 o CRLF, sin enviarlos al codec JSON.

## Evidencia Windows

Entorno: Windows 10 x64 build 19045, Node.js 24.13.1, npm 11.10.0. Los tests usan copias temporales sintéticas, comprueban el destino de limpieza antes de borrarlo y no escriben fixtures E0 ni datos del usuario.

- `npm ci --no-audit --no-fund`: instalación desde lock, exit 0; pins previos intactos.
- `npm test`: 34 contratos E0 + 44 dominio + 50 store, 128 pruebas aprobadas. Incluye unknown fields/namespace/prototype keys, JSON truncado y UTF-8 inválido, major/minor desconocido, revisión agotada, profundidad en lectura/codificación, paths relativos, filename/ID, junction Windows, errores de referencia, scopes E1-B y no-op exacto de todos los JSON E0.
- Recursos: lectura exacta de Markdown con BOM/CRLF, código UTF-16 y bytes arbitrarios; SHA-256 coincide con fuente. No se reescriben fuentes al abrir proyecto.
- `npm run typecheck` y `npm run build`: verifican todos los workspaces, exit 0. El desktop conserva los mismos bundles/placeholders de E1-A.
- `git diff --check`: revisión de whitespace antes del commit. No se modifican schemas/fixtures E0, locks de experimentos ni UI/IPC de E1-A.

## Trazabilidad y trabajo pendiente

**A3-045 (corrupción localizada): parcial comprobado.** Un JSON de Entity truncado conserva exactamente sus bytes, manifiesto/Markdown no cambian, se leen 11 documentos sanos y se informa sintaxis localizada + referencias a la entidad ausente. Restaurar y preservar cambios externos posteriores requiere writer/recovery E1-C2/D; no está implementado.

**A3-048 (migración): únicamente lectura segura de versión mayor comprobada.** No hay downgrade ni serialización del formato futuro; sus bytes/datos siguen disponibles para inspección. No se ejecuta migrador ni se prueba interrupción/recuperación de migración en C1.

La lectura validada de montajes locales y la revalidación de rutas se añadieron en E1-E2; no hay todavía índice recursivo de carpetas montadas, escritor externo ni UI de montaje. Las guardas bloquean traversal, junctions/symlinks y cambios de identidad observados antes de usar el handle, pero no son aislamiento OS frente a otro proceso del mismo usuario. Procesos arbitrarios siguen deshabilitados. La integración completa con UI/IPC y proyectos grandes se validará al integrar los servicios. No se genera instalador en este corte.
