# Контекст для следующей plancc-сессии

Дата фиксации: `2026-04-05`

## Зачем этот файл

Артефакт для следующей сессии `$plancc` по репозиторию `pi-openai-search`.

Нужен как короткий post-fix контекст после завершения интеграции native OpenAI web search для standalone `pi`.

## Что уже закрыто

Подтверждено по коду, тестам и реальной interactive-сессии:
- native OpenAI web search реально подключается в `pi`, а не только на уровне payload;
- standalone `pi` и legacy `gsd` обнаруживаются через compat auto-discovery;
- `before_provider_request` корректно использует `event.model || selectedModel`;
- native `web_search` инжектится не только по `event.model`, но и по shape payload;
- `serverToolUse` и `webSearchResult` сохраняются в assistant history;
- interactive TUI в standalone `pi` снова показывает inline search-блоки;
- replay/history path для тех же блоков тоже работает;
- sentinel-only `webSearchResult` больше не теряется и показывается как завершённый search;
- локальные тесты зелёные.

## Что было фактической проблемой

Корень бага был не в payload и не в самой работе поиска.

Поиск работал, но standalone `pi` не показывал native search-блоки в interactive TUI, потому что:
- upstream `AssistantMessageComponent` рендерит только `text` и `thinking`;
- upstream `InteractiveMode` создаёт отдельные tool-компоненты только для `toolCall`, не для `serverToolUse`;
- наш compat-патч в одном из проходов ломался fail-open из-за импорта отсутствующего runtime-файла `timestamp.js`;
- дополнительно compat-путь зависел от helper `formatWebSearchResult()`, которого в runtime standalone `pi` нет.

Сейчас это исправлено.

## Текущее состояние кода

- `src/openai-native-search.js`
  - payload-layer в рабочем состоянии;
  - умеет payload-shape fallback для `openai-responses`.

- `src/openai-search-display.js`
  - канонический truthful projection layer;
  - теперь содержит formatter для inline `webSearchResult`, включая sentinel-only completion.

- `src/openai-responses-display-patch.js`
  - остаётся главным compat-fork для OpenAI Responses stream mapping;
  - именно здесь остаётся основной blast radius.

- `src/openai-interactive-search-order-patch.js`
  - рабочий compat-патч для standalone `pi`;
  - inline chronological order и replay для native search сейчас держатся;
  - fallback на локальный formatter убирает зависимость от отсутствующего runtime-helper.

- `src/openai-tool-execution-web-search-patch.js`
  - truthful formatter patch для `web_search`;
  - сравнительно узкий и стабильный слой.

## Что подтверждено тестами

- `npm test` проходит;
- есть тесты на:
  - payload-shape fallback без `event.model`;
  - replay/live chronological inline order;
  - fallback formatter для `webSearchResult` без runtime helper;
  - truthful labels для pending/done search;
  - reuse последней выбранной модели.

## Что остаётся важным риском

- `src/openai-responses-display-patch.js` всё ещё слишком широкий compat-fork и владеет не только search projection, но и stream semantics;
- `src/openai-interactive-search-order-patch.js` по-прежнему патчит приватные прототипы runtime;
- совместимость держится через runtime probe и defensive fallback, а не через стабильный upstream seam;
- live proof path по documented structured seams не стоит считать окончательно решённой архитектурной темой только потому, что UI теперь работает.

## Следующий этап

Опираться на `NEXT-STAGE-SCOPE.md`.

Практический scope следующего этапа:
- сузить и стабилизировать локальные compat-слои;
- уменьшить blast radius в `src/openai-responses-display-patch.js`;
- уменьшить blast radius в `src/openai-interactive-search-order-patch.js`;
- сохранить truthful `serverToolUse` / `webSearchResult`;
- сохранить безопасную деградацию внутри extension, если runtime несовместим.

## Что неактуально и не нужно тащить дальше

- больше не нужно повторно расследовать, почему в последней `pi`-сессии “поиск работает, но блоков не видно”;
- больше не нужно проверять гипотезу про отсутствие самих `serverToolUse` / `webSearchResult` в session history;
- больше не нужно чинить импорт `timestamp.js` в compat-патче;
- больше не нужно считать текущую проблему unresolved на replay-path.

## Что не входит в следующий этап

- изменения upstream `gsd/pi`;
- расширение на `openai-codex-responses`;
- расширение на `azure-openai-responses`;
- synthetic citations;
- synthetic query labels;
- новые productized fallback modes сверх уже существующей безопасной деградации.

## Полезные файлы

- `index.js`
- `src/openai-native-search.js`
- `src/openai-search-display.js`
- `src/openai-responses-display-patch.js`
- `src/openai-interactive-search-order-patch.js`
- `src/openai-tool-execution-web-search-patch.js`
- `tests/openai-native-search.test.mjs`
- `README.md`
- `NEXT-STAGE-SCOPE.md`

## Что не делать

- не возвращаться к уже закрытой диагностике текущего UI-багa;
- не расползаться в upstream `pi`/`gsd`;
- не расширять scope на другие transports;
- не вводить truthfulness-компромиссы ради “красивого” UI;
- не считать временные compat-слои достаточно хорошими для бесконтрольного дальнейшего разрастания.
