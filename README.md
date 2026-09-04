# pi-openai-search

Расширение standalone `pi`, которое включает нативный OpenAI `web_search` только для явных маршрутов OpenAI Responses, OpenAI Codex Responses и CLIProxyAPI Codex Responses. По умолчанию интерфейс использует публичный API Pi без патчей его UI-классов.

## Support contract

Stable contract:

- автономный `pi`
- `provider=openai` + `api=openai-responses`
- `provider=openai-codex` + `api=openai-codex-responses`
- `provider=cliproxyapi` + `api=cliproxyapi-codex-responses`
- Azure, произвольные OpenAI-compatible поставщики и данные без метаданных модели не изменяются
- достоверная политика payload/source через `src/core/**`

Контракт интерфейса и совместимости:

- текущий статус поиска обновляется через публичные hooks
- итоговые запросы и источники сохраняются после хода через `appendEntry` и `registerEntryRenderer`, вне контекста модели
- карточка появляется только при наличии наблюдаемых `serverToolUse` / `webSearchResult`; текст ответа не превращается в события поиска
- `provider-compat` включён по умолчанию; старые `interactive-inline` и `tool-render` требуют явного `true`
- проверенная среда: `pi 0.85.0`; неизвестная версия допускается при успешной проверке возможностей
- недоступность необязательной возможности не должна блокировать поиск

Матрица и caveats: [docs/compatibility.md](./docs/compatibility.md)

## Архитектура

Проект разделён на два слоя:

- `src/core/**` - stable core-first pipeline на публичных hooks
- `src/compat/**` - compat framework для private runtime seams

`index.js` запускает compat bootstrap один раз и передаёт его promise в основной lifecycle. Асинхронная фабрика дожидается регистрации провайдера до старта сессии. Затем подключает публичный renderer, если старый inline-патч не был явно включён и успешно применён.

Карточка сохраняется на `turn_end`, после сообщения ассистента. Она восстанавливается из истории и поддерживает раскрытие. Вставка поисковых блоков между текстовыми фрагментами ответа больше не является поведением по умолчанию.

Подробности:

- архитектура: [docs/architecture.md](./docs/architecture.md)
- compatibility matrix: [docs/compatibility.md](./docs/compatibility.md)
- migration note: [docs/migration.md](./docs/migration.md)
- contract map: [src/core/contracts/architecture.js](./src/core/contracts/architecture.js)

## Что делает core

- включает native OpenAI `web_search` только для трёх поддерживаемых provider/API пар
- удаляет только точные прямые function-tool дубликаты: `search-the-web`, `search_and_read`, `google_search`
- не скрывает `bx`, Brave/MCP gateway и прочие инструменты по словам `search`, `brave`, `bx` или `mcp`
- добавляет `include: ["web_search_call.action.sources"]`
- выставляет `tool_choice = "auto"` и `parallel_tool_calls = true`, если поле не задано
- обновляет factual search status только по реально наблюдаемым search events
- строит citations только из реальных source seams
- сохраняет итоговую карточку поиска, не изменяя сообщение ассистента и контекст модели

## Что делает compat framework

- определяет runtime descriptor и версию standalone `pi`
- пробует compat-фичи по capability registry
- активирует provider compat; UI-патчи проверяет и применяет только при явном opt-in
- предупреждает о недоступности включённых compat-возможностей
- не шумит user-facing warning'ами о неизвестной версии `pi`

## Быстрый запуск

```bash
pi --extension ~/hobby/pi-openai-search
```

Разовая live-проверка:

```bash
PI_OPENAI_NATIVE_SEARCH=1 \
PI_OPENAI_NATIVE_SEARCH_MODE=live \
CLIPROXYAPI_API_KEY="$OPENAI_API_KEY" \
  pi --extension "$PWD/index.js" --print --no-session \
  --model cliproxyapi/gpt-5.6-sol \
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

- `PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT=true|false` — по умолчанию `true`
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT=true|false` — старый inline-патч, по умолчанию `false`
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT=true|false` — старый formatter, по умолчанию `false`
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

`tests/proof/public-ui.test.mjs` запускает установленный CLI с локальным тестовым провайдером без сетевых запросов: проверяет порядок записей, отсутствие карточек без поиска, исключение из контекста модели и ширину рендера. Это не проверка живого OpenAI/CLIProxyAPI.

На проверенном Pi `0.85.0` встроенные Codex-потоки не выдают `serverToolUse` / `webSearchResult`. Инъекция поиска для них сохраняется, но карточка не создаётся из текста ответа. Текущий provider compat собирает структурированные события для `openai/openai-responses`.

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
