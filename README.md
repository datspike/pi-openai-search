# pi-openai-search

POC extension для `gsd` / `pi`, который включает нативный `web_search` tool у OpenAI Responses API.

Это не Brave, не Tavily и не отдельный поисковый tool. Extension делает то же базовое действие, что и Codex CLI:

- ловит `before_provider_request`
- проверяет, что текущая модель использует один из transport:
  - `openai-responses`
  - `openai-codex-responses`
  - `azure-openai-responses`
- добавляет в provider payload встроенный tool:
  - `type: "web_search"`

## Для твоего случая

Судя по `cli-proxy-api/README.md`, у тебя `gsd` использует встроенный provider `openai` с override `baseUrl` на локальный proxy и transport `openai-responses`.

Значит этот extension должен попадать ровно в нужную точку.

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
- патчит provider `openai-responses` через `registerApiProvider()` так, чтобы финальный assistant message содержал:
  - `serverToolUse` для `web_search_call`
  - `webSearchResult` для завершённого native search
  - добавленные в текст citations, если OpenAI вернул структурированные источники, которых ещё нет в тексте

## Ограничения POC

Сейчас UX-патч добавлен только для transport `openai-responses`.

То есть для твоего основного кейса с proxy-backed `openai/gpt-5.4` это уже покрыто, но:

- `openai-codex-responses` пока без аналогичного display patch,
- `azure-openai-responses` пока без аналогичного display patch,
- если upstream не вернёт структурированные annotations/sources, extension не выдумает их сам — в таком случае остаются только ссылки, которые модель явно написала в тексте.

То есть это уже не только payload injection, а рабочий runtime patch для твоего основного OpenAI Responses сценария, но ещё не полный upstream-quality клон UX Codex.

## Быстрый запуск

```bash
gsd --extension ~/hobby/pi-openai-search
```

Если нужно проверить разово:

```bash
PI_OPENAI_NATIVE_SEARCH_MODE=live \
  gsd --extension ~/hobby/pi-openai-search --mode text --print --no-session \
  --model gpt-5.4 'Найди свежие заметки про OpenAI Responses API web_search и кратко перескажи с источниками.'
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

## Глобальное включение в gsd

### Рекомендуемый вариант: через global settings

Добавь extension в `~/.gsd/agent/settings.json`:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "quietStartup": true,
  "collapseChangelog": true,
  "hideThinkingBlock": true,
  "extensions": [
    "~/hobby/pi-openai-search"
  ]
}
```

После этого `gsd` будет загружать extension без `--extension`.

### Альтернатива: через global extensions dir

Можно положить symlink в `~/.gsd/agent/extensions/`, и тогда `gsd` подхватит package автоматически:

```bash
ln -s ~/hobby/pi-openai-search ~/.gsd/agent/extensions/pi-openai-search
```

Этот вариант хорош, если хочешь полностью жить в стандартной директории extension-ов `gsd/pi`.

## Примеры

### cached mode

```bash
PI_OPENAI_NATIVE_SEARCH_MODE=cached gsd --extension ~/hobby/pi-openai-search
```

### live mode только по доменам

```bash
PI_OPENAI_NATIVE_SEARCH_MODE=live \
PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS=platform.openai.com,developers.openai.com \
  gsd --extension ~/hobby/pi-openai-search
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
cd ~/hobby/pi-openai-search
npm test
```

## Файлы

- `index.js` - регистрация hook-ов extension
- `src/openai-native-search.js` - чистая логика инъекции
- `tests/openai-native-search.test.mjs` - smoke tests для payload mutation
