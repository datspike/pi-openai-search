# Compatibility matrix

## Supported runtime matrix

| Runtime | Status | Notes |
|---|---|---|
| standalone `pi 0.65.0` | tested baseline | publication baseline |
| standalone `pi` unknown version | allowed if probe passes | diagnostics only, no user-facing version warning |
| non-standalone `pi` / other runtimes | unsupported | out of scope |

## Feature expectations

Все compat-возможности включены, если соответствующая env-переменная отсутствует. Значение `false` — явный opt-out отдельной возможности.

| Feature | Env flag | Default | Expected probe |
|---|---|---|---|
| `provider-compat` | `PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT` | on | доступен `pi.registerProvider()` или private `registerApiProvider()` |
| `interactive-inline` | `PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT` | on | совместимы patch targets `AssistantMessageComponent`, `ToolExecutionComponent`, `InteractiveMode` |
| `tool-render` | `PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT` | on | совместим `ToolExecutionComponent.prototype.formatToolExecution()` |

## Degradation policy

| Сценарий | Поведение |
|---|---|
| runtime root не найден | core path продолжает работать, compat features получают `unavailable` |
| provider compat недоступен | native search остаётся рабочим, truthful search blocks не форсятся synthetic fallback'ом |
| inline patch недоступен | interactive chronology остаётся штатной runtime-логикой без hard failure |
| tool-render patch недоступен | web_search блоки не получают enhanced truthful formatting |
| unknown runtime version при успешном probe | compat продолжает работать, событие остаётся только в diagnostics |

## Compat smoke

`npm run test:compat-smoke` проверяет узкий drift-check:

- runtime descriptor
- version classification
- provider capability probe
- interactive inline capability probe
- tool-render capability probe

Smoke не заменяет полный `npm test`, а даёт быстрый сигнал после обновления standalone `pi`.
