# Migration guide

## Что стабильно

Стабильный контракт ограничен:

- entrypoint `index.js`
- `src/core/**`
- truthful policy без synthetic fallback
- stable env, описанными в `README.md` и `docs/architecture.md`

## Что compat-only

Compat contract находится только в `src/compat/**`:

- runtime discovery и version classification
- provider compat
- interactive inline patch
- tool-render patch
- compat diagnostics

## Переход на публичный UI в Pi 0.85.0

По умолчанию `interactive-inline` и `tool-render` выключены. Вместо патчей UI-классов используется `appendEntry` / `registerEntryRenderer`: итоговая карточка поиска сохраняется после хода, вне контекста модели. Provider compat остаётся включённым.

Если раньше env-флаги были явно выставлены в `true`, убери их либо выставь `false`, чтобы перейти на публичный UI. После обновления перезапусти Pi: уже применённые прототипные патчи нельзя снять одной сменой defaults.

Старые сообщения и сессии не переписываются. Карточки создаются только для новых ходов с наблюдаемыми структурированными событиями; источники из обычного текста в карточки не превращаются.

## Предыдущее разделение на core и compat

- bootstrap разбит на `bootstrap -> probe -> activate`
- сценарий старта без `model_select` стал отдельным поддержанным lifecycle case
- canonical imports внутри репозитория переведены на `src/core/**` и `src/compat/**`
- legacy bridge-модули из `src/*.js` удалены

## Что нужно поменять в своих imports

Вместо legacy aliases использовать только canonical пути:

- `src/core/config/native-search-config.js`
- `src/core/payload/native-search.js`
- `src/core/lifecycle/search-status.js`
- `src/core/truthful/search-results.js`
- `src/compat/runtime/pi-runtime.js`
- `src/compat/runtime/pi-ai-compat.js`
- `src/compat/interactive/*.js`
- `src/compat/provider/*.js`

## Env-совместимость

Переименования env нет.

Смысл разделения такой:

- stable env -> payload/truthful/debug behaviour
- compat env -> feature toggles и runtime discovery

## Намеренно unsupported

- `openai-completions`
- другие providers и transports
- synthetic citations
- synthetic `webSearchResult`
- расширение scope за пределы standalone `pi`
