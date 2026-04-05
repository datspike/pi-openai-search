# Архитектура `pi-openai-search`

## Supported runtime

Поддерживаемый scope намеренно узкий:

- standalone `pi`
- `provider=openai`
- `api=openai-responses`
- tested baseline runtime: `pi 0.65.0`

Unknown `pi` version не считается hard blocker'ом сама по себе. Разрешение идёт capability-first: если probe проходит, compat path остаётся допустимым.

## Слои

### `src/core/**`

Стабильный слой на публичных hooks:

- `model_select`
- `before_provider_request`
- `message_update`
- `message_end`

Ответственность core:

- stable env и payload mutation
- truthful source policy
- lifecycle status для factual search
- safe degradation без знания private runtime internals

`core` не импортирует `src/compat/**` и private runtime модули.

### `src/compat/**`

Compat framework для private seams standalone `pi`.

Ответственность compat:

- runtime discovery
- version classification
- capability probes
- feature activation
- diagnostics и feature-level warnings

## Lifecycle contract

Boot path разбит на три части:

1. `bootstrapCompatRuntime(pi)`
2. `probePiCompatCapabilities(pi, probes)`
3. `activateCompatFeatures(pi, capabilitySummary)`

`index.js` вызывает bootstrap один раз при регистрации extension. После этого `core` получает promise с compat summary и не инициирует второй bootstrap.

Это закрывает два режима:

- с `model_select` -> UI warnings и status появляются поздно, когда модель известна
- без `model_select` -> backend path и compat overlays уже готовы за счёт раннего bootstrap

## Capability registry

Фичи compat ограничены тремя ключами:

- `provider-compat`
- `interactive-inline`
- `tool-render`

Для каждой фичи summary хранит:

- `enabled`
- `status`
- `supported`
- `reason`
- `diagnostics`

Итоговый compat status бывает:

- `supported`
- `partial`
- `unavailable`

## Version policy

Версия runtime классифицируется отдельно от feature support:

- `0.65.0` -> baseline `supported`
- любая другая определённая версия -> `unknown`, но без user-facing warning
- версия не определилась -> `unknown`, probing остаётся capability-first

User-facing warnings строятся только из реально недоступных compat-фич. Диагностика версии остаётся maintainer/debug surface.

## Truthful policy

Допустимые source seams:

- `web_search_call.action.sources`
- `message.output_text.annotations`
- defensive observed seam `web_search_call.results`
- inline URLs в финальном тексте, если они реально наблюдаемы

Запрещено:

- synthetic citations
- synthetic query labels
- fabricated `webSearchResult`
- prompt-derived search artifacts
