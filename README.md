# pi-openai-search

POC extension только для standalone `pi`, который включает нативный `web_search` tool у OpenAI Responses API и сохраняет truthful UX без synthetic fallback.

## Что делает

- включает native OpenAI web search только для Responses API;
- не трогает `openai-completions`;
- убирает из model-visible payload конкурирующие search tools;
- добавляет `include: ["web_search_call.action.sources"]`;
- выставляет `tool_choice = "auto"` и `parallel_tool_calls = true`, если поле не задано;
- регистрирует patched provider для `openai-responses`;
- проецирует реальные `web_search_call` события в `serverToolUse` и `webSearchResult`;
- добавляет citations в текст только из реальных structured sources;
- патчит interactive/replay renderer standalone `pi` через fail-open compat-слой.

## Supported path

Поддерживается один runtime path:
- standalone `pi`
- `provider=openai`
- `api=openai-responses`

Репозиторий не поддерживает `gsd`, synthetic citations, synthetic query labels и productized fallback modes.

## Архитектура

- `src/pi-runtime.js` - `pi-only` discovery/import helpers
- `src/openai-native-search.js` - payload injection
- `src/openai-search-display.js` - truthful format/source helpers
- `src/openai-responses-params.js` - payload/reasoning/include builder
- `src/openai-responses-client.js` - OpenAI client creation и response helpers
- `src/openai-responses-search-mapper.js` - truthful search mapping
- `src/openai-responses-stream.js` - stream lifecycle orchestration
- `src/openai-responses-provider.js` - provider registration
- `src/openai-interactive-search-order-patch.js` - interactive inline compat patch
- `src/openai-tool-execution-web-search-patch.js` - truthful `web_search` renderer

## Быстрый запуск

```bash
pi --extension ~/hobby/pi-openai-search
```

Разовая live-проверка:

```bash
PI_OPENAI_NATIVE_SEARCH=1 \
PI_OPENAI_NATIVE_SEARCH_MODE=live \
  pi --extension "$PWD/index.js" --mode text --print --no-session \
  --model openai/gpt-5.4 \
  'Найди свежие заметки про OpenAI Responses API web_search и кратко перескажи с источниками.'
```

## Глобальное подключение

### Через extensions dir

```bash
ln -s ~/hobby/pi-openai-search ~/.pi/agent/extensions/pi-openai-search
```

### Через settings.json

```json
{
  "extensions": ["/home/you/hobby/pi-openai-search"]
}
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

### Runtime / compat

- `PI_BIN_PATH=/abs/path/to/pi`
  - optional
  - явный путь к standalone `pi` binary для runtime autodiscovery
- `PI_AGENT_DIR=/abs/path/to/.pi/agent`
  - optional
  - нужен proof scripts и live smoke-check, если используется нестандартный agent dir
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT=true|false`
  - default: `true`
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT=true|false`
  - default: `true`

### Отладка

- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json`

## Safe degradation

- если compat runtime не найден или upstream shape поменялся, extension не падает на import;
- если upstream не отдаёт documented structured sources, `webSearchResult` остаётся truthful sentinel без synthetic citations;
- interactive compat-патчи деградируют fail-open и оставляют payload/provider path рабочим.

## Локальная проверка

```bash
npm test
```

## Proof scripts

Оба script entrypoint работают только со standalone `pi` и абсолютным путём к extension:

```bash
EXTENSION_PATH="$PWD/index.js"
```

### 1. Raw Responses probe

```bash
node scripts/openai-search-raw-probe.mjs \
  --extension "$EXTENSION_PATH" \
  --scenario A \
  --scenario B
```

Проверяет, есть ли documented structured seams уже в raw Responses payload.

### 2. Exact no-session verifier harness

```bash
node scripts/verify-openai-search-proof.mjs \
  --extension "$EXTENSION_PATH" \
  --scenario A \
  --scenario B
```

Запускает exact CLI contract через standalone `pi --mode json --print --no-session`.

## Pass / blocker / fail contract

### `pass`

- raw probe показывает documented structured seam для scenario A;
- verifier сохраняет `serverToolUse` / `webSearchResult` и реальные URL;
- scenario B остаётся clean negative path.

### `blocker`

- harness работает штатно;
- upstream не даёт documented structured seam для scenario A;
- negative path остаётся чистым.

### `fail`

- сломан сам harness;
- malformed JSONL / timeout / wrong extension path;
- теряется `toolUseId` separation;
- появляются garbage URLs или search artifacts в scenario B.

## Useful diagnostics

- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json`
- `node --test tests/openai-native-search.test.mjs`
