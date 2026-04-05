# Scope следующего этапа

Следующий этап работ ограничен интеграцией `openai/openai-responses` в standalone `pi`.

Что входит в scope:
- сужение и стабилизация локальных compat-слоёв extension;
- truthful `serverToolUse` / `webSearchResult`;
- payload/provider/interactive fallback внутри самого extension;
- дальнейшее упрощение `pi-only` runtime seam при необходимости.

Что не входит в scope:
- изменения upstream `pi`;
- расширение на `openai-codex-responses`;
- расширение на `azure-openai-responses`;
- synthetic citations, synthetic query labels и другие truthfulness-компромиссы.

Если совместимость с установленным runtime частично расходится, extension должен:
- сначала пробовать работу;
- при проблемах деградировать безопасно;
- показывать пользователю понятное сообщение в UI, а не падать молча.
