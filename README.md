# pi-openai-search

Extension для standalone `pi`, который включает native OpenAI `web_search` в supported path `provider=openai` + `api=openai-responses` и поверх этого пытается включить compat-enhanced Codex-like UX без synthetic fallback.

## Support contract

Stable contract:

- standalone `pi`
- `provider=openai`
- `api=openai-responses`
- truthful payload/source policy через `src/core/**`

Compat-enhanced contract:

- capability-based probes для `provider-compat`, `interactive-inline`, `tool-render`
- tested baseline runtime: `pi 0.65.0`
- unknown `pi` version не блокирует запуск, если capability probe проходит
- unknown version уходит только в diagnostics, не в user-facing warnings
- деградация только feature-level, без synthetic search artifacts

Матрица и caveats: [docs/compatibility.md](./docs/compatibility.md)

## Архитектура

Проект разделён на два слоя:

- `src/core/**` - stable core-first pipeline на публичных hooks
- `src/compat/**` - compat framework для private runtime seams

`index.js` делает ровно две вещи:

- один раз запускает `bootstrapCompatRuntime(pi)`
- передаёт promise с compat summary в `core` lifecycle

Это закрывает сценарий старта без `model_select`: backend path продолжает работать, а compat overlays активируются ранним bootstrap без повторной инициализации.

Подробности:

- архитектура: [docs/architecture.md](./docs/architecture.md)
- compatibility matrix: [docs/compatibility.md](./docs/compatibility.md)
- migration note: [docs/migration.md](./docs/migration.md)
- contract map: [src/core/contracts/architecture.js](./src/core/contracts/architecture.js)

## Что делает core

- включает native OpenAI `web_search` только для Responses API
- удаляет конкурирующие search tools из model-visible payload
- добавляет `include: ["web_search_call.action.sources"]`
- выставляет `tool_choice = "auto"` и `parallel_tool_calls = true`, если поле не задано
- обновляет factual search status только по реально наблюдаемым search events
- строит citations только из реальных source seams

## Что делает compat framework

- определяет runtime descriptor и версию standalone `pi`
- пробует compat-фичи по capability registry
- отдельно активирует provider compat, inline patch и tool-render patch
- отдаёт feature-level warnings только для реально недоступных compat-фич
- не шумит user-facing warning'ами о неизвестной версии `pi`

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

## Env taxonomy

Stable env:

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

Compat env:

- `PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT=true|false`
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT=true|false`
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT=true|false`
- `PI_BIN_PATH=/abs/path/to/pi`
- `PI_AGENT_DIR=/abs/path/to/.pi/agent`

## Verification

Полный suite:

```bash
npm test
```

Узкий drift-check для compat:

```bash
npm run test:compat-smoke
```

Контуры:

```bash
node --test tests/compat/*.test.mjs
node --test tests/contracts/*.test.mjs
node --test tests/proof/*.test.mjs
```

## Truthful invariants

- без реального search не появляются search status, citations или `webSearchResult`
- compat не создаёт synthetic citations, synthetic query labels и fabricated search blocks
- provider compat и interactive patches допускаются только как truthful projection реальных provider events
