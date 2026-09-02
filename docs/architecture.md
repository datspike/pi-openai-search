# Архитектура `pi-openai-search`

## Supported runtime

Поддерживаемая область действия намеренно узкая:

- автономный `pi`
- `provider=openai` + `api=openai-responses`
- `provider=openai-codex` + `api=openai-codex-responses`
- `provider=cliproxyapi` + `api=cliproxyapi-codex-responses`
- Azure, произвольные OpenAI-compatible поставщики и данные без метаданных модели не изменяются
- проверенная базовая среда выполнения: `pi 0.65.0`

Unknown `pi` version не считается hard blocker'ом сама по себе. Разрешение compat идёт capability-first: если probe проходит, compat path остаётся допустимым. Все три compat-возможности включены по умолчанию и отключаются только явным `false` в соответствующей env-переменной.

## Слои

### `src/core/**`

Стабильный слой на публичных hooks:

- `model_select`
- `before_provider_request`
- `message_update`
- `message_end`

Ответственность core:

- стабильное окружение и изменение данных запроса только для двух явных provider/API пар
- удаление только точных прямых function-tool дубликатов `search-the-web`, `search_and_read`, `google_search`
- сохранение `bx`, Brave/MCP шлюза и любых неизвестных инструментов без эвристики по имени
- политика достоверности источников
- статус жизненного цикла для поиска фактов
- безопасное ограничение функциональности без знания внутреннего устройства закрытой среды выполнения

`core` не импортирует `src/compat/**` и закрытые модули среды выполнения.

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
