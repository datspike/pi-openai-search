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

## Что изменилось в этой итерации

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
