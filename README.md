# pi-openai-search

Extension для standalone `pi`, который включает native OpenAI `web_search` в supported path `provider=openai` + `api=openai-responses` и держит truthful UX без synthetic fallback.

## Supported scope

Поддерживается только один path:

- standalone `pi`
- `provider=openai`
- `api=openai-responses`

Намеренно не поддерживается:

- `openai-completions`
- другие providers и transports
- synthetic citations
- synthetic query labels
- synthetic `webSearchResult`
- обязательный custom provider override для default path

## Архитектура

Проект разделён на два слоя:

- `core` - stable, supported, public-hook-based логика в `src/core/`
- `experimental compat` - optional runtime/UI glue в `src/compat/`

Default entrypoint `index.js` работает в режиме `core-first`:

- регистрирует только публичные extension hooks `model_select`, `before_provider_request`, `message_update`, `message_end`
- не требует provider override в stable core path
- eagerly подключает experimental compat overlays в fail-open режиме
- деградирует без hard failure при несовместимом runtime

Подробности:

- архитектурный контракт: [docs/architecture.md](./docs/architecture.md)
- migration story и deprecation window: [docs/migration.md](./docs/migration.md)
- машинно-читаемый contract map: [src/core/contracts/architecture.js](./src/core/contracts/architecture.js)

## Что делает `core`

- включает native OpenAI `web_search` только для Responses API
- удаляет конкурирующие search tools из model-visible payload
- добавляет `include: ["web_search_call.action.sources"]`
- выставляет `tool_choice = "auto"` и `parallel_tool_calls = true`, если поле не задано
- обновляет factual search status только по реально наблюдаемым search events
- добавляет citations в текст только из реальных source evidence

## Что делает `experimental compat`

- runtime autodiscovery standalone `pi`
- optional interactive renderer patches
- optional provider-override helpers, изолированные в `src/compat/provider/`
- truthful `serverToolUse` / `webSearchResult` blocks через experimental provider compat
- warnings и fail-open degradation при runtime mismatch

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

## Подключение

Через extensions dir:

```bash
ln -s ~/hobby/pi-openai-search ~/.pi/agent/extensions/pi-openai-search
```

Через `settings.json`:

```json
{
  "extensions": ["/home/you/hobby/pi-openai-search"]
}
```

## Env taxonomy

### Stable env

- `PI_OPENAI_NATIVE_SEARCH=true|false`
- `PI_OPENAI_NATIVE_SEARCH_MODE=live|cached|off`
- `PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE=low|medium|high`
- `PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS=example.com,docs.example.com`
- `PI_OPENAI_NATIVE_SEARCH_COUNTRY=US`
- `PI_OPENAI_NATIVE_SEARCH_REGION=CA`
- `PI_OPENAI_NATIVE_SEARCH_CITY=San Francisco`
- `PI_OPENAI_NATIVE_SEARCH_TIMEZONE=America/Los_Angeles`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json`

### Experimental env

- `PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT=true|false`
  - default: `true`
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT=true|false`
  - default: `true`
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT=true|false`
  - default: `true`
- `PI_BIN_PATH=/abs/path/to/pi`
  - optional standalone runtime discovery override
- `PI_AGENT_DIR=/abs/path/to/.pi/agent`
  - optional path for proof/live harness

## Failure modes

- compat runtime не найден -> `core` продолжает работать, compat-патчи пропускаются
- provider compat недоступен -> native search остаётся рабочим, но truthful search blocks могут не появиться
- runtime shape изменился -> compat деградирует fail-open и отдаёт warning
- structured sources отсутствуют -> synthetic citations не генерируются, допускается truthful sentinel/result without fabricated sources
- negative path без search -> search artifacts не добавляются

## Migration

Коротко:

- canonical stable imports теперь под `src/core/**`
- canonical experimental imports теперь под `src/compat/**`
- legacy aliases в `src/*.js` сохранены как thin bridge до `2026-06-30`
- переименования stable env в этой миграции нет

Подробно: [docs/migration.md](./docs/migration.md)

## Проверка

Полный baseline:

```bash
npm test
```

По контурам:

```bash
node --test tests/core/*.test.mjs
node --test tests/compat/*.test.mjs
node --test tests/contracts/*.test.mjs
node --test tests/proof/*.test.mjs
```

## Proof scripts

Оба script entrypoint работают только со standalone `pi` и абсолютным путём к extension:

```bash
EXTENSION_PATH="$PWD/index.js"
```

Raw Responses probe:

```bash
node scripts/openai-search-raw-probe.mjs \
  --extension "$EXTENSION_PATH" \
  --scenario A \
  --scenario B
```

Exact no-session verifier harness:

```bash
node scripts/verify-openai-search-proof.mjs \
  --extension "$EXTENSION_PATH" \
  --scenario A \
  --scenario B
```

## Pass / blocker / fail contract

`pass`:

- scenario A реально выполняет `web_search`
- source evidence сохраняется через structured seams, observed results seam или inline URLs
- verifier сохраняет truthful `serverToolUse` / `webSearchResult` и source URLs к `message_end`
- scenario B остаётся clean negative path

`blocker`:

- harness работает
- scenario A выполняет `web_search`, но до финального ответа не доживают ни structured, ни inline source URLs
- scenario B остаётся чистым

`fail`:

- ломается сам harness
- malformed JSONL / timeout / wrong extension path
- теряется `toolUseId` separation
- появляются garbage URLs или search artifacts в scenario B

## Useful diagnostics

- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE=/tmp/pi-openai-search.json`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE=/tmp/pi-openai-search-message.json`
- `npm run test:legacy`
