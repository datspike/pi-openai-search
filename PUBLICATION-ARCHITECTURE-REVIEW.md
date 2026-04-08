# Архитектурная оценка `pi-openai-search` перед публикацией

## Короткий вывод

Как локальное точечное решение для `standalone pi + openai-responses` расширение уже выглядит зрелым: есть узкий scope, зафиксированный support contract, сильная truthful-policy, хороший тестовый контур, `npm test` и `npm run test:compat-smoke` сейчас зелёные.

Как публикуемое расширение для Pi-экосистемы оно пока выглядит не как обычный ecosystem-friendly extension, а как version-pinned compat overlay над внутренностями Pi. Это не делает проект плохим, но делает его дорогим в сопровождении и потенциально хрупким при обновлениях Pi.

## Что уже хорошо

- Архитектурно есть правильное разделение на stable `core` и risky `compat`: `README.md`, `docs/architecture.md`, `src/core/contracts/architecture.js`.
- `index.js` действительно тонкий и не тащит лишнюю orchestration-логику: `index.js`.
- Truthful UX сформулирован жёстко и последовательно, без synthetic fallback. Это сильный differentiator перед публикацией: `src/core/truthful/search-results.js`, `README.md`.
- Для узкого supported path решение оправдано именно как extension, а не skill. Это совпадает с логикой `extending-pi`: если нужны event hooks, runtime behavior и UI rendering, нужен extension, не skill.
- По формату package это валидно для Pi: официальный docs допускает `package.json` с `pi.extensions`, а не только `manifest.json`.

## Главные архитектурные проблемы

### 1. Основной риск поддержки сидит не в core, а в private compat

Самая дорогая часть проекта живёт в `src/compat` и зависит от private runtime layout Pi:

- импорт по путям вида `dist/modes/...` и `node_modules/@mariozechner/pi-ai/dist/...`
- monkey-patch interactive components: `src/compat/interactive/search-order-patch.js`, `src/compat/interactive/tool-execution-web-search-patch.js`
- patched provider stream поверх runtime internals: `src/compat/provider/openai-responses-stream.js`, `src/compat/provider/openai-responses-search-mapper.js`

Это не "чуть-чуть compat", это фактически отдельный адаптационный слой к приватным seam'ам Pi. Для публикации это главный maintenance liability.

### 2. Есть явный признак overengineering: три уровня продукта внутри одного пакета

Сейчас в одном репозитории смешаны три вещи:

- stable payload injector
- provider override / stream mapper
- interactive renderer patches

Это три разных класса риска и жизненного цикла, но они публикуются как один artifact. Из-за этого даже "просто включить native web_search" тянет за собой сложный bootstrap, capability registry и несколько experimental flags: `src/compat/bootstrap.js`, `src/compat/runtime/pi-compat-capabilities.js`.

Для узкой задачи это уже заметно тяжелее, чем нужно.

### 3. Даже public-path не полностью public

В `src/compat/provider/openai-responses-provider.js` public `pi.registerProvider()` есть, но активация всё равно всегда делает private patch через `registerApiProvider()`. То есть архитектура не "public API first, private fallback", а скорее "public + private patch together".

Это важный smell. Если Pi поменяет внутреннюю provider plumbing, пакет может продолжить "частично работать", но именно UX-ценность сломается.

### 4. Runtime discovery слишком завязан на конкретный способ установки Pi

`resolvePiRuntimeDescriptor()` в `src/compat/runtime/pi-runtime.js` вычисляет root через npm-style глобальную установку `.../lib/node_modules/@mariozechner/pi-coding-agent`.

Это подходит для текущей машины, что подтвердил `compat-smoke`, но плохо масштабируется на другие инсталляции, packaging modes и будущие изменения layout.

### 5. Тестовый контур сильный, но частично дублирующийся

Сейчас примерно:

- source: 3505 LOC
- tests: 3635 LOC
- плюс огромный legacy-suite: `tests/openai-native-search.test.mjs`

И одновременно есть уже разнесённые suites в `tests/core`, `tests/compat`, `tests/contracts`, `tests/proof`.

Для публикации это уже похоже на переходное состояние. Поддерживать и legacy-монолит, и новые suites будет дорого.

## Насколько это "правильное расширение для Pi-экосистемы"

Ответ: частично да, частично нет.

### Да

- По назначению это extension, не skill.
- По упаковке через `package.json` и `pi.extensions` это валидно.
- По философии Pi `adapt pi to your workflows` такой пакет допустим.

### Нет, если смотреть как на обычный ecosystem extension

