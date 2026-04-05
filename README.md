# pi-openai-search

POC extension для `pi` / `gsd`, который включает нативный `web_search` tool у OpenAI Responses API и старается сохранить truthful UX без synthetic fallback.

Это не Brave, не Tavily и не отдельный поисковый tool. Extension делает то же базовое действие, что и Codex CLI:

- ловит `before_provider_request`
- проверяет, что текущая модель использует один из transport:
  - `openai-responses`
  - `openai-codex-responses`
  - `azure-openai-responses`
- добавляет в provider payload встроенный tool:
  - `type: "web_search"`

## Для твоего случая

Если `pi` использует встроенный provider `openai` с override `baseUrl` на proxy и transport `openai-responses`, extension попадает ровно в нужную точку.

## Что делает

- включает native OpenAI web search только для Responses API
- не трогает `openai-completions`
- убирает из model-visible payload конкурирующие search tools:
  - `search-the-web`
  - `search_and_read`
  - `google_search`
- добавляет `include: ["web_search_call.action.sources"]`
- выставляет `tool_choice = "auto"`, если поле не задано
- выставляет `parallel_tool_calls = true`, если поле не задано
- поддерживает live/cached режим и базовые фильтры через env
- использует `pi.registerProvider("openai", ...)` как основной seam, а глобальный `registerApiProvider()` оставляет только как fallback для старого runtime
- патчит provider `openai-responses` узким compat-слоем так, чтобы финальный assistant message содержал:
  - `serverToolUse` для `web_search_call`
  - `webSearchResult` для завершённого native search
  - добавленные в текст citations, если OpenAI вернул structured annotations, которых ещё нет в тексте
- не подмешивает скрытые developer prompts для управления reasoning
- патчит interactive/replay renderer standalone `pi` и legacy `gsd-pi` через compat-слой: если upstream runtime изменился, extension деградирует в safe fallback без падения на import
- truthful query label обновляется из реального provider payload, если query появляется позже в completed response; если query нет, UI честно показывает нейтральный label без synthetic fallback

## Ограничения POC

Сейчас UX-патч добавлен только для transport `openai-responses`.

То есть для основного кейса с proxy-backed `openai/gpt-5.4` это покрыто, но:

- `openai-codex-responses` пока без аналогичного display patch,
- `azure-openai-responses` пока без аналогичного display patch,
- если upstream не вернёт documented `action.sources` или annotations, extension не выдумает их сам.
- если provider/proxy дополнительно вернёт `results`, extension сможет прочитать их как defensive seam, но milestone closure не опирается на этот недокументированный path.

То есть это уже не только payload injection, а рабочий runtime patch для основного OpenAI Responses сценария, но ещё не полный upstream-quality клон UX Codex.

## Быстрый запуск

```bash
pi --extension ~/hobby/pi-openai-search
```

Разовая live-проверка:

```bash
PI_OPENAI_NATIVE_SEARCH=1 \
PI_OPENAI_NATIVE_SEARCH_MODE=live \
  pi --extension ~/hobby/pi-openai-search --mode text --print --no-session \
  --model openai/gpt-5.4 \
  'Найди свежие заметки про OpenAI Responses API web_search и кратко перескажи с источниками.'
```

## Env-конфиг

### Основные

- `PI_OPENAI_NATIVE_SEARCH=true|false`
  - default: `true`
- `PI_OPENAI_NATIVE_SEARCH_MODE=live|cached|off`
  - default: `live`
- `PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE=low|medium|high`
  - optional

### Доменные фильтры

- `PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS=example.com,docs.example.com`

### Геолокация

- `PI_OPENAI_NATIVE_SEARCH_COUNTRY=US`
- `PI_OPENAI_NATIVE_SEARCH_REGION=CA`
- `PI_OPENAI_NATIVE_SEARCH_CITY=San Francisco`
- `PI_OPENAI_NATIVE_SEARCH_TIMEZONE=America/Los_Angeles`

### Отладка payload

- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json`
  - если задан, extension пишет json-снимок финального provider payload перед отправкой
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json`
  - если задан, extension пишет json-снимок финального assistant message на `message_end`

### Compat-слои

