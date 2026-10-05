# Guía de uso de PlanSwap

[English](user-guide.md) · [简体中文](user-guide.zh-cn.md) · [繁體中文](user-guide.zh-tw.md) · **Español** · [日本語](user-guide.ja.md)

PlanSwap te permite mantener varias cuentas de Claude Code y Codex con la sesión iniciada y elegir cuál usa tu editor. Esta guía recorre los controles de la barra lateral, la configuración de cuentas, el cambio de cuenta, los límites de uso y el mantenimiento diario. Claude y Codex se gestionan por separado: cambiar uno no cambia el otro.

Los nombres de botones de esta guía son los de la interfaz en español. Pasa el puntero sobre un icono para ver su nombre. El icono del libro en el pie, en la parte inferior del panel, abre esta guía.

## Contenido

- [Antes de empezar](#antes-de-empezar)
- [Orientarte en la barra lateral](#orientarte-en-la-barra-lateral)
- [Añadir una cuenta e iniciar sesión](#añadir-una-cuenta-e-iniciar-sesión)
- [Cambiar de cuenta de Claude](#cambiar-de-cuenta-de-claude)
- [Activar y cambiar cuentas de Codex](#activar-y-cambiar-cuentas-de-codex)
- [Elegir cuentas vinculadas o independientes](#elegir-cuentas-vinculadas-o-independientes)
- [Consultar y actualizar los límites de uso](#consultar-y-actualizar-los-límites-de-uso)
- [Renombrar o quitar cuentas](#renombrar-o-quitar-cuentas)
- [Usar las herramientas](#usar-las-herramientas)
- [Cambiar el idioma y los ajustes de visualización](#cambiar-el-idioma-y-los-ajustes-de-visualización)
- [Solucionar problemas comunes](#solucionar-problemas-comunes)
- [Desactivar el cambio de cuenta o desinstalar](#desactivar-el-cambio-de-cuenta-o-desinstalar)

## Antes de empezar

Necesitas:

- Un editor compatible con VS Code 1.107+ (VS Code, Antigravity IDE o VSCodium). PlanSwap funciona en una ventana remota de WSL, en Windows nativo, en un escritorio Linux local o en otra ventana remota. macOS no es compatible.
- PlanSwap y la extensión oficial de Claude Code o de Codex (o ambas) instaladas donde se ejecuta esa ventana.
- El comando `claude` y/o `codex` en el PATH de ese entorno para iniciar sesión desde el terminal. Si el comando no está disponible, las consultas de uso también pueden utilizar la CLI incluida en la extensión oficial correspondiente.
- Para cambiar de cuenta de Codex fuera de Windows nativo: Bash como shell de inicio de sesión.

Consulta las [instrucciones de instalación](../README.md#install) y los [editores compatibles](../README.md#supported-editors) para la configuración y el grado de prueba de cada editor.

## Orientarte en la barra lateral

Haz clic en **PlanSwap** en la barra de actividad y elige la pestaña **Claude** o **Codex**.

- **Cuenta predeterminada:** tu configuración existente, normalmente `~/.claude` o `~/.codex`. En Windows, `~` es tu perfil de usuario de Windows; en WSL, tu directorio personal dentro de esa distribución. Si el editor ya define `CLAUDE_CONFIG_DIR`, el directorio predeterminado de Claude lo sigue.
- **Cuentas con nombre:** cuentas como `work` o `personal`, cada una en su propio directorio, por ejemplo `~/.claude-work` o `~/.codex-work`.
- **Directorio externo:** un directorio que el editor está usando y que no está en la lista de cuentas de PlanSwap. No se puede renombrar ni quitar en PlanSwap.
- **Primera fila resaltada:** la cuenta actual. En Codex es la cuenta en vigor en esta ventana, que puede ser distinta de una cuenta que seleccionaste y que espera un reinicio.
- **Insignia de enlace:** una cuenta vinculada, que usa los ajustes, reglas, Skills, historial y sesiones de la cuenta predeterminada. Su inicio de sesión sigue siendo independiente.

Términos usados en esta guía:

- *Iniciar sesión* y el botón **Acceder** significan lo mismo; una fila sin sesión iniciada muestra **Sin sesión**.
- *Vinculada* es el modo que la interfaz indica con la insignia de enlace. El comando **Compartir con la cuenta predeterminada** convierte una cuenta independiente en vinculada.
- En Codex, la cuenta *efectiva* es la que usa esta ventana ahora; la cuenta *seleccionada* es la que usará después del próximo reinicio.

Cada tarjeta muestra el nombre visible de la cuenta y su estado de sesión, además de su correo, plan y límites de uso cuando se conocen. Pasa el puntero sobre el avatar para ver su directorio.

Hay dos tipos de botones de actualizar:

- El botón de actualizar de la barra de título del panel vuelve a examinar ambas listas de cuentas y recarga la información de sesión.
- Los iconos junto a **Todas las cuentas** consultan los límites de uso. Consulta [Consultar y actualizar los límites de uso](#consultar-y-actualizar-los-límites-de-uso).

El pie, en la parte inferior del panel, sigue visible en ambas pestañas. Sus botones muestran las versiones, abren esta guía, recargan la ventana, reinician el Extension Host y abren el repositorio de GitHub. Debajo aparece la versión de PlanSwap instalada.

## Añadir una cuenta e iniciar sesión

En Codex, [activa el cambio de cuenta](#activar-y-cambiar-cuentas-de-codex) primero.

1. En la pestaña correspondiente, haz clic en **+ Añadir** junto a **Todas las cuentas**.
2. Escribe un nombre, como `work`. Reglas para los nombres:
   - Usa letras, dígitos, guiones bajos o guiones.
   - `default` está reservado.
   - Un nombre no puede coincidir, sin distinguir mayúsculas y minúsculas, con el nombre o el nombre visible de otra cuenta de la misma pestaña.
3. Deja marcada la casilla **Vincular ajustes e historial a la cuenta predeterminada** para compartir tu configuración existente, o desmárcala para empezar con una copia independiente de la configuración predeterminada. Lee los [modos de cuenta](#elegir-cuentas-vinculadas-o-independientes) antes de elegir.
4. Haz clic en **Añadir** o pulsa Enter. PlanSwap crea el directorio de la cuenta, o reutiliza un directorio existente con ese nombre. Si informa de archivos que no pudo vincular o copiar, lee la lista: esos archivos se quedan como están.
5. Haz clic en **Acceder** en la nueva fila. Se abre un terminal; completa allí la configuración inicial y el inicio de sesión del cliente oficial. En Claude también puedes cambiar a la cuenta e iniciar sesión desde el panel de Claude Code.
6. Si la fila sigue mostrando **Sin sesión**, haz clic en el botón de actualizar de la barra de título del panel. Cerrar el terminal de PlanSwap también actualiza la lista.

Añadir una cuenta o iniciar sesión en ella no hace que el editor la use; cambia a ella cuando estés listo. Tus otras cuentas siguen con la sesión iniciada, así que no hace falta cerrar sesión en ellas antes. Cerrar sesión en un terminal termina la sesión de esa cuenta concreta.

En una cuenta con sesión iniciada, el icono de terminal abre la CLI oficial con la cuenta de esa fila, sin cambiar la cuenta del editor. Las pestañas de terminal se llaman `Claude (<label>)` o `Codex (<label>)`.

## Cambiar de cuenta de Claude

1. Haz clic en el icono de flecha **Cambiar a esta cuenta** de una fila que no sea la actual. También puedes hacer doble clic en la tarjeta, o enfocarla con Tab y pulsar Enter.
2. Confirma con **Cambiar**. Las sesiones nuevas de Claude usan la cuenta seleccionada. Con `planswap.claude.confirmSwitch` desactivado, el cambio se hace sin este cuadro de diálogo.
3. Haz clic en **Recargar ventana** en el aviso para pasar los paneles de Claude abiertos a la nueva cuenta. Las sesiones existentes conservan la cuenta anterior hasta que recargues.

El comando **Cuenta de Claude: Cambiar de cuenta** (Claude Account: Switch Account) de la paleta de comandos muestra un selector de cuentas y cambia sin el diálogo de confirmación.

Cambiar de cuenta modifica un ajuste del editor compartido por las demás ventanas del mismo equipo, así que esas ventanas también cambian. Recarga cada ventana cuyas sesiones de Claude abiertas deban usar la nueva cuenta.

## Activar y cambiar cuentas de Codex

### Activar una vez

Abre la pestaña **Codex** y haz clic en **Activar cambio de cuenta de Codex**. Revisa y confirma los cambios que propone:

- **WSL, Linux local y otras ventanas remotas:** PlanSwap añade bloques delimitados a `~/.profile` y `~/.bashrc` y comprueba que un shell de inicio de sesión de Bash recoge la cuenta seleccionada. Si informa de una asignación de `CODEX_HOME` o una configuración de shell en conflicto, corrige lo que indica y vuelve a intentarlo.
- **Windows nativo:** PlanSwap gestiona tu variable de entorno de usuario `CODEX_HOME`. Si tú mismo definiste `CODEX_HOME` con otro valor, se rechaza la activación. Si ya apunta a un directorio de cuenta de PlanSwap (`~/.codex-<name>`), PlanSwap pasa a gestionarla.

Si la extensión de Codex de Windows está configurada para ejecutarse dentro de WSL, gestiona sus cuentas desde una ventana de WSL, o desactiva `chatgpt.runCodexInWindowsSubsystemForLinux` antes de gestionar cuentas de Windows.

### Seleccionar una cuenta y aplicarla

1. Añade la cuenta que quieras e inicia sesión en ella.
2. Guarda tu trabajo y haz clic en su icono de flecha **Cambiar a esta cuenta**.
3. Lee la confirmación y sigue las instrucciones de reinicio para tu editor.

| Entorno | Cómo se aplica la selección |
| --- | --- |
| Antigravity o VSCodium en WSL | Confirma con **Cambiar y reiniciar**. PlanSwap reinicia el servidor WSL del editor; haz clic en **Recargar ventana** en cada ventana desconectada. Si el reinicio automático no es posible, sigue las instrucciones manuales que se muestran. |
| VS Code en WSL | Confirma con **Guardar selección**. Cierra todas las ventanas de VS Code conectadas a esa distribución, espera unos segundos y vuelve a abrirlas. |
| Otros editores en WSL | Confirma con **Guardar selección** y sigue las instrucciones de reinicio manual del diálogo. |
| Windows nativo | Confirma con **Guardar selección**, cierra por completo el editor y vuelve a abrirlo desde el menú Inicio o la barra de tareas. Un terminal abierto antes del cambio sigue teniendo la cuenta anterior. |
| Linux local u otra ventana remota | Confirma con **Guardar selección**. Después sigue el diálogo: reinicia el editor, o el servidor remoto, para que arranque con el `CODEX_HOME` seleccionado. |

Reiniciar un servidor WSL desconecta sus ventanas del editor y cierra sus terminales integrados y sesiones de CLI. **Recargar ventana** o **Reiniciar Extension Host** por sí solos no aplican una selección de cuenta de Codex.

Hasta que se complete el reinicio, un aviso indica la cuenta seleccionada, y la fila resaltada sigue siendo la cuenta en vigor en esta ventana. Para volver a ver los pasos de reinicio, ejecuta **Aplicar cuenta de Codex: reiniciar o ver instrucciones** (Apply Codex Account: Restart or Show Instructions) desde la paleta de comandos (en la categoría **Cuenta de Codex**).

¿Cambiaste de idea antes de reiniciar? Haz clic en el icono de flecha de la fila resaltada (efectiva). Esto cancela la selección pendiente; no hace falta reiniciar.

## Elegir cuentas vinculadas o independientes

| Contenido | Cuenta vinculada | Cuenta independiente |
| --- | --- | --- |
| Ajustes, reglas y Skills | Usa los de la cuenta predeterminada | Empieza con una copia; los cambios posteriores son independientes |
| Historial de prompts y sesiones | Usa los de la cuenta predeterminada | Tiene los suyos |
| Inicio de sesión | Independiente | Independiente |
| Memories de Codex | Independientes | Independientes |
| Bases de datos de conversaciones de Codex | Compartidas en WSL y en Linux; independientes en Windows nativo | Independientes |

Vincular no garantiza que otra cuenta pueda reanudar una sesión, sobre todo entre organizaciones de ChatGPT distintas. No abras la misma sesión desde dos cuentas a la vez.

Algunos ajustes nunca se vinculan: un archivo de ajustes que contiene su propia configuración de inicio de sesión o de proveedor (por ejemplo, un asistente de clave de API o un proveedor de modelos personalizado) sigue siendo independiente. El mensaje de resultado nombra esos archivos.

En las cuentas de Claude vinculadas, PlanSwap también copia en la cuenta los servidores MCP de la cuenta predeterminada y sus ajustes de confianza por proyecto. Cuando la cuenta tiene la sesión iniciada, también copia el estado de configuración inicial de la cuenta predeterminada, para que Claude Code no repita su configuración inicial.

### Cambiar el modo de una cuenta existente

Antes de convertir una cuenta:

1. Cambia a otra cuenta. En Codex, completa el reinicio para que la cuenta no sea ni la efectiva ni la seleccionada.
2. Cierra sus sesiones y sus pestañas de terminal de PlanSwap.

Después:

- **Vincular a la cuenta predeterminada:** haz clic en el icono de enlace de una fila con nombre independiente, o ejecuta el comando **Compartir con la cuenta predeterminada** del producto. Los ajustes y el historial propios de la cuenta se mueven a la cuenta predeterminada. Los archivos que difieren de los de la cuenta predeterminada se conservan uno junto al otro para que los fusiones a mano, y el resultado los enumera.
- **Desvincular de la cuenta predeterminada:** haz clic en el icono de desconexión de una fila con nombre vinculada. La cuenta recibe su propia copia de la configuración predeterminada y conserva su inicio de sesión y los archivos que no estaban vinculados. El historial y las sesiones permanecen en la cuenta predeterminada y no se copian de vuelta. Desvincular no deshace la fusión hecha al vincular la cuenta.
- **Revincular:** haz clic en **Revincular** en **Herramientas** después de cambiar la configuración de la cuenta predeterminada, o cuando haya que reparar enlaces. Revisa todas las cuentas vinculadas de esa pestaña y enumera lo que requiera atención. En Claude también actualiza sus servidores MCP a partir de la cuenta predeterminada.

### Vincular en Windows

- Los directorios vinculados usan uniones de directorio (junctions), que funcionan sin permisos adicionales.
- Vincular archivos sueltos requiere el Modo de desarrollador de Windows o ejecutar el editor como administrador. Sin ello, PlanSwap ofrece copiar una vez los archivos de configuración pequeños; los cambios posteriores en esas copias son independientes.
- Para vincularlos correctamente más adelante, elige **Abrir configuración para desarrolladores**, activa el Modo de desarrollador y haz clic en **Revincular**. Crea los enlaces que faltan y convierte en enlaces las copias sin cambios.
- Si el terminal de PlanSwap de la cuenta se abre mientras PlanSwap pregunta por la copia, la conversión se detiene sin cambiar nada. Cierra el terminal y vuelve a intentarlo.
- Las bases de datos de hilos de Codex (`*.sqlite`) nunca se vinculan en Windows, porque allí SQLite puede perder datos escritos a través de un enlace. Cada cuenta conserva las suyas, mientras que las sesiones, el historial y la configuración se siguen compartiendo.
- En Windows, PlanSwap no puede saber a qué cuenta pertenece un proceso de Claude o Codex en ejecución. Cierra las sesiones de la cuenta y sus pestañas de terminal de PlanSwap antes de vincularla, desvincularla o quitarla, aunque la CLI ya haya terminado.

## Consultar y actualizar los límites de uso

Las barras de uso y los porcentajes muestran lo que **queda**; pon `planswap.usageDisplay` en `used` en los [ajustes](#cambiar-el-idioma-y-los-ajustes-de-visualización) para que muestren lo que se ha usado. La duración junto a cada límite, como `2d 5h`, es el tiempo hasta que se restablece. Pasa el puntero sobre una barra para ver ambos valores, por ejemplo `97% restante (3% usado)`. Una barra se vuelve amarilla cuando queda un 30 % o menos y roja con un 10 % o menos, también cuando muestra lo usado; puedes cambiar estos niveles con `planswap.sidebar.warningThreshold` y `planswap.sidebar.errorThreshold`. Un límite agotado muestra su porcentaje y su hora de restablecimiento en rojo. Si no hay línea de uso, es que aún no hay datos, no que el uso sea cero ni que la cuota sea ilimitada.

Las consultas de uso requieren un inicio de sesión con suscripción de Claude, o un inicio de sesión de ChatGPT en Codex (no el modo de clave de API). Ejecutan la CLI oficial.

### Actualizar desde la barra lateral

Los iconos junto a **Todas las cuentas**:

- **Actualizar los límites de uso de la cuenta actual** (icono de actualizar): consulta la cuenta actual de Claude, o la cuenta efectiva de Codex. Se muestra cuando esa cuenta se puede consultar.
- **Actualizar los límites de uso de todas las cuentas** (icono de capas apiladas): consulta, una por una, todas las cuentas con sesión iniciada de esa pestaña, para que puedas compararlas antes de cambiar. Cada fila se actualiza en cuanto termina su consulta. Nunca cambia de cuenta, y puedes cancelarlo en la notificación de progreso. Se muestra cuando al menos una cuenta de la lista se puede consultar.

En la pestaña Codex no aparece ninguno de los dos iconos mientras el cambio de cuenta de Codex está desactivado, ni en Windows mientras Codex se ejecuta dentro de WSL.

La paleta de comandos ofrece las mismas acciones: **Actualizar límites de uso de Claude**, **Actualizar límites de uso de todas las cuentas de Claude**, **Actualizar límites de uso de Codex** y **Actualizar límites de uso de todas las cuentas de Codex**.

Una cuenta consultada hace menos de un minuto no se vuelve a consultar. En ese caso, una actualización manual muestra «Los límites de uso se consultaron hace menos de un minuto; vuelve a intentarlo en N s.». Cuenta cualquier consulta, incluidas las automáticas; en Claude, también una hecha en otra ventana o en un terminal. La actualización de todas las cuentas omite esas cuentas e indica cuántas omitió.

### Consultas automáticas

De forma predeterminada, PlanSwap consulta automáticamente todas las cuentas con sesión iniciada de cada producto, primero la actual y después las demás de una en una: unos 20 segundos después de abrir la ventana y luego aproximadamente cada 15 minutos mientras la ventana tiene el foco. Para consultar solo las cuentas actuales, activa `planswap.usageAutoRefreshCurrentOnly`. También puedes cambiar el intervalo o desactivar las consultas automáticas en los [ajustes](#cambiar-el-idioma-y-los-ajustes-de-visualización).

Las demás filas muestran el resultado de su última consulta. Los valores desaparecen tras su hora de restablecimiento o pasadas 24 horas, y se ocultan si la cuenta ha vuelto a iniciar sesión desde entonces.

### Cuenta recomendada

Cuando el límite general más bajo de la cuenta actual llega al nivel amarillo, una tarjeta verde encima de la lista recomienda otra cuenta con sesión iniciada de la misma pestaña: la que más tiene en su límite más bajo, siempre que le quede más que a la cuenta actual y ninguno de sus límites esté agotado. La tarjeta muestra los límites de esa cuenta y cuánto hace que se consultaron, con los botones **Cambiar** y **Terminal**, que hacen lo mismo que los botones de la tarjeta de esa cuenta (Claude: sigue la confirmación habitual; Codex: se selecciona la cuenta y sigue el reinicio del servidor del editor). Los límites por modelo no se comparan, y la tarjeta nunca consulta nada por sí misma: sus cifras son tan recientes como la última consulta de esa cuenta.

Para dejar una cuenta fuera de las recomendaciones, por ejemplo una cuenta de trabajo, pulsa el icono de bombilla en su tarjeta; púlsalo de nuevo para incluirla. Desactiva `planswap.sidebar.showRecommendation` en los [ajustes](#cambiar-el-idioma-y-los-ajustes-de-visualización) para ocultar la tarjeta y los iconos de bombilla.

### Barra de estado

La barra de estado muestra el límite corto de cada producto, por ejemplo `Claude 97% · Codex 82%`: lo que queda, o lo que se ha usado cuando `planswap.usageDisplay` está en `used`. Cuando el que se está agotando es un límite más largo, el elemento muestra ese límite con su duración, por ejemplo `Claude 2% (7 d)`, porque esa cifra tarda días en recuperarse. Su fondo cambia al color de advertencia del tema cuando algún límite general, incluidos los más largos, está al 30 % o menos, y al color de error al 10 % o menos. Puedes cambiar estos umbrales, mostrar un solo producto, mover el elemento a la izquierda u ocultarlo ([Cambiar el idioma y los ajustes de visualización](#cambiar-el-idioma-y-los-ajustes-de-visualización)).

Pasa el puntero sobre ella para ver una tabla con una fila de encabezado por producto (correo, plan y, cuando la cuenta se puede consultar, un icono de actualizar) y una fila por límite general. Haz clic en ella para abrir PlanSwap.

## Renombrar o quitar cuentas

### Cambiar un nombre visible

Pasa el puntero sobre una cuenta con nombre, o enfócala, y haz clic en el lápiz junto a su nombre. Escribe un nombre visible y pulsa Enter, haz clic en la marca de verificación o haz clic fuera para guardar; Escape cancela.

Un nombre visible puede contener espacios, tener hasta 32 caracteres y no puede coincidir con el nombre o el nombre visible de otra cuenta de esa pestaña. Renombrar no cambia el directorio ni el inicio de sesión. Las filas predeterminada y externa no se pueden renombrar.

### Quitar una cuenta

1. Primero cambia a otra cuenta. En Codex, completa el reinicio para que la cuenta no sea ni la efectiva ni la seleccionada. Cierra las sesiones y terminales de esa cuenta.
2. Haz clic en el icono de la papelera y confirma con **Quitar** en la fila, o usa el comando de eliminar del producto en la paleta de comandos.
3. Un segundo diálogo pregunta si también quieres eliminar el directorio de la cuenta.

Si conservas el directorio, solo se quitan la entrada de la lista y su nombre visible. PlanSwap deja de detectar la cuenta hasta que vuelvas a añadir el mismo nombre.

Si eliminas el directorio, su inicio de sesión y todo lo guardado en él se eliminan de forma permanente:

- En una cuenta vinculada, los datos de la cuenta predeterminada se conservan; se eliminan el inicio de sesión propio de la cuenta, sus copias de seguridad y los demás archivos que no estaban vinculados. En Codex esto incluye las Memories de la cuenta.
- Si PlanSwap se niega porque la cuenta está en uso, cierra las sesiones o procesos que indica y vuelve a intentarlo.

Los directorios de cuenta con nombres válidos que PlanSwap encuentra en tu directorio personal se añaden automáticamente a la lista al iniciarse o al actualizar.

## Usar las herramientas

**Herramientas**, debajo de la lista de cuentas, reúne las acciones propias de esa pestaña:

| Herramienta | Acción |
| --- | --- |
| `CLAUDE.md` o `AGENTS.md` | Abre el archivo de reglas de la cuenta actual de Claude o de la cuenta efectiva de Codex. Si el archivo no existe, pregunta antes de crearlo. |
| Ajustes de Claude o Ajustes de Codex | Abre los ajustes de la extensión oficial de Claude Code o de Codex (los ajustes de PlanSwap están en el engranaje de la barra de título del panel). |
| Actualizar CLI | Abre un terminal que ejecuta el comando de actualización del producto. Sigue allí el progreso y las preguntas que aparezcan; si instalaste la CLI de otra forma, puede que tengas que actualizarla de esa forma. |
| Revincular | Repara los enlaces de las cuentas vinculadas de esta pestaña (en Claude también actualiza sus servidores MCP). Solo se muestra si existe una cuenta vinculada. |

El pie ofrece:

| Botón | Acción |
| --- | --- |
| Ver versiones de CLI y extensiones | Muestra u oculta una tarjeta con ambas CLI y ambas extensiones oficiales. Lo que no esté instalado muestra **No encontrado**. |
| Guía de uso | Abre esta guía en GitHub. |
| Recargar ventana | Recarga la ventana actual de inmediato, sin preguntar. |
| Reiniciar Extension Host | Reinicia el Extension Host de inmediato, sin preguntar. |
| Star | Abre el repositorio de PlanSwap en GitHub. |

Para obtener un informe de diagnóstico, ejecuta **PlanSwap: Vista previa del informe de diagnóstico** (PlanSwap: Preview Diagnostics Report) desde la paleta de comandos. Léelo y elige **Copiar informe** si quieres compartirlo. El informe se refiere a las cuentas por número y omite nombres de cuenta, correos, directorios y credenciales. No se sube nada automáticamente.

## Cambiar el idioma y los ajustes de visualización

Haz clic en el icono de ajustes de la barra de título del panel, o ejecuta **PlanSwap: Abrir ajustes de PlanSwap**. El editor de configuración los agrupa en General, Barra lateral, Barra de estado, Claude y Codex; la tabla sigue ese orden. Para encontrar un ajuste, escribe su nombre de la tabla en el cuadro de búsqueda de la configuración. Los cambios se aplican al instante:

| Ajuste | Predeterminado | Función |
| --- | --- | --- |
| `planswap.language` | `auto` | Seguir el editor, o elegir `en`, `zh-cn`, `zh-tw`, `es` o `ja`. |
| `planswap.usageDisplay` | `remaining` | Las barras y los porcentajes de uso, en la barra lateral y la barra de estado, muestran lo que queda (`remaining`) o lo que se ha usado (`used`). Los colores siempre se basan en lo que queda. |
| `planswap.usageAutoRefreshCurrentOnly` | `false` | Las consultas automáticas solo consultan las cuentas actuales de Claude y Codex. |
| `planswap.usageCheckIntervalSeconds` | `120` | Segundos entre cada búsqueda de cuentas pendientes de una consulta automática, 30–600. Cada cuenta se sigue consultando según el intervalo de actualización de su producto. |
| `planswap.sidebar.showEmail` | `true` | Mostrar el correo de las cuentas en las tarjetas de la barra lateral. |
| `planswap.sidebar.showFiveHourLimit` | `true` | Mostrar el límite de 5 horas en las tarjetas. |
| `planswap.sidebar.showWeeklyLimit` | `true` | Mostrar el límite de 7 días en las tarjetas. |
| `planswap.sidebar.showModelLimits` | `false` | Añadir a las tarjetas los límites de Claude por modelo. |
| `planswap.sidebar.warningThreshold` | `30` | Las barras de las tarjetas usan el color de advertencia con este porcentaje restante o menos, 0–100. |
| `planswap.sidebar.errorThreshold` | `10` | Las barras de las tarjetas usan el color de error con este porcentaje restante o menos, 0–100. Tiene prioridad sobre el color de advertencia. |
| `planswap.sidebar.showRecommendation` | `true` | Mostrar la tarjeta de [cuenta recomendada](#cuenta-recomendada) y los iconos de bombilla en las tarjetas. |
| `planswap.statusBar.enabled` | `true` | Mostrar el elemento de PlanSwap en la barra de estado. |
| `planswap.statusBar.products` | `both` | Productos del elemento de la barra de estado: `both`, `claude` o `codex`. |
| `planswap.statusBar.warningThreshold` | `30` | Color de advertencia con este porcentaje restante o menos, 0–100. |
| `planswap.statusBar.errorThreshold` | `10` | Color de error con este porcentaje restante o menos, 0–100. Tiene prioridad sobre el color de advertencia. |
| `planswap.statusBar.alignment` | `right` | Lado de la barra de estado: `left` o `right`. |
| `planswap.claude.confirmSwitch` | `true` | Pedir confirmación antes de cambiar de cuenta de Claude desde la barra lateral. El cambio de Codex siempre la pide. Si está desactivado, el doble clic o Enter en una fila con el foco cambia de inmediato. |
| `planswap.claude.usageAutoRefresh` | `true` | Consultar automáticamente los límites de uso de Claude. |
| `planswap.claude.usageRefreshMinutes` | `15` | Minutos entre consultas automáticas de Claude, 10–1440. |
| `planswap.claude.usageTimeoutSeconds` | `30` | Segundos que puede durar una consulta de Claude antes de agotar el tiempo, 10–120. |
| `planswap.codex.usageAutoRefresh` | `true` | Consultar automáticamente los límites de uso de Codex. |
| `planswap.codex.usageRefreshMinutes` | `15` | Minutos entre consultas automáticas de Codex, 5–1440. |
| `planswap.codex.usageTimeoutSeconds` | `15` | Segundos que puede durar una consulta de Codex antes de agotar el tiempo, 5–120. |

Con las consultas automáticas desactivadas, los iconos y comandos de actualizar siguen funcionando. Los ajustes de visualización de la barra lateral no cambian la barra de estado. Los títulos de la paleta de comandos y el nombre de la barra lateral siguen el idioma de visualización del editor, no `planswap.language`.

## Solucionar problemas comunes

| Lo que ves | Qué comprobar |
| --- | --- |
| Claude sigue usando la cuenta anterior | Recarga la ventana para pasar los paneles de Claude abiertos a la nueva cuenta. Comprueba si hay un aviso de PlanSwap de que credenciales del entorno o ajustes de proveedor sustituyen el inicio de sesión de la cuenta. |
| Codex muestra una selección pendiente | Completa el reinicio correspondiente a tu entorno. Recargar la ventana no sustituye reiniciar el editor ni el servidor WSL. |
| No se puede activar el cambio de cuenta de Codex | Lee el conflicto de shell o de `CODEX_HOME` indicado. En Windows, comprueba si Codex está configurado para ejecutarse dentro de WSL. |
| Una cuenta sigue mostrando **Sin sesión** | Inicia sesión con el botón **Acceder** de esa fila y actualiza. Un inicio de sesión de Codex guardado solo en el llavero del sistema operativo no se puede detectar, porque PlanSwap busca el `auth.json` de la cuenta. |
| Dos cuentas generan un aviso de inicio de sesión duplicado | Ambas tienen la sesión iniciada con la misma cuenta y espacio de trabajo, así que cambiar entre ellas no te da límites separados. Inicia sesión con la identidad que corresponda en una de ellas. |
| No hay barras de uso, o una consulta falló | Comprueba que la cuenta tiene un inicio de sesión con suscripción (Claude) o de ChatGPT (Codex) y que el comando `claude` está instalado (Claude). Actualiza a mano y lee el mensaje de error; si indica un tiempo de espera, espera antes de reintentar. Si dice que la CLI no respondió a tiempo, aumenta `planswap.claude.usageTimeoutSeconds` o `planswap.codex.usageTimeoutSeconds`. |
| Los ajustes o el historial no se comparten como esperabas | Revisa la insignia de enlace y el resultado de la conversión o de Revincular. Algunos archivos siguen siendo independientes o requieren fusión manual; en Windows, comprueba si los enlaces de archivo están disponibles. |
| Una lista parece desactualizada | Haz clic en el botón de actualizar de la barra de título del panel. Los cambios hechos en otra ventana aparecen tras actualizar. |

### Inicios de sesión que se aplican a todas las cuentas

Estos tienen prioridad sobre el inicio de sesión propio de cada cuenta, así que cambiar de cuenta de Claude no tiene efecto mientras haya uno definido. PlanSwap avisa cuando encuentra uno en el entorno:

- una clave de API, un token de autenticación o un token OAuth de larga duración: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`;
- un perfil de Anthropic con nombre (`ANTHROPIC_PROFILE`) o las variables de federación (`ANTHROPIC_FEDERATION_RULE_ID` con `ANTHROPIC_ORGANIZATION_ID`);
- un ajuste de proveedor en la nube: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`.

Un inicio de sesión de Claude Console sin clave de API se guarda fuera de los directorios de las cuentas (`~/.config/anthropic`, en Windows `%APPDATA%\Anthropic`) y cierra todas las sesiones de claude.ai del equipo, así que no se puede mantener por cuenta ([autenticación de Claude Code](https://code.claude.com/docs/en/authentication#sign-in-without-an-api-key)).

### OneDrive en Windows

PlanSwap avisa cuando tu carpeta de usuario se sincroniza con OneDrive. Se sabe que la sincronización de OneDrive daña el `.claude.json` de Claude Code, y todos los directorios de cuentas están dentro de esa carpeta.

Para otras limitaciones, como continuar la sesión de otra cuenta, consulta las [limitaciones conocidas](../README.md#known-limitations). Consulta la [privacidad](privacy.md) para saber qué lee, guarda y envía PlanSwap.

## Desactivar el cambio de cuenta o desinstalar

1. Vuelve a cambiar Claude a `default` y recarga la ventana.
2. Si el cambio de cuenta de Codex está activado, ejecuta **Desactivar el cambio de cuentas de Codex** (Disable Codex Account Switching; en **Cuenta de Codex** en la paleta de comandos) y confirma. Esto quita los bloques de shell de PlanSwap (o, en Windows, su `CODEX_HOME` de usuario) y borra la selección. Las ventanas abiertas conservan la cuenta anterior hasta que las reinicies como se describe en [Seleccionar una cuenta y aplicarla](#seleccionar-una-cuenta-y-aplicarla).
3. Si quieres, desinstala PlanSwap desde la vista Extensiones.

Los directorios de las cuentas se conservan. Para borrar también las listas de cuentas, los nombres visibles y los registros de uso guardados por PlanSwap, consulta las [instrucciones de desinstalación](../README.md#uninstall). Esto no toca los archivos propios de las cuentas.
