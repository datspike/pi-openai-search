# Контекст для следующей plancc-сессии

Дата фиксации: `2026-04-05`

## Зачем этот файл

Артефакт для следующей сессии `$plancc` по репозиторию `pi-openai-search`.

Нужен как короткий post-fix контекст после очистки extension до standalone `pi` architecture.

## Что уже закрыто

Подтверждено по коду и тестам:
- extension работает только в standalone `pi` и больше не тащит dual-runtime baggage;
- runtime seam сведён к `src/pi-runtime.js` с `PI_BIN_PATH` и import helper для внутренних модулей `pi`;
- legacy `gsd` support удалён из production-кода, proof harness, тестов и user-facing документации;
- provider patch разрезан на узкие модули: params, client, stream, provider, search mapper;
- truthful `serverToolUse` и `webSearchResult` сохраняются;
- interactive compat-патчи продолжают fail-open деградацию;
- локальные тесты остаются главным regression contour.

## Текущее состояние кода

- `src/pi-runtime.js`
  - канонический `pi-only` runtime layer;
  - discovery/import/compat registration.

- `src/openai-native-search.js`
  - payload-layer в рабочем состоянии;
  - умеет payload-shape fallback для `openai-responses`.

- `src/openai-search-display.js`
  - канонический truthful projection layer для format/source helpers.

- `src/openai-responses-params.js`
  - builder payload/reasoning/include/cache logic.

- `src/openai-responses-client.js`
  - runtime-local OpenAI client creation и shared response helpers.

- `src/openai-responses-search-mapper.js`
  - truthful projection `web_search_call -> serverToolUse/webSearchResult`.

- `src/openai-responses-stream.js`
  - stream lifecycle orchestration.

- `src/openai-responses-provider.js`
  - provider registration / entrypoint.

- `src/openai-interactive-search-order-patch.js`
  - `pi-only` compat-патч для inline chronological order и replay.

- `src/openai-tool-execution-web-search-patch.js`
  - truthful formatter patch для `web_search`.

## Что остаётся важным риском

- compat-патчи всё ещё завязаны на приватные runtime prototype seams standalone `pi`;
- raw/live proof по documented structured seams зависит от поведения upstream OpenAI/provider;
- transports вне `provider=openai`, `api=openai-responses` остаются вне supported path.

## Следующий этап

Опираться на `NEXT-STAGE-SCOPE.md`.

Практический scope следующего этапа:
- удерживать `pi-only` контракт без нового compat baggage;
- локально стабилизировать interactive patch seams при изменениях upstream `pi`;
- сохранять truthful UX и fail-open деградацию;
- не расширять scope на другие transports и synthetic fallback.

## Что не входит в следующий этап

- изменения upstream `pi`;
- расширение на `openai-codex-responses`;
- расширение на `azure-openai-responses`;
- synthetic citations;
- synthetic query labels;
- новые productized fallback modes.
