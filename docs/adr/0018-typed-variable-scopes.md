# ADR 0018 · variables tipadas y ámbitos

Estado: implementado en E4-A1, sobre los contratos de variables E1-B y §15.1/A3-018. El [contrato detallado y evidencia](../e4/typed-variables.md) es la referencia del bloque.

1. Reutilizar VariableSet y `a3.core.set-variables`, con escritura explícita 1.1.0 para impedir que lectores anteriores interpreten scopes nuevos como alias E1. Leer 1.0.0 conserva su significado y bytes; no migrar al abrir. El manifiesto no cambia de versión. Versiones futuras siguen en solo lectura.
2. Describir enum/list/reference mediante ValueSpec declarativo; mantener json para compatibilidad E1. Referencias de objetos usan Entity/Resource IDs, alias de variables usan nombre y scope opcional. No ejecutar expresiones ni sustituir texto global.
3. Resolver con contexto explícito y devolver procedencia del valor. Ejecución es dato temporal por consulta; no se convierte en archivo, preferencia local o variable de otro proyecto.
4. Autorizar bindings únicamente en campos declarados y validar su resultado en todas las vistas conocidas. Usar el nuevo comando `a3.variables.bind-field` y el broker/escritor existentes; ninguna escritura directa del renderer.
5. Introducir `a3.display.label` como campo de presentación de contenido. El displayTitle del canvas es una proyección por workspace; no reemplaza Entity.title ni el Markdown. Otros adaptadores deben declarar sus campos antes de usar bindings.

Consecuencia: una aplicación anterior puede abrir datos sanos y conservar un VariableSet 1.1 como desconocido, pero no debe editarlo ni degradarlo. Un campo scope opaco en un alias E1 requiere revisión explícita antes de adoptar el formato. No se habilitan credenciales, ejecución de código, proveedores ni compilación de prompts.
