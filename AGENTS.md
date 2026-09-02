# Repo guidance

## Что это за репозиторий
- `pi-openai-search` — extension только для standalone `pi`, который подключает нативный `web_search` для OpenAI Responses, OpenAI Codex Responses и явного CLIProxyAPI Codex Responses route.
- Главный инвариант: truthful UX. Показываем только реальные provider events и реальные structured sources, без synthetic fallback.

## Как ориентироваться
- Для текущего поведения и проверок сначала читай `README.md`, затем код в `index.js`, `src/`, `scripts/` и `tests/`.
- `PLANCC-CONTEXT.md` и `NEXT-STAGE-SCOPE.md`, если присутствуют, считай временными planning-заметками. Используй их только когда задача явно на них ссылается; не опирайся на них как на постоянный контракт репозитория.

## Scope и ограничения
- Базовые supported paths: `provider=openai` + `api=openai-responses`, `provider=openai-codex` + `api=openai-codex-responses` и `provider=cliproxyapi` + `api=cliproxyapi-codex-responses`, standalone `pi`.
- Не расширяй scope на upstream `pi`, другие transports и productized fallback-моды без прямого запроса.
- Не добавляй synthetic citations, synthetic query labels, prompt/text-derived search artifacts или мусорные URL.
- Если runtime path несовместим или ломается, деградация должна быть fail-open и с понятным user-facing warning.

## Ожидания от изменений
- Предпочитай минимальные точечные правки и сохраняй существующий стиль кода.
- При изменениях в compat/runtime-путях проверяй, что truthful проекция search events и sources не ломается, а negative path остаётся чистым.
- Не оставляй debug-логи, закомментированный код и временные костыли.

## Проверка результата
- После изменений в коде по умолчанию запускай `npm test`.
- Если меняется proof/runtime поведение, прогоняй релевантный smoke-check или proof script из `README.md` и `scripts/`.
- Перед завершением явно фиксируй: что изменено, чем проверено, есть ли оставшиеся риски.