- `PI_BIN_PATH=/abs/path/to/pi`
  - optional
  - приоритетный путь к standalone `pi` binary для compat/runtime autodiscovery
- `GSD_BIN_PATH=/abs/path/to/gsd`
  - optional
  - fallback для legacy `gsd` runtime
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT=true|false`
  - default: `true`
  - включает inline search-order patch для interactive/replay UI
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT=true|false`
  - default: `true`
  - включает truthful formatter для `web_search` в interactive tool execution

## Supported Seams

- `payload layer`: инъекция native `web_search`, include-полей и удаление конфликтующих search tools
- `provider compat layer`: локальный compat-fork для `openai-responses`, который проецирует `web_search_call` в `serverToolUse` / `webSearchResult`
- `interactive compat layer`: optional prototype patch для inline chronological order и truthful label в supported runtime shape

## Safe Degradation

- если compat runtime не найден или upstream shape поменялся, extension не падает на import и остаётся в payload/provider path
- если upstream не отдаёт documented structured sources, `webSearchResult` остаётся truthful sentinel без synthetic citations
- для полной smoke-проверки compat runtime можно запускать:

```bash
GSD_BIN_PATH="$(command -v gsd)" npm test
```

## Глобальное включение в pi

### Рекомендуемый вариант: через global extensions dir

Для standalone `pi` удобнее положить symlink в `~/.pi/agent/extensions/`:

```bash
ln -s ~/hobby/pi-openai-search ~/.pi/agent/extensions/pi-openai-search
```

### Альтернатива: через global settings

Можно добавить абсолютный путь в `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "quietStartup": true,
  "collapseChangelog": true,
  "hideThinkingBlock": true,
  "extensions": ["/home/you/hobby/pi-openai-search"]
}
```

## Legacy gsd

Если нужен старый `gsd`, можно по-прежнему положить symlink в `~/.gsd/agent/extensions/`:

```bash
ln -s ~/hobby/pi-openai-search ~/.gsd/agent/extensions/pi-openai-search
```

## Примеры

### cached mode

```bash
PI_OPENAI_NATIVE_SEARCH_MODE=cached pi --extension ~/hobby/pi-openai-search
```

### live mode только по доменам

```bash
PI_OPENAI_NATIVE_SEARCH_MODE=live \
PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS=platform.openai.com,developers.openai.com \
  pi --extension ~/hobby/pi-openai-search
```

## Что нужно от proxy

Proxy должен:

- не вырезать `tools` из payload Responses API,
- пропускать `type: "web_search"`,
- не валидировать tools так, будто разрешены только `function` tools,
- прозрачно форвардить ответные события Responses API.

Если proxy режет встроенные tools OpenAI, extension подключится, но поиск не заработает.

## Локальная проверка

```bash
npm test
```

## Repeatable proof (S03)

### Почему proof теперь двухступенчатый

Scenario A нельзя честно закрывать одной только CLI-командой. Проверка должна ответить на два разных вопроса:

1. Есть ли structured URLs уже в raw Responses payload до CLI/runtime mapping?
2. Сохраняет ли exact `gsd --mode json --print --no-session` harness truthful blocks и не ломается ли на `spawnSync(..., { maxBuffer: 1024 * 1024 })`?

Для этого в репозитории есть два script entrypoint:

- `scripts/openai-search-raw-probe.mjs`
- `scripts/verify-openai-search-proof.mjs`

Оба используют одни и те же scenario prompts:

- **Scenario A** — `Search the web for the latest OpenAI news today. Return exactly two bullet points with two distinct source links.`
- **Scenario B** — `Reply with exactly two words: calm acknowledgement.`

### Абсолютный path к extension обязателен

В auto-mode worktree нельзя полагаться на `--extension .` или `--extension ./index.js`: они могут резолвиться к каноническому repo cwd, а не к текущему checkout внутри `.gsd/worktrees/...`.

Авторитетный вариант:

```bash
EXTENSION_PATH="$PWD/index.js"
```

Если `PWD` не указывает на нужный checkout, подставь полный абсолютный путь к `index.js` конкретного worktree.

### 1. Raw Responses probe

