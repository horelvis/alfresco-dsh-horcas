# De usar un agente con criterio a creer que el agente sustituye el criterio

> **Base para post de LinkedIn.** Material de trabajo, no el post final.
> Todo el contenido está **anonimizado**: sin nombres de cliente, IPs, rutas, hosts ni datos reales.
> Se describe un proyecto real (migración de un gestor documental Alfresco a su familia 26.x) para
> aterrizar las ideas con hechos, no con opiniones.

---

## 1. Tesis

La IA no elimina la experiencia: **la hace visible y encarece su ausencia**.

Un agente multiplica a quien sabe qué pedir, qué verificar y dónde están los límites.
A quien no lo sabe, le multiplica una **ilusión de producto** que se rompe en el primer contacto
con datos reales, producción o un cliente.

La diferencia no está en la herramienta (el mismo agente, el mismo modelo). Está en:

- **el vocabulario** con que formulas la petición,
- **las preguntas** que haces antes de escribir una línea,
- **los límites** que impones desde el minuto cero,
- y **la evidencia** que exiges para dar algo por bueno.

---

## 2. El experimento real (anonimizado)

Contexto: migrar un repositorio documental grande (cientos de miles de nodos) de una versión
antigua a la 26.x. Existe, además, **una incidencia previa** de otra migración distinta que dejó
la base de datos dañada. Y una decisión: dejar de construir el agente sobre un framework propio y
usar un **arnés de agentes** (loop, memoria, herramientas, subagentes) como base.

Durante el proyecto se produjeron dos historias en paralelo:

1. **El agente escribiendo código** (rápido, plausible, a veces equivocado).
2. **La persona con experiencia corrigiendo el rumbo** con una frase quirúrgica.

Ese contraste es el post.

---

## 3. La diferencia, dimensión a dimensión

| Dimensión | Quien usa el agente con experiencia | Quien quiere "saltarse el paso" |
|---|---|---|
| **Vocabulario** | Distingue "índice de búsqueda" de "índice de PostgreSQL". Una sola palabra mal usada invalida todo el diseño. | "Haz que migre los índices" y confunde motor de búsqueda con restricciones de integridad. |
| **Plataforma** | Pregunta **qué ya trae el framework** antes de implementar (jobs, checkpoints, skills, workflows, subagentes). | Reimplementa a mano lo que la plataforma ya resuelve. |
| **Límites** | El **origen es intocable**, la escritura exige aprobación, prod no se toca sin ensayo. | "Ejecútalo en producción y vemos". |
| **Verificación** | Exige **evidencia**: huella del origen, manifiesto SHA-256, conteos, drift. | Confía en que "el agente lo habrá hecho bien". |
| **Datos** | Sabe que el esquema **cambia por versión** y valida contra la referencia de *esa* versión. | Asume que el esquema es fijo y mete una lista de tablas a fuego. |
| **Conocimiento** | Lo saca del código y lo pone en **skills/ficheros** para que evolucione. | Lo escribe hardcodeado y lo llama "producto". |
| **Humanos** | Sabe que hay cosas que **solo el humano sabe** (dónde vive el almacenamiento real) y las pregunta. | Inventa una respuesta plausible. |
| **Coste del error** | Planifica rollback, ensaya en copia, retiene el origen. | Aprende el coste del error en el peor sitio. |

---

## 4. Lo que hizo el agente y lo que corrigió el experto

Esta tabla es el corazón del post: errores **reales** del agente, detectados por experiencia.

| El agente hizo… | La persona corrigió con… | La lección |
|---|---|---|
| Metió los índices de búsqueda en el mismo saco que los de la base de datos. | "Eso son **índices de PostgreSQL**, nada que ver con el motor de búsqueda." | El vocabulario es diseño. Confundir dos conceptos produce un producto que no cumple. |
| Fijó a fuego la lista de tablas críticas. | "El esquema **cambia**; si validas índices, **tienes que conocer las tablas** de cada versión." | Los datos de referencia se versionan, no se codifican. |
| Empezó a implementar antes de mirar la plataforma. | "Revisa si eso **ya viene por defecto** en el arnés." | No reinventes lo que tu base ya te da. |
| Metió listas de fabricantes de almacenamiento en el código. | "Veo **mucho hardcode**; tenemos el agente y el LLM para analizar respuestas." | El código da **hechos**; el juicio lo hace el modelo con conocimiento. |
| Intentó decidir si dos discos comparten almacenamiento desde la propia máquina. | "Eso **siempre se puede preguntar al humano**." | Hay información que no está en el sistema: pregúntala. |
| Modeló "la" prueba como un evento único. | "Puede haber **más de una experiencia**: ejecutas, falla, restauras y reanudas." | La realidad es iterativa; el modelo de datos debe serlo. |
| Bloqueó toda aprobación heredada por subagentes. | "¿Eso **no crea un problema** donde no lo había?" | Una guarda demasiado amplia rompe flujos legítimos. |
| Bloqueó un paso antes de comprobar el entorno. | "¿Solo PostgreSQL?" | Aísla la causa antes de "arreglar". |
| Rompió la variable `PATH` del shell por usar un nombre reservado. | (detectado al ver el fallo) | La experiencia también es saber el terreno. |
| Escribió un test que dependía del entorno de la máquina. | (detectado al ver el fallo) | Un test que pasa solo a veces no es un test. |