`extending-pi` и официальные docs по духу ведут к extension'ам, которые живут на публичном API Pi. Ваш пакет строит ценность в основном на приватных seam'ах Pi runtime. Значит, по сути это:

- либо experimental extension
- либо compat package
- либо version-scoped addon

Но не "обычное расширение, которое просто добавляет capability".

Для публикации это надо назвать честно. И это даже в духе вашего truthful UX.

## Что бы я считал blockers перед публикацией

- В `package.json` стоит `"private": true`.
- Нет `pi-package` в `keywords`, хотя для discoverability Pi package gallery это ожидаемо.
- Нет `LICENSE` в корне репо.
- README пока больше описывает локальный запуск через `--extension`, чем установку как публикуемого Pi package.
- Нет явного позиционирования: `core-safe by default` vs `compat-enhanced experimental`.

## Варианты улучшения

### Вариант A. Лучший для публикации: split на base package и compat package

Разделить на два пакета:

- `pi-openai-search-core`
  - только `before_provider_request`
  - truthful citations/status на публичных hooks
  - никаких private imports
- `pi-openai-search-compat`
  - provider override
  - interactive patches
  - baseline/version matrix
  - experimental badge

Плюсы:

- резко падает maintenance surface
- публикация становится честной
- пользователи сами выбирают риск

Минус:

- два пакета и больше release management

Это мой предпочтительный вариант.

### Вариант B. Один пакет, но compat выключен по умолчанию

Оставить монолит, но:

- default path = только core
- compat включается явным env/profile
- README и package description прямо говорят: `public-safe core, optional experimental compat`

Это хуже, чем split, но уже сильно лучше текущего положения.

### Вариант C. Оставить всё как есть, но жёстко сузить обещания

Если не хотите split:

- позиционировать пакет как `standalone pi 0.65.x experimental compat extension for OpenAI native web_search`
- обещать поддержку только baseline + smoke check
- не делать вид, что это общий Pi ecosystem extension

Это честный вариант, но он хуже для adoption.

## Что я бы упростил в коде

### 1. Убрал бы private `registerApiProvider` fallback

Если public `pi.registerProvider()` недостаточен, это уже сигнал, что compat-слой слишком глубоко лезет в internals. Для публикации лучше:

- либо только public provider override
- либо отдельный experimental package

Текущий hybrid-path слишком дорогой.

### 2. Сжал бы compat feature model

Сейчас три feature flag:

- `provider-compat`
- `interactive-inline`
- `tool-render`

Практически это можно свернуть до двух уровней:

- `provider-compat`
- `ui-compat`

`tool-render` и `interactive-inline` слишком тесно связаны, чтобы оправдывать отдельный publication-facing surface.

### 3. Упростил бы bootstrap lifecycle

`bootstrapCompatRuntime()` в `src/compat/bootstrap.js` сейчас аккуратный, но тяжёлый для задачи. Для publication UX проще модель:

- core регистрируется всегда
- compat активируется лениво при первом `model_select` для `openai-responses`
- UI patches вообще не грузятся в `print/json` режимах

### 4. Убрал бы legacy test monolith после переноса покрытия

Если разнесённые suites уже покрывают актуальный контракт, `tests/openai-native-search.test.mjs` стоит либо удалить, либо сократить до smoke/regression-only.

## Что я бы улучшил в package/release слое

В `package.json`:

- убрать `"private": true`
- добавить `"keywords": ["pi-package", "pi", "extension", "openai", "web-search"]`
- добавить явные publication metadata
- добавить минимальную версионную политику совместимости в README

В репо:

- добавить `LICENSE`
- добавить раздел `Installation` в стиле `pi install git:...`
- добавить таблицу:
  - what works on public hooks
  - what depends on private seams
  - what degrades when Pi changes

## Моя итоговая рекомендация

Если цель именно публикация, я бы не публиковал текущий монолит без переразделения ответственности.

Наилучший следующий шаг:

1. Зафиксировать package positioning.
2. Вынести core в `safe default`.
3. Отделить compat в отдельный optional слой или отдельный пакет.
4. Почистить release metadata.
5. Убрать дублирующий legacy test suite.

Практически:

- как инженерное решение проект уже сильный;
- как publishable Pi package он пока слишком завязан на private Pi internals;
- как experimental compat package он уже почти готов.

## Что было проверено

- `npm test` -> зелёный
- `npm run test:compat-smoke` -> зелёный, detected `pi 0.65.0`, все 3 compat features `supported`

## Использованные источники

- локальный код и документация репозитория
- cloned reference skill: `https://github.com/tmustier/pi-extensions/tree/main/extending-pi`
- официальные docs Pi:
  - `docs/extensions.md`
  - `docs/packages.md`
