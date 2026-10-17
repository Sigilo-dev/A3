# ADR 0019 · resolución de referencias y compilación de variables

Estado: implementado en E4-A2, compatible con VariableSet 1.1 de ADR 0018.

1. Resolver `{{namespace.nombre}}` únicamente en una proyección de lectura/compilación. La plantilla y los documentos canónicos nunca se reescriben para reemplazar variables.
2. Reutilizar `resolveEffectiveVariable` para precedencia, alias, tipos y procedencia. La expansión anidada agrega un límite de profundidad de 64 y detecta ciclos por identidad de scope y nombre.
3. Dejar errores visibles en la salida y adjuntar diagnóstico. Un nombre requerido sin valor impide el envío automático; el export manual conserva marcadores y el encabezado de errores.
4. Limitar la primera interfaz de compilación a Markdown de entrada, contexto proyecto/workspace/entidad y variables. Las fuentes de contexto completas, plantillas almacenadas, helpers autorizados y ejecución quedan para etapas siguientes.
5. Aplicar la misma vista derivada al preview de página y al export del canvas. Un export de entidad siempre se origina en un workspace concreto.

El contrato y evidencia del bloque están en [E4-A2](../e4/variable-resolution-and-compilation.md).
