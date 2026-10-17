# E5-F1 · contexto trazable y skill A3

E5-F1 conecta el compilador local E4 con una guía portable del contrato A3. La selección la hace la persona en el panel de prompts. El host valida IDs dentro del proyecto abierto; no agrega por defecto memoria, relaciones, archivos ni contenido vecino. Una entidad seleccionada aporta su documento canónico y, cuando existe, su recurso Markdown asociado. Una relación solo se incluye por selección explícita; sus extremos y `VisualEdge` no amplían el contexto.

## Manifiesto y registro

El preview informa fuentes incluidas/omitidas, IDs estables, rol/categoría, ruta relativa, revisión, SHA-256, tamaño original/aportado y partes. Excluir una fuente queda como `user-excluded`; el exceso de presupuesto se omite completo o se divide entre partes UTF-8, nunca se trunca en silencio. El registro local `.a3/local/prompt-runs/<uuid>.json` mantiene selección/exclusiones, hashes de plantilla/entradas/partes/fuentes y valores tipados de variables efectivamente resueltos junto a ámbito y hash del valor. No contiene los bytes fuente ni el Markdown compilado completo.

Los valores resueltos se guardan en `.a3/local`, excluido de Git, para identificar las entradas efectivas de una ejecución; pueden contener texto del proyecto. Las credenciales no son variables A3. Los valores de formulario originales se resumen con hash y no se copian en la traza.

## Skill portable

`skills/a3/SKILL.md` describe límites de selección, memoria, IDs/revisiones, permisos, herramientas actuales, diagnóstico, procedencia y formato de informe. Su archivo de referencia `skills/a3/references/a3-tool-schemas.json` contiene los JSON Schema 2020-12 exactos exportados por `@a3/project-store`. Regeneración después de editar `A3_TOOL_SCHEMAS`:

```powershell
npm run build --workspace @a3/domain
npm run export:skill-schemas --workspace @a3/project-store
```

Una prueba compara los schemas del paquete con el artefacto portátil y verifica que la guía conserve límites importantes.

## Separación de envío

Copiar y exportar produce Markdown. «Abrir ChatGPT manual» solo abre la pestaña, no pega ni envía contenido. Nada de eso inicia un turno Codex. Este commit no conecta el compilador al transporte de turnos; los contratos de herramientas del host tampoco se registran todavía con Codex app-server/MCP. Los prompts copiados son distintos de mensajes/transcripts de un turno y no se registran como respuesta de proveedor.

## Verificación y cobertura

- `packages/project-store/test/variables.test.mjs`: compila una entidad ESP32 elegida por ID, confirma que una exclusión aparece en el manifiesto y ejercita el aislamiento entre proyectos A y B. También comprueba el valor resuelto y el hash de una traza sin copiar los bytes de la fuente.
- `packages/project-store/test/a3-skill.test.mjs`: compara schemas de la skill con el contrato host y verifica los límites documentados.
- `apps/desktop/test/variables-smoke.cjs`: verifica que copiar/abrir manual está rotulado aparte de iniciar turnos Codex.

Cubre el flujo local de contexto de A3-019, el aislamiento de A3-022 y documentación coherente con las herramientas/permisos de A3-033. No acredita uso de herramientas desde una inferencia real, un turno Codex con contexto adjunto, registro MCP, catálogo/selección de modelo desde el editor, actualización de tareas mediante agente ni la seguridad frente a secretos escritos libremente en contenido fuente.
