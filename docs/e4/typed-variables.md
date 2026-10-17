# E4-A1 · variables tipadas y ámbitos

Implementa §15.1 y el subconjunto de A3-018 solicitado: seis tipos, precedencia, referencias por ID, binding de campos declarados e inspector de valor/ámbito efectivo. Reutiliza los contenedores y el comando E1-B, el broker y el escritor/journal E1; React no guarda una segunda fuente canónica. Se parte de `8080965` (E3-G3) en `codex/e3-e7-product`, con origin verificado y checkout limpio.

## Contrato del formato

El manifiesto del proyecto sigue en `formatVersion: 1.0.0`. **VariableSet incorpora `schemaVersion: 1.1.0`**, conservando nombre/ruta y revisión por documento:

- Proyecto: `.a3/variables/project.json`, ownerId = projectId.
- Workspace: `.a3/variables/workspaces/<workspace-id>.json`.
- Entidad: `.a3/variables/entities/<entity-id>.json`.
- Ejecución: solo `executionVariables` del contexto de resolución; no hay archivo, caché, historial local ni contenedor portable de ejecución.

Los esquemas publicados son `schemas/e1/variable-set.schema.json`, `node-type.schema.json` y el descriptor recursivo `value-spec.schema.json`. Es una extensión versionada del contrato E1, no un cambio de identidad de sus objetos. Un documento E1 1.0.0 sigue siendo legible y un no-op conserva sus bytes; solo un comando explícito de edición produce 1.1.0 y avanza revisión usando el journal. No se ejecuta un migrador masivo al abrir. Un lector A3 anterior que no soporte 1.1.0 debe tratarlo en solo lectura mediante su guard existente de versión desconocida. El codec nuevo admite 1.1.0 exclusivamente para VariableSet: no relaja versiones de Entity, Resource ni manifiesto. Versiones posteriores desconocidas siguen sin interpretarse ni degradarse.

En E1 1.0.0 se interpretan string/number/boolean/json y alias contextual; parámetros de tipo añadidos ahora y `source.scope` permanecen opacos. Si un alias E1 ya tenía `source.scope` como dato desconocido, un cambio no puede eliminarlo o activarlo silenciosamente: se exige revisar explícitamente ese campo para adoptar el formato nuevo. Los demás campos y extensiones desconocidos se conservan; la fuente no se normaliza por abrir/consultar.

Una variable 1.1 tiene `name` con namespace, `valueType` y `source`. Su fuente es `{ kind: "literal", value: ... }` o `{ kind: "reference", name: "demo.other", scope?: ... }`. Esta segunda forma es un **alias a otra variable**, distinto del tipo `reference` que identifica objetos A3.

| valueType | Contrato |
|---|---|
| string | Cadena exacta, sin interpretar Markdown, JavaScript o HTML. |
| number | Número finito, sin convertir cadenas; minimum/maximum opcionales. |
| boolean | true/false reales, sin convertir 0/1 o cadenas. |
| enum | Cadena incluida en enumValues, lista no vacía y sin duplicados; comparación exacta. |
| list | Array cuyos elementos cumplen el descriptor items. El dominio admite descriptores anidados hasta ocho niveles. |
| reference | Objeto `{ kind: "entity" | "resource", id: UUID }`; el ID debe existir y respetar referenceKinds si se declara. No se guarda título o ruta como identidad. |
| json | Compatibilidad E1: se sigue leyendo/validando, pero no se ofrece como tipo nuevo del formulario. |

Las referencias a recursos no leen sus bytes ni montajes, y no conceden permisos. Renombrar una entidad/recurso no cambia esos IDs. Una referencia rota produce diagnóstico, nunca un objeto vacío ni una búsqueda por título.

## Resolución y referencias explícitas

La precedencia de un nombre es **ejecución → entidad → workspace → proyecto**. `resolveEffectiveVariable` devuelve valor, tipo declarado, scope efectivo (kind/ownerId) y dependencias de alias con sus scopes. `resolveVariable` conserva la API E1 que devuelve solo el valor. No se elige un workspace por su orden, por ser el predeterminado ni por el viewport activo.

Una referencia de scope es `{ kind: "project" | "workspace" | "entity", ownerId: UUID }`, o `{ kind: "execution" }` en contexto temporal. Un alias/binding puede fijarla explícitamente para ignorar overrides del mismo nombre. Un ciclo se detecta por nombre **y** scope/owner, evitando confundir un alias de entidad hacia el mismo nombre del proyecto con una autorreferencia. El límite de cadena es 64; se diagnostican nombres ausentes, contenedores/propietarios no disponibles, ciclos, tipos inválidos y formatos desconocidos.

Una entidad compartida entre vistas mantiene el mismo Entity ID y binding. Si su valor depende de variables de workspace, cada vista recibe su contexto y puede mostrar un valor distinto. Al resolver esa entidad sin workspace, si existe un override aplicable a alguna representación se solicita contexto (`variable-context-required`) o referencia explícita; no se escoge uno arbitrario. Un override temporal se recibe por petición y no se reutiliza implícitamente en otra sesión/proyecto. El panel permite probarlo y lo descarta al cerrar el panel o cambiar de proyecto; no inicia una ejecución de IA.

## Campos y bindings

NodeType.fields declara nombre, descriptor de tipo, required y acceptsBinding opcional. La lista bindingFields es la concesión explícita de campos; debe referenciar campos declarados y no puede contradecir acceptsBinding:false. Los tipos/paquetes no disponibles mantienen datos opacos y no autorizan bindings nuevos.