Показывает, есть ли documented structured URLs уже в upstream payload через `web_search_call.action.sources` или message annotations. Если provider/proxy внезапно вернёт `web_search_call.results`, probe покажет это как opportunistic seam, но не зачтёт за documented closure.

```bash
node scripts/openai-search-raw-probe.mjs \
  --extension "$PWD/index.js" \
  --scenario A \
  --scenario B
```

Что смотреть в выводе:

- `overallVerdict`
- для scenario A:
  - `searchCalls[*].actionSourceCount`
  - `searchCalls[*].resultSourceCount`
  - `annotationSourceCount`
  - `inlineSourceCount`
  - `verdict: pass | blocker | fail`
- для scenario B:
  - должен быть `pass` с нулевым search activity

### 2. Exact no-session verifier harness

Запускает тот же CLI contract, который важен для slice validation: `spawnSync('sh', ['-lc', cmd], { maxBuffer: 1024 * 1024 })`.

```bash
node scripts/verify-openai-search-proof.mjs \
  --extension "$PWD/index.js" \
  --scenario A \
  --scenario B
```

Что смотреть в выводе:

- `overallVerdict`
- для каждого сценария:
  - `summary.command`
  - `summary.stdoutBytes`
  - `summary.durationMs`
  - `summary.finalServerToolUseIds`
  - `summary.finalWebSearchResultIds`
  - `summary.resultBlocks`
  - `verdict: pass | blocker | fail`

### Pass / blocker / fail contract

#### `pass`

Оба script запускаются без operational errors, а затем:

- raw probe показывает хотя бы один documented truthful structured seam для scenario A:
  - `action.sources`, или
  - `annotations`
- verifier harness проходит exact 1 MiB contract без `ENOBUFS`
- scenario A содержит финальные factual `serverToolUse` / `webSearchResult` blocks с сохранённым `toolUseId` separation
- scenario B остаётся полностью чистым:
  - zero `serverToolUse`
  - zero `webSearchResult`
  - zero standalone garbage placeholders вроде `https://www` (валидные `https://www.<domain>` ссылки допустимы)

#### `blocker`

Scripts отработали штатно, но truthful closure для scenario A отсутствует на upstream seam.

Типичные blocker signatures:

- raw probe вернул `verdict: blocker` и показал, что documented structured URLs отсутствуют уже в raw payload
- verifier закончил scenario A только sentinel `web_search_tool_result_complete` без structured URLs
- scenario B остаётся чистым, то есть локальный negative path не сломан

**Дальнейшее действие:** идти в validation/remediation milestone, а не в ещё один source-mapper refactor.

#### `fail`

Proof нельзя считать достоверным, потому что упал сам harness или нарушен локальный contract.

Типичные fail signatures:

- `ENOBUFS` / timeout / wrong `--extension` path
- malformed JSONL
- отсутствует финальный `message_end`
- scenario B внезапно генерирует search artifacts
- в scenario A теряется `toolUseId` separation
- появляются standalone garbage placeholders вроде `https://www` (но не валидные `https://www.<domain>` ссылки)

**Дальнейшее действие:** чинить локальный proof harness, а не классифицировать upstream.

### Актуальный blocker baseline (2026-04-05, GMT+3)

Свежий финальный прогон S05/T02 на текущем worktree подтвердил, что локальный runtime остаётся в truthful blocker-ветке под policy D018 и новый mapper churn не нужен, пока upstream не откроет documented structured seam.

- `npm test`
  - full suite: `pass`
- `node scripts/openai-search-raw-probe.mjs --extension "$PWD/index.js" --scenario A --scenario B`
  - `overallVerdict: blocker`
  - scenario A: `searchCallCount: 1`, `actionSources: 0`, `resultSources: 0`, `annotationSources: 0`, `inlineSources: 2`, `documentedStructuredSourceCount: 0`
  - scenario B: `pass`, search activity отсутствует
- `node scripts/verify-openai-search-proof.mjs --extension "$PWD/index.js" --scenario A --scenario B`
  - `overallVerdict: blocker`
  - scenario A: `serverToolUse/webSearchResult` separation сохранён, `finalServerToolUseCount: 3`, `finalWebSearchResultCount: 3`, `resultBlockCount: 3`, `sentinelCount: 3`, `garbageUrlDetected: false`
  - scenario B: `pass`, `finalWebSearchResultCount: 0`, `garbageUrlDetected: false`

