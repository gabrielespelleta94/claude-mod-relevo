# relevo

Mod de Claude Code que hace que el chat principal delegue trabajo en modelos más baratos y conecta entre sí los chats abiertos en la máquina.

- **Política de delegación** en el system prompt: decisión antes de la primera llamada, tabla de disparadores con modelo y `effort` (haiku para buscar e inventariar, sonnet para implementar lo ya especificado, opus para revisión crítica, fable para el tono) y excepciones que hay que citar cuando se usan (`⟲ Hago yo (E#: motivo)`).
- **Recordatorios**: un aviso al empezar cada turno y otro a la 3.ª llamada de exploración sin delegar; también con lecturas de más de 300 líneas y escrituras de código de más de 40.
- **Panel** `/relevo` (alias `/agentes`): agentes y delegaciones en curso, tokens por modelo y métricas de delegación de la sesión.
- **Herramientas** para el modelo: `consultar` (una pregunta a otro modelo, sin herramientas), `delegar` / `resultado` (subagente en segundo plano), `chats` / `enviar` (mensajes entre chats abiertos).

## Instalación

En un terminal con Claude Code:

```
/plugin install relevo --marketplace gabrielespelleta94/claude-mod-relevo
```

Desde la shell:

```bash
claude plugin install relevo --marketplace gabrielespelleta94/claude-mod-relevo
```

En la app de escritorio: botón + junto al cuadro de texto → Plugins → Add marketplace con `gabrielespelleta94/claude-mod-relevo` → Add plugin.

## Desarrollo

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
