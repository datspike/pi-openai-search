# Migration guide

## Что считается стабильным

Стабильный контракт ограничен:

- entrypoint `index.js`;
- `core-first` pipeline на публичных hooks `model_select`, `before_provider_request`, `message_update`, `message_end`;
- stable env из `docs/architecture.md`;
- truthful source policy без synthetic fallback.

## Что считается экспериментальным

Экспериментальным считается всё под `src/compat/`:

- runtime autodiscovery standalone `pi`;
- interactive renderer patches;
- provider override helpers;
- bridge-модули для legacy compat paths.

## Что переехало

Новые canonical namespaces:

- stable contracts -> `src/core/**`
- experimental compat -> `src/compat/**`

Legacy module aliases в `src/*.js` сохранены как thin bridge на переходный период.

## Окно обратной совместимости

Legacy aliases сохраняются до `2026-06-30`.

План после даты:

- удалить bridge-модули `src/pi-runtime.js`, `src/pi-ai-compat.js`, `src/openai-interactive-search-order-patch.js`, `src/openai-tool-execution-web-search-patch.js`, `src/openai-responses-*.js`;
- оставить только canonical imports из `src/core/**` и `src/compat/**`.

## Env-совместимость

Переименования stable env в этой миграции нет.

Классификация теперь такая:

- stable env: payload/truthful/debug behavior;
- experimental env: compat runtime toggles, provider compat и standalone runtime discovery.

## Практический переход

1. Продолжать подключать extension через `index.js`.
2. Если нужен только supported path, ничего не включать дополнительно: default already core-first.
3. Rich interactive UX и truthful search blocks теперь пытаются включаться eagerly через experimental compat; при runtime mismatch остаётся fail-open warning.
4. Для интеграций и внутренних импортов переходить на canonical paths:
   - `src/core/**` для stable logic;
   - `src/compat/**` для unstable runtime glue.

## Намеренно unsupported

- `openai-completions`
- другие providers и transports
- synthetic citations или synthetic `webSearchResult`
- обязательный custom provider override для default path
