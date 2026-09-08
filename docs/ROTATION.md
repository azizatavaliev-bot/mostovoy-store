# Ротация межсервисных секретов

Как поменять любой из статических секретов ниже без даунтайма — окно между
шагами 1 и 3 может быть сколько угодно большим (хоть неделю), сервис всё
время принимает оба значения.

## Какие секреты это поддерживают

| Секрет (env) | Где проверяется | Кто отправляет |
|---|---|---|
| `ADMIN_TOKEN` / `ADMIN_TOKEN_NEXT` | `server/routes/admin.js` | вы сами (терминал/скрипты) |
| `TELEGRAM_WEBHOOK_SECRET` / `_NEXT` | `server/routes/telegram.js` | Telegram (`npm run set-webhook` прописывает секрет в Telegram) |
| `AMOCRM_WEBHOOK_SECRET` / `_NEXT` | `server/routes/amocrm.js` | amoCRM/интеграция |
| `GREENAPI_WEBHOOK_TOKEN` / `_NEXT` | `server/routes/greenapi.js` | Green API (задаётся в настройках инстанса) |
| `AZIS_CRM_INTEGRATION_SECRET` / `_NEXT` | `server/routes/azis-crm.js` | Azis CRM |
| `WABERY_WEBHOOK_SECRET` / `_NEXT` | `server/services/wabery.js` | Wabery (дашборд вебхука) |
| `META_APP_SECRET` / `META_APP_SECRET_NEXT` | `server/services/instagram-graph.js` (только подпись вебхука) | Meta |
| `META_WEBHOOK_VERIFY_TOKEN` / `_NEXT` | `server/services/instagram-graph.js` (подписка на вебхук) | Meta (одноразовая проверка при настройке) |

`CRM_INTERNAL_TOKEN` в ротацию не входит — этот сервис его только
**отправляет** во внешнюю CRM, не проверяет входящие запросы; ротацию для
него нужно делать на стороне той CRM, где он проверяется.

Логика — `server/lib/token-rotation.js` (`matchesCurrentOrNext` для
заголовков-токенов, `matchesHmacCurrentOrNext` для HMAC-подписей). Все
сравнения constant-time (`crypto.timingSafeEqual`), как и раньше.

## Порядок действий (< 10 минут, без даунтайма)

Пример для `GREENAPI_WEBHOOK_TOKEN` — для остальных секретов из таблицы
выше шаги идентичны, только имена переменных другие.

1. **Добавить NEXT на приёмнике** (мы — тот, кто проверяет секрет):
   - Сгенерировать новое значение: `openssl rand -hex 32`.
   - Задать `GREENAPI_WEBHOOK_TOKEN_NEXT=<новое значение>` в Railway → Variables.
   - Деплой. С этого момента сервис принимает и старое, и новое значение.
2. **Переключить отправителя** на новое значение:
   - В консоли/дашборде отправителя (Green API, amoCRM, Wabery, Meta и т.п.)
     заменить настроенный секрет на то же новое значение.
   - Для `ADMIN_TOKEN` — просто начать использовать новое значение в своих
     скриптах/curl-командах.
3. **Убрать старое значение**:
   - `GREENAPI_WEBHOOK_TOKEN=<то же новое значение, что было в NEXT>`.
   - Удалить переменную `GREENAPI_WEBHOOK_TOKEN_NEXT` (или оставить пустой).
   - Деплой.

Если что-то пошло не так между шагами 2 и 3 — можно откатить отправителя
обратно на старое значение, оно всё ещё принимается (NEXT ещё не убран).

## META_APP_SECRET — отдельное уточнение

`META_APP_SECRET_NEXT` работает только для проверки подписи вебхука
(`X-Hub-Signature-256`). Обмен OAuth-токена (подключение Instagram) всегда
идёт по основному `META_APP_SECRET` — Meta не поддерживает два одновременно
действующих App Secret для этой операции. Если вы сбрасываете App Secret в
Meta Developers, окно между сбросом и обновлением `META_APP_SECRET` в
Railway разорвёт OAuth-подключение (но не входящие вебхуки, если успели
заранее прописать `_NEXT`).
