# ADR 0002 — Núcleo de dominio E1-B

Estado: implementado. Fecha: 2026-10-14. Base: E1-A `4985d08` en `codex/e1-base`. Detalles compatibles con §§5–8/28 y contratos E0-A; la especificación y los esquemas E0 no se modifican.

## Modelo y autoridad

El paquete `@a3/domain` contiene solo TypeScript y Ajv 8.20.0 ya fijado en E0. No importa Electron, React, Node, DOM, disco o red. El build genera un módulo estático desde `schemas/e0` y `schemas/e1`; leer esos archivos ocurre solo en el script de construcción. Los `$id` son nombres lógicos: no se usa un loader remoto. Ajv compila únicamente esos esquemas de confianza, sin coerción/defaults ni eliminación de propiedades. No se compilan como código las definiciones de usuario. Este validador se ejecutará en el host; no se anuncia como compatible con una CSP de renderer que prohíba la generación dinámica de funciones de Ajv.

`DomainSnapshot.records` es una proyección en memoria de documentos canónicos, no un formato de archivo nuevo. Los registros de vistas añaden `workspaceId` en el wrapper; no lo escriben dentro de un Placement E0. El manifiesto tiene `projectId`; los otros documentos administrados conservan `id`, salvo el contenedor de variables por propietario. Fuente humana sigue en Resource, no en las vistas ni en un segundo campo de texto.

Se elige UUID único en el proyecto para Project/Workspace/Entity/Resource/Relation/Placement/VisualEdge/RelationView/Collection. Group y el encabezado opaco de Drawing tienen identidad local al workspace, compartiendo ese ámbito local. Comparar UUID ignora mayúsculas sin cambiar los bytes del documento; IDs de puerto distinguen mayúsculas. Una identidad ambigua bloquea comandos. Las revisiones crecen una vez por documento modificado, comienzan en 1 y no pasan MAX_SAFE_INTEGER. El manifiesto no se convierte en contador global.

## Contratos adicionales mínimos

Los cinco esquemas E1 publicados complementan, sin reemplazar, E0:

- Group: `name`, `members: [{kind: placement|group|drawing, id}]`. Referencias locales, sin duplicados/ciclos; no representa contención C4. Mover transforma cada placement alcanzable una vez. Si incluye dibujo, falla con ENGINE_UNAVAILABLE hasta el comando de geometría E2.
- Collection: `name`, `entityIds`; colección lógica sin alterar placements ni archivos.
- Variable: nombre con namespace, `valueType`, `source` literal o referencia por nombre. VariableSet es el documento revisado con `scope: {kind, ownerId}`, `variables` y extensiones. Los alcances persistidos son project/workspace/entity; ejecución se pasa a la consulta y no entra al snapshot. Precedencia: ejecución > entidad > workspace explícito > proyecto. Se detectan ciclos, nombres faltantes y tipos incompatibles. Una expresión desconocida no se evalúa; el lenguaje de expresiones y la compilación de prompts siguen en E4. No se infiere workspace de una entidad con varias vistas.
- NodeType: definición declarativa de paquete por `name@version`, `packageId`, campos tipados, puertos/direcciones, campos de binding y extensiones. Está en un catálogo externo al snapshot documental. Registrar/quitar devuelve cambios del catálogo; no instala paquetes ni ejecuta entrypoints. La misma versión no se reemplaza. Quitar conserva todas las entidades para fallback; la persistencia de autoría del paquete se conecta después.
- RelationType: reglas declaradas de tipos de entidad, puerto, dirección y cardinalidad por extremo. Una relación dirigida cuenta source/target por separado; una no dirigida exige reglas conocidas simétricas y cuenta incidencia por entidad/puerto, sin inferir semántica UML/IoT. Máximos bloquean cambios nuevos; mínimos incompletos se diagnostican durante edición y deberán revisarse para exportación técnica. Es un límite del grafo declarado, no una interpretación de multiplicidad de objetos UML/ER. `a3.core.references@1.0.0` es la única regla incorporada, sin límites de grado. C4/UML/IoT requieren reglas/adaptadores posteriores.

Los campos desconocidos se conservan como JSON opaco. Patches de propiedades/bindings preservan namespaces no mencionados, y puertos/variables mantienen atributos desconocidos. No se remapean IDs encontrados arbitrariamente dentro de extensiones: solo las referencias conocidas. Un tipo ausente produce diagnóstico; nunca transforma o borra contenido automáticamente.

