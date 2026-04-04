# Prompt for new chat

Нужно продолжить root-cause-first дебаг extension `pi-openai-search` в репозитории `~/hobby/pi-openai-search`.

## Контекст

Мы интегрируем native OpenAI Responses `web_search` в `gsd` / `gsd-pi`.

Что уже подтверждено:

1. **Payload injection работает**
   - extension инжектит native tool `{"type":"web_search"}` в provider payload;
   - bundled client-side search tools (`search-the-web`, `search_and_read`, `google_search`) убираются из model-visible payload;
   - в debug snapshot payload видно `toolChoice: auto`, `parallelToolCalls: true`, native `web_search` присутствует.

2. **Upstream/proxy search реально выполняется**
   - прямой streaming к `/v1/responses` показывал `web_search_call` в output items;
   - non-interactive / isolated patched provider умеет превращать это в `serverToolUse` / `webSearchResult`.

3. **Interactive renderer ниже provider-слоя готов**
   - `chat-controller.js` умеет обрабатывать `serverToolUse` / `webSearchResult`;
   - `tool-execution.js` умеет это показывать;
   - `session-manager` не вычищает эти блоки.

4. **Но в реальной interactive session глубинная цепочка всё ещё не работает**
   - в session jsonl assistant message по-прежнему содержит только `thinking` и `text`;
   - `serverToolUse` / `webSearchResult` в финальном assistant message отсутствуют;
   - значит настоящий provider/display path до сих пор не восстановлен.

## Что уже исправлено

Эти изменения уже в `main`:

1. `fix: re-register patched openai-responses provider`
   - убран глобальный `PATCH_FLAG` из `src/openai-responses-display-patch.js`;
   - patched provider можно регистрировать повторно после `resetApiProviders()`.

2. `fix: make debug snapshot writes non-fatal`
   - ошибки записи debug snapshot больше не должны валить `gsd`.

3. `fix: show native web search status in tui`
   - добавлен fallback-показ в TUI на уровне extension:
     - во время запроса: `Native web search in progress...`
     - footer: `web: searching`
     - после ответа: `web: N sources`
   - это **обходной UX-слой**, а не полное восстановление provider-native rendering path.

## Что сейчас работает в TUI

При живом прогоне через `tmux` на `main` видно:

- во время ответа: `Native web search in progress...`
- в footer: `web: searching`
- после ответа: `web: 3 sources`

То есть пользователь теперь видит, что native search реально шёл.

## Что остаётся нерешённым

Главная проблема:

> внутренняя цепочка `web_search_call -> serverToolUse/webSearchResult -> ToolExecutionComponent -> session history` всё ещё не работает в реальной interactive-сессии `gsd`.

Симптомы:

- в TUI нет настоящего tool block от provider-native path;
- в session history нет `serverToolUse` / `webSearchResult`;
- есть только `thinking` + `text`.

Самая вероятная гипотеза:

- в реальном interactive path в момент `streamSimple(model, ...)` используется **не тот provider instance**;
- либо patched provider где-то перетирается/обходится до фактического LLM-вызова.

## Что важно не перепроверять с нуля

Не надо снова долго доказывать, что:

- payload injection работает;
- upstream native search реально выполняется;
- fallback TUI status работает.

Это уже подтверждено.

## Цель нового чата

Нужно локализовать **точку расхождения provider selection** в реальной interactive-сессии.

То есть доказать:

1. какой именно provider object выбирается в момент реального `streamSimple()` / `stream()`;
2. совпадает ли он с patched `openai-responses`;
3. если нет — кто и где возвращает builtin provider вместо patched;
4. предложить минимальный безопасный фикс, который восстановит именно нативный pipeline, а не только fallback UI.

## Предпочтительный план работы

1. Исследовать только узкие места, без шумных команд, чтобы не уронить TUI:
   - `packages/pi-ai/dist/stream.js`
   - `packages/pi-ai/dist/api-registry.js`
   - `packages/pi-ai/dist/providers/register-builtins.js`
   - `packages/pi-coding-agent/dist/core/resource-loader.js`
   - `packages/pi-coding-agent/dist/core/agent-session.js`
   - `packages/pi-coding-agent/dist/main.js`

2. Избегать широких `rg` с большим выводом в TUI.

3. Если нужен runtime proof — делать **очень узкую instrumentation**:
   - логировать identity/shape provider, который реально берёт `streamSimple()`;
   - логировать это в файл в репозитории, а не в `/tmp`, если `/tmp` снова ведёт себя странно.

4. Не ломать уже работающий fallback UX.

## Полезные файлы в репозитории

- `index.js`
- `src/openai-native-search.js`
- `src/openai-responses-display-patch.js`
- `src/openai-search-display.js`
- `tests/openai-native-search.test.mjs`

## Текущее ожидание от результата

Нужно либо:

- восстановить настоящий provider-native показ `serverToolUse` / `webSearchResult` в interactive TUI и session history,

либо:

- точно доказать, почему это невозможно/ломается в текущей архитектуре `gsd-pi`, с указанием конкретной точки расхождения и минимального upstream fix.
