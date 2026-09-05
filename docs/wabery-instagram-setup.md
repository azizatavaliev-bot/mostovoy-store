# Instagram через Wabery — настройка

Проще, чем прямой Meta API: Wabery уже прошли Meta App Review своим
приложением, тебе не нужен собственный Meta App, App Review или Business
Verification. Всё подключение — в их дашборде через "Sign in with Facebook".

## 1. Аккаунт и Instagram-канал

1. Зарегистрируйся на [wabery.com](https://wabery.com).
2. В дашборде: **Connect Instagram** → войти в тот аккаунт Facebook, который
   управляет Страницей, привязанной к вашему Instagram Business/Creator
   аккаунту → выбрать нужную Страницу → разрешить запрошенные права.
3. После подключения у канала появится `channel_id` (вида `channel_...`) —
   он понадобится в переменных окружения.

## 2. API-ключ

1. В дашборде Wabery: Settings → API Keys → создать ключ.
2. Нужен **секретный** ключ (`wab_live_...`), не публикуемый (`wab_pub_...`) — публикуемый только для клиентского кода в браузере, серверу он не подходит.

## 3. Вебхук

1. В настройках проекта Wabery указать наш webhook URL:
   ```
   https://<ваш-домен>/api/webhooks/wabery
   ```
2. Wabery сгенерирует **webhook signing secret** — сохранить его, он пойдёт
   в `WABERY_WEBHOOK_SECRET`.
3. После сохранения Wabery сам пришлёт подписанный тестовый `message.received` — если сервер уже задеплоен с переменными ниже, он ответит 200 автоматически.

## 4. Переменные окружения (Railway)

```
WABERY_API_KEY=wab_live_...
WABERY_WEBHOOK_SECRET=<секрет из шага 3>
WABERY_INSTAGRAM_CHANNEL_ID=channel_...
```

(`WABERY_API_BASE_URL` не нужен — по умолчанию `https://api.wabery.com/v1`, менять только если Wabery сами скажут иначе.)

## 5. Проверка

1. Написать боту в Instagram Direct с тестового аккаунта.
2. Проверить логи бота (`GET /api/admin/crm/developer/events`) — должно
   появиться событие `inbox.message.received` с `Instagram (Wabery)`.
3. Бот должен ответить тем же путём, что и в Telegram/WhatsApp — шаблоны,
   ИИ, дожим, всё как обычно, канал для него прозрачен.

## Что уже готово в коде

- [server/services/wabery.js](../server/services/wabery.js) — отправка сообщений, проверка подписи вебхука
- [server/routes/wabery-webhook.js](../server/routes/wabery-webhook.js) — приём вебхука
- `crm.receiveWabery()` / `_send()` в [server/services/crm.js](../server/services/crm.js) — сообщения идут в тот же общий пайплайн бота, что и остальные каналы

Ничего больше в коде делать не нужно — только завести аккаунт и переменные окружения выше.