**Patrón:** el agente produce algo **plausible** en segundos. El experto distingue lo **correcto** de
lo plausible. Esa distinción es el trabajo.

---

## 5. Qué hace distinto alguien con experiencia (checklist mental)

1. **Define el vocabulario antes de actuar.** Nombra con precisión; cada término ambiguo es un bug futuro.
2. **Audita la plataforma antes de construir.** Pregunta "¿esto ya existe?" antes de "¿cómo lo hago?".
3. **Impone límites primero.** Origen intocable, escritura con aprobación, nada en prod sin ensayo.
4. **Separa hechos de juicio.** El código recoge datos; el razonamiento (modelo + conocimiento) decide.
5. **Versiona el conocimiento.** Esquemas, reglas y recomendaciones se guardan por versión y se actualizan.
6. **Exige evidencia.** Sin huella, checksum o conteo, no hay "hecho"; hay "creo que".
7. **Ensaya y recuerda.** Copia de producción → prueba → registro de la experiencia → producción sin sorpresas.
8. **Pregunta al humano lo que el sistema no sabe.** El dato que falta no se inventa: se solicita.
9. **Diseña el rollback.** Antes de tocar nada, sabe cómo volver.
10. **Desconfía del atajo.** "Saltarse el paso" no acelera: traslada el coste a producción.

---

## 6. Frases que delatan cada lado

**Mentalidad "saltarse el paso":**
- "Que la IA lo haga todo."
- "Eso en un fin de semana lo tienes."
- "Pruébalo directamente en producción, total es una copia… ¿no?"
- "Los detalles ya los afinamos luego."

**Mentalidad con experiencia:**
- "¿Qué información necesito conocer antes de validar esto?"
- "Esto ya lo resuelve la plataforma, no lo reimplementes."
- "El origen no se toca."
- "¿Cómo sé que funcionó? Enséñame la evidencia."
- "¿Quién decide esto, el código o el modelo? ¿Y quién lo aprueba?"
- "No ejecutes nada en el cliente todavía."

---

## 7. Matices que hacen el post honesto (y evitan el discurso vacío)

- **No es "IA sí o no".** El agente fue enormemente productivo: portó módulos enteros en horas.
  El punto es **quién dirige**.
- **El agente también acierta.** Encontró por sí mismo un error real en una herramienta y propuso la corrección.
- **La experiencia no es frenar, es dirigir.** Poner límites desde el principio acelera: evita rehacer.
- **El arnés importa.** Elegir una base con loop, memoria, permisos, subagentes y skills ahorra meses;
  el criterio es *saber elegirla* y *saber usarla*.
- **La seguridad se encapsula, no se confía.** El sistema rechaza por defecto y pide permiso para actuar.

---

## 8. Estructura sugerida para el post

1. **Gancho (1-2 líneas).** El mismo agente, dos resultados opuestos. O una frase de las de la tabla.
2. **Contexto en 2 frases.** Proyecto real anonimizado; sin tecnicismos innecesarios.
3. **La tabla "el agente hizo / el experto corrigió".** Es lo más compartible.
4. **El patrón.** "Plausible en segundos; correcto solo con criterio."
5. **El checklist de 5 puntos** (versión corta del apartado 5).
6. **Cierre + pregunta.** "¿Cuál es la corrección que más te ha ahorrado un desastre?"
7. **Hashtags:** #IA #IngenieríaDeSoftware #Experiencia #Automatización #Criterio

**Frases-gancho candidatas (elegir una):**
- "El mismo agente puede construirte un producto o un desastre. La diferencia no es el prompt: es la experiencia."
- "La IA no sustituye al que sabe. Hace que se note más al que no."
- "Un agente te da algo plausible en segundos. Solo la experiencia distingue lo correcto de lo plausible."
- "No puedes saltarte el paso. Puedes hacer que alguien con experiencia te lo acelere."

---

## 9. Recursos que reforzaron el mensaje (para enlazar o citar)

- Documentación oficial del producto migrado (matriz de rutas de upgrade, cambios de esquema).
- El concepto de **manifiesto de checksums** como evidencia de integridad.
- El patrón **ensayo en copia → producción**, con detección de desvío.
- El principio **fail-closed**: ante la duda, el sistema rechaza.

---

## 10. Aviso antes de publicar

- **Anonimizar** cualquier detalle (cliente, sector, números exactos, rutas).
- **No afirmar** que "la IA falla": afirmar que **la IA sin criterio** falla.
- Mantener el tono **humilde y concreto**: se cuenta una experiencia, no se da una lección.
- Revisar que ninguna captura o código incluya datos de cliente.