## Comandos y fronteras

El host aporta un actor autenticado, AuthorizationPort, catálogo y hashes observados previamente. El actor del request debe coincidir; una concesión no se deriva del payload. La autorización se consulta antes del cálculo y nuevamente con cambios concretos, ubicaciones de Resource, efectos de contenido y cambios de NodeType. Scope limita entidades afectadas. Un adapter que falla o no devuelve true deniega.

`prepareCommand` recibe snapshot/JSON y devuelve Outcome con un plan congelado `status: prepared`; no lo llama guardado o completado. IDs/timestamps nuevos son entradas explícitas: no hay reloj ni RNG internos. Se exige revisión esperada de cada escritura/borrado; crear declara revisión null (ausencia). El ejemplo E0 `a3.core.update-entity`, payload directo y una entidad en scope es compatible; hashes omitidos equivalen a lista vacía para comandos sin fuentes locales.

La validación consulta el snapshot completo. Por seguridad inicial, `readSet` recoge las revisiones observadas de todas las dependencias, y `baseFingerprint` es JSON canónico del catálogo documental, definiciones y hashes de contenido; no es un hash criptográfico ni un campo portable. Detecta cambios de catálogo incluso cuando aparece un documento nuevo. El writer futuro debe revalidar bajo su lock antes de persistir, verificar contención real/permisos/bytes y confirmar datos más ledger en una unidad recuperable. La propuesta incluye un fingerprint de request para detectar reutilización indebida de operationId en ese ledger. Repetir sobre la misma base produce el mismo plan; no se afirma idempotencia durable ni exactamente una vez sin E1-C/D.

Los errores previos de referencias se conservan: un cambio válido puede reparar o renombrar otra parte sin borrar la relación rota. Cambios que añaden o agravan errores se rechazan. Identidades duplicadas o número inválido de manifiestos no admiten esa excepción por ser ambiguos. Versiones fuera del perfil E0/E1 no se reescriben: el kernel devuelve diagnóstico; el lector E1-C se ocupará de inspección/solo lectura.

## Duplicación y eliminación

Duplicar selección de placements en modo content clona una vez cada entidad/recurso compartido por la selección, sus variables por entidad, relaciones internas, aristas visuales internas y RelationViews. Solo se remapean referencias conocidas. Los conectores conservan sus IDs locales. Los nuevos archivos requieren ubicación distinta y hash anterior; se devuelve una instrucción de copia al host. URLs duplican el descriptor y no descargan. Relaciones externas permanecen intactas por defecto; copiarlas requiere opción explícita y scope para sus extremos. Mode representation solo crea placements/vistas, conservando contenido e IDs de Relation.

Quitar placement borra sus aristas/vistas locales y membresías de grupo, conservando Entity/Resource/Relation. Quitar Entity prepara una cascada revisada de relaciones, placements, vistas, membresías y variables; conserva Resource. Quitar Resource usado se deniega; quitar su descriptor no borra bytes. Quitar Group/Collection conserva miembros. Quitar workspace principal exige otro existente; conserva las entidades globales. Borrar un proyecto o editar/copiar geometría desconocida corresponde al host/E2. Una mudanza de Resource conserva ID/clase de ubicación y entrega efecto, sin ejecutar IO.

## Alternativas y límites

Guardar estado de React Flow o texto en placements duplicaría autoridad. Mutar el snapshot de entrada impediría revisar fallos sin efectos parciales. Generar IDs aleatorios dentro del reducer rompería determinismo de propuestas. Validar solo el esquema no cubriría referencias. Se elige un plan inmutable y validación estructural + semántica con puerto de autorización.

La validación completa y el fingerprint son conservadores; la indexación incremental y los presupuestos de escenas grandes requieren medidas en integración. Las referencias se consultan mediante índices derivados por snapshot, y el draft mantiene índices de identidad para sus escrituras. La resolución de variables interna reutiliza el índice validado sin recorrer todo el JSON por cada variable. No se cuentan grados cuando la regla no declara límites. No se implementa persistencia, watcher, migrador, ledger durable, integración UI ni ejecución aislada. A3-004/005 tienen evidencia del modelo; sus aceptaciones completas requieren E1-C/D y E2.
