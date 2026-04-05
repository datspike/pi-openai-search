# Архитектура `pi-openai-search`

## Supported path

Поддерживаемый path ограничен одним сочетанием:

- standalone `pi`
- `provider=openai`
- `api=openai-responses`

Всё остальное находится вне scope текущего репозитория.

## Слои

### `core`

`core` - стабильный слой в `src/core/`, который опирается только на публичные extension hooks:

- `model_select`
- `before_provider_request`
- `message_update`
- `message_end`

Ответственность `core`:

- чтение и нормализация stable env;
- payload mutation для native `web_search`;
- truthful policy для source evidence;
- lifecycle state для factual search status;
- safe degradation без hard failure.

Ограничения `core`:

- нельзя импортировать private runtime internals `pi` и `pi-ai`;
- нельзя импортировать код из `src/compat/`;
- нельзя создавать synthetic citations, synthetic query labels или synthetic `webSearchResult`.

### `experimental compat`

`experimental compat` - опциональный слой в `src/compat/`, который допускает работу с unstable runtime/UI internals standalone `pi`.

Ответственность compat:

- runtime autodiscovery;
- private imports standalone `pi`;
- optional interactive/render patches;
- optional provider override;
- version guards, warnings и fail-open degradation.

Ограничения compat:

- compat не должен быть обязательным для базового supported path;
- compat не должен протаскивать private runtime knowledge обратно в `core`;
- любая enhanced UX-логика из compat должна оставаться truthful.

## Dependency rules

Разрешённые зависимости:

- `index.js` -> `src/core/**`
- `index.js` -> `src/compat/**`
- `src/compat/**` -> `src/core/contracts/**`
- `src/core/**` -> `src/shared/**`
- `src/compat/**` -> `src/shared/**`

Запрещённые зависимости:

- `src/core/**` -> `src/compat/**`
- `src/core/**` -> `pi-ai/dist/**`
- `src/core/**` -> `@mariozechner/pi-coding-agent/dist/**`
- `src/core/**` -> `node_modules/**/dist/**`

## Canonical inputs и outputs

Входы `core`:

- provider/model metadata из `model_select` и `before_provider_request`;
- `assistantMessageEvent` из `message_update`;
- финальное assistant message из `message_end`.

Канонические выходы `core`:

- mutated provider payload для native `web_search`;
- canonical truthful source set;
- lifecycle status state для UI.

## Truthful source evidence

Допустимые источники evidence:

- documented structured `web_search_call.action.sources`;
- `output_text.annotations`;
- defensive observed seams: `web_search_call.results`;
- inline URLs в финальном тексте, если они реально присутствуют в observed output.

Недопустимые fallback-механизмы:

- synthetic citations;
- synthetic query labels;
- prompt-derived search artifacts;
- fabricated `webSearchResult` blocks без observed evidence.

## Env taxonomy

### Stable env

- `PI_OPENAI_NATIVE_SEARCH`
- `PI_OPENAI_NATIVE_SEARCH_MODE`
- `PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE`
- `PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS`
- `PI_OPENAI_NATIVE_SEARCH_COUNTRY`
- `PI_OPENAI_NATIVE_SEARCH_REGION`
- `PI_OPENAI_NATIVE_SEARCH_CITY`
- `PI_OPENAI_NATIVE_SEARCH_TIMEZONE`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE`
- `PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE`

### Experimental env

- `PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT`
- `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT`
- `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT`
- `PI_BIN_PATH`
- `PI_AGENT_DIR`

## Migration note

На переходном этапе допускается coexistence legacy-модулей из `src/`, но все новые stable contracts должны появляться только под `src/core/`, а новый unstable код - только под `src/compat/`.