`Entity.bindings[<campo>] = { kind: "variable", name: "demo.name", scope?: ... }`. `resolveEntityField` valida tanto el resultado efectivo como el rango/opciones/referencia admitidos por el campo. Un campo no convierte strings a números, ni modifica IDs, rutas o contenido. La validación del snapshot comprueba bindings conocidos en cada workspace representado: un override que invalide el tipo de otra vista no obtiene un plan de escritura. Una dependencia ausente se conserva como diagnóstico reparable; no se inventa un valor.

El comando `a3.variables.bind-field` vincula/desvincula un campo permitido con revisión de Entity; usa el mismo kernel/broker/writer. El host exige además que un binding nuevo pueda resolverse en el contexto revisado. Al desvincular vuelve a usarse la propiedad literal, si existe; los archivos fuente y las posiciones no cambian.

La integración visible inicial es **a3.display.label** (string) en nodos de contenido. El lienzo recibe un displayTitle derivado por workspace; Entity.title sigue siendo canónico y editar la variable no reescribe Entity ni Markdown. Los otros campos declarados se pueden resolver/inspeccionar mediante el mismo contrato, pero no se infiere semántica de parámetros C4/UML/IoT ni se habilitan bindings para propiedades que sus tipos no declaran. No hay sustitución global de palabras, de `{{...}}` en archivos ni de IDs. La compilación de plantillas/prompts pertenece a los siguientes bloques E4.

## UI, permisos y fallos

La pestaña Variables ofrece contexto workspace/entidad, selector de referencia explícita, tabla de valor/tipo/scope efectivo, declaraciones por ámbito y formulario tipado. Listas compuestas no admitidas por el formulario se conservan y se remiten al editor fuente, sin simplificarlas. Los alias existentes conservan su scope salvo cambio explícito. El inspector de campos muestra valor o diagnóstico, binding y scope efectivo. Campos/acciones están etiquetados y mantienen foco visible.

El renderer envía IDs y datos declarativos por un IPC validado (hasta 256 variables y 128 KiB por petición). No recibe disco, servicios ni permisos efectivos. Leer exige project.read; editar contenedores/bindings exige document.edit según el broker del host. Proponer pide aprobación al aplicar, Consultar deniega edición, Trabajar la permite y revocar afecta la siguiente operación. Cada cambio valida la revisión observada; un conflicto conserva el borrador y pide recargar/comparar, sin sobrescritura automática. La revocación y validación se repiten en el escritor.

Las credenciales no tienen tipo de variable, acceso al almacén de cuentas ni fallback a variables de entorno. Se rechazan nombres reservados de contraseña/token/secretos, marcadores secret/sensitive/classification:credential y prefijos de credenciales reconocidos, sin incluir sus valores en diagnósticos/auditoría. Estos controles no son un detector universal de secretos arbitrarios: el panel indica que no se deben introducir contraseñas, tokens ni claves. No se guardan credenciales de prueba.

Un VariableSet corrupto o de versión desconocida aparece como ámbito bloqueado; ni la ausencia de registro tipado ni un listado vacío autorizan reemplazar sus bytes. Los demás documentos se conservan. Los recursos referenciados y el Markdown permanecen intactos. No se añade recuperación, undo de variables, ejecución de expresiones, plugins, envío de prompts o proveedores IA en este bloque. Las operaciones persistidas usan el journal existente, sin prometer atomicidad global o tolerancia a un corte eléctrico físico.

## Evidencia

`fixtures/e4/variables/scenario.json` contiene los seis tipos, IDs reales de los fixtures E0 y overrides de los cuatro niveles. Pruebas nuevas:

- `packages/domain/test/variables.test.mjs`: tipos, precedencia, dos vistas, scope explícito, alias/ciclos, IDs tras renombre, campos/rangos opt-in, credenciales marcadas, compatibilidad E1/1.1 y versión futura.
- `packages/project-store/test/variables.test.mjs`: Windows temporal, comandos por broker/writer, hash de Markdown y Entity sin cambios al cambiar variable, campos desconocidos, reapertura, revisión obsoleta, revocación, contexto de otra sesión, corrupción y versión desconocida sin sobrescribir bytes.
- `packages/project-store/test/codec.test.mjs`: no-op VariableSet 1.1 con BOM/CRLF y preservación de versiones desconocidas; las otras familias conservan sus límites de versión.
- `npm run test:variables --workspace @a3/desktop`: Electron real oculto sobre proyecto/perfil temporal; variable/override, binding visible, dos vistas, ámbito explícito, ejecución no persistida, feedback de tipo inválido, IPC estricto, foco y renderer sin Node.

Regresión: suite completa de dominio; codecs, reader y seguridad del store; contratos E0. Build/tipos con los pins existentes y sin instalar dependencias. El aviso previo de Vite sobre chunks grandes permanece. No se prueba Linux, ejecución de agentes ni aceptación completa de las etapas posteriores E4.

Resultado local observado el 2026-10-16 en Windows x64, Node 24.13.1 y Electron 44.7.2: **224/224 pruebas** de contratos/dominio/store, **smoke Electron aprobado**, tipos y build aprobados. Solo se usaron proyectos y perfiles temporales; no se modificaron datos de proyectos reales.

A3-018 obtiene evidencia para este subconjunto tipado y contextual; A3-004 cubre el caso de entidad compartida con valores de vista distintos; A3-033/047/048 cubren las denegaciones, revisiones y conservación comprobadas. No se declara cubierta toda la gestión de prompts, paquetes o preferencias.