Если свежий rerun совпадает с этой сигнатурой, это именно `blocker`, а не локальный `fail`: full suite зелёный, proof harness работает, negative path чистый, но provider по-прежнему не возвращает documented structured URLs для scenario A. До появления нового provider-backed seam runtime не расширяем и text-derived canonical sources не возвращаем.

## tmux / human-attended UAT checklist

Interactive proof по-прежнему нужен как человеко-проверяемый слой поверх raw + no-session.

### tmux runbook

1. Открой новую tmux pane в нужном worktree.
2. Запусти interactive CLI с абсолютным extension path:

```bash
PI_OPENAI_NATIVE_SEARCH=1 \
PI_OPENAI_NATIVE_SEARCH_MODE=live \
  gsd --extension "$PWD/index.js" --model openai/gpt-5.4
```

3. Введи **Scenario A** prompt.
4. Проверь:
   - search steps отображаются factual blocks, а не synthetic prompt echo
   - финальный search result не содержит мусорных URL
   - если источников нет, это выглядит как honest blocker, а не скрытый fallback
5. Введи **Scenario B** prompt.
6. Проверь:
   - нет search blocks
   - нет garbage URLs
7. Зафиксируй результат как один из трёх исходов: `pass`, `blocker`, `fail`.

### Ограничение auto-mode

В auto-mode нет fresh human-attended tmux confirmation для текущего финального состояния worktree. В этом режиме обязательный минимум такой:

- прогнать raw probe
- прогнать exact verifier harness
- явно записать в task summary и milestone validation, что tmux/UAT не выполнялся человеком на текущем closure rerun
- считать scripted `pass/blocker/fail` только доказательством runtime-state; milestone/manual closure остаётся открытым blocker до отдельного human-attended tmux checklist

## Retest exit criteria

Повторный milestone retest имеет смысл только если выполнено хотя бы одно условие триггера:

- raw probe для scenario A начал возвращать documented structured seam через `web_search_call.action.sources` или `message.content[].annotations`; или
- принято новое явное решение, которое пересматривает D018 и разрешает иной truthful closure contract.

После такого триггера retest считается достаточным только при всех условиях ниже:

1. `npm test` остаётся зелёным.
2. Raw probe (`node scripts/openai-search-raw-probe.mjs ...`) даёт `overallVerdict: pass`, а для scenario A `documentedStructuredSourceCount > 0`.
3. Exact verifier (`node scripts/verify-openai-search-proof.mjs ...`) даёт `overallVerdict: pass`, сохраняет `finalWebSearchResultCount == finalServerToolUseCount`, и хотя бы один финальный `webSearchResult` block для scenario A содержит реальные URL, а не только sentinel completion.
4. Scenario B остаётся clean negative path: zero search artifacts, zero final `webSearchResult`, `garbageUrlDetected: false`.
5. Human operator проходит tmux/UAT checklist для scenarios A и B и фиксирует итог `pass`/`blocker`/`fail`.

Если провайдер вернёт только `web_search_call.results` без documented seams, по D018 это всё ещё blocker, а не milestone closure.

## Useful diagnostics

- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json` — снимок финального provider payload (`tools`, `include`, `tool_choice`, `parallel_tool_calls`)
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json` — снимок финального assistant message, если runtime действительно эмитит `message_end`
- `node --test tests/openai-native-search.test.mjs` — deterministic regression harness для mapper и proof helpers

## Файлы

- `index.js` — регистрация hook-ов extension
- `src/openai-native-search.js` — логика payload injection
- `src/openai-search-display.js` — shared helpers для truthful source/result rendering
- `src/openai-responses-display-patch.js` — patched provider `openai-responses`
- `scripts/openai-search-raw-probe.mjs` — raw Responses seam classifier
- `scripts/verify-openai-search-proof.mjs` — exact CLI verifier harness
- `tests/openai-native-search.test.mjs` — regression tests
