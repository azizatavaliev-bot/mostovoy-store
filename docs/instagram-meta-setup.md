# Instagram Direct — настройка в Meta Developers

Это инструкция для владельца магазина (тебя), не для разработчика — что нужно
сделать один раз в личном кабинете Meta, чтобы бот смог подключаться к
Instagram обычной кнопкой «Подключить».

Использован официальный поток **"Instagram API with Instagram Login"** (он
же Business Login) — без обязательной привязки Facebook-страницы.

## 1. Создать приложение Meta

1. Зайти на [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**.
2. Тип приложения — **Business**.
3. В настройках приложения добавить продукт **Instagram** (не «Facebook Login», не «Messenger» — именно Instagram → Instagram API setup with Instagram Login).

## 2. Настроить OAuth

1. В разделе Instagram → API setup with Instagram Login найти **Business Login settings**.
2. Указать **OAuth Redirect URI** — точный адрес, куда Meta пришлёт код после авторизации:
   ```
   https://<ваш-домен>/api/admin/crm/instagram/callback
   ```
   Подставь реальный домен бэкенда (Railway-домен или mostovoy.kg, смотря куда в итоге указывает прод).
3. Сохранить **App ID** и **App Secret** — они пойдут в переменные окружения (см. ниже).

## 3. Permissions (права доступа)

| Permission | Зачем | Обязателен |
|---|---|---|
| `instagram_business_basic` | Базовый доступ к профилю подключённого аккаунта (username, id) | Да |
| `instagram_business_manage_messages` | Чтение и отправка Direct-сообщений — без этого бот не сможет ни получать, ни отвечать | Да |

Больше ничего не запрашивать — права на публикацию постов, комментарии и
т.п. этому боту не нужны, а лишний scope — это лишний пункт в App Review.

## 4. Webhook

1. В том же разделе Instagram → Webhooks указать:
   - **Callback URL**: `https://<ваш-домен>/api/webhooks/instagram`
   - **Verify Token**: любая случайная строка — та же самая, что пойдёт в `META_WEBHOOK_VERIFY_TOKEN` (см. ниже).
2. Подписаться на поле **messages** (события входящих Direct-сообщений). Больше поля не нужны.
3. Meta сразу проверит webhook GET-запросом — если сервер уже задеплоен с этими переменными окружения, проверка пройдёт автоматически.

## 5. Требуемые переменные окружения (Railway)

```
META_APP_ID=<App ID из шага 2>
META_APP_SECRET=<App Secret из шага 2>
META_REDIRECT_URI=https://<ваш-домен>/api/admin/crm/instagram/callback
META_WEBHOOK_VERIFY_TOKEN=<та же строка, что в шаге 4>
META_TOKEN_ENCRYPTION_KEY=<32 случайных байта в hex — см. ниже>
```

Сгенерировать `META_TOKEN_ENCRYPTION_KEY` (выполнить один раз, сохранить, никогда не менять после первого подключения — иначе сохранённый токен станет нечитаемым):

```bash
openssl rand -hex 32
```

## 6. Тестовые аккаунты (до App Review)

Пока приложение в режиме **Development**, подключаться могут только
аккаунты, добавленные как **Instagram Testers**:

1. Meta Developers → App roles → Roles → **Add Instagram Testers**.
2. Указать username тестового Instagram-аккаунта (обычный Professional/Business или Creator аккаунт).
3. Владелец тестового аккаунта должен зайти в Instagram → Настройки → Приложения и веб-сайты → Приглашения из Tester и принять приглашение.
4. После этого именно этим аккаунтом можно проходить `/connect` на сайте и проверять весь поток целиком.

## 7. Вывод из Development Mode (запуск для реальных клиентов)

1. App Review → запросить permission `instagram_business_manage_messages` (и `instagram_business_basic`, если Meta потребует отдельно).
2. Для App Review потребуется:
   - **Privacy Policy URL** — публичная страница на сайте.
   - **Terms of Service URL** — публичная страница на сайте.
   - **Data Deletion** — либо callback URL, либо инструкция для пользователя, как удалить свои данные (текстом на странице приватности достаточно, если callback не реализован).
3. **Business Verification** — Meta почти всегда требует подтвердить бизнес (юр. лицо/ИП, документы) прежде чем одобрить `instagram_business_manage_messages` для чужих аккаунтов, не только тестовых.

### Что обычно просит Meta reviewer

Скринкаст или пошаговая инструкция, показывающая:

1. Открыть сайт/админку.
2. Войти в тестовый аккаунт.
3. Перейти в раздел с Instagram-интеграцией.
4. Нажать «Подключить Instagram».
5. Авторизоваться через Instagram (реальный экран Meta OAuth).
6. Разрешить запрошенные права.
7. Со стороны тестового Instagram-аккаунта отправить сообщение в Direct боту.
8. Показать, что сообщение появилось в CRM/логах бота.
9. Отправить ответ из CRM (или дождаться автоответа бота).
10. Показать, что ответ пришёл в Instagram Direct.

Для этого Meta обычно просит **отдельный тестовый Instagram-аккаунт**,
который они смогут использовать сами, если видео недостаточно.

## 8. Локальная разработка

Webhook не будет работать на `localhost` — Meta шлёт запросы на публичный
HTTPS-адрес. Для локальной проверки нужен туннель (ngrok, Cloudflare Tunnel
или аналог — на выбор, жёсткой привязки к конкретному провайдеру в коде нет).

Пример с ngrok:

```bash
ngrok http 3000
```

Затем временно, только для локальной сессии:

```
META_REDIRECT_URI=https://<ngrok-домен>/api/admin/crm/instagram/callback
```

и в Meta Developers → webhook Callback URL — на `https://<ngrok-домен>/api/webhooks/instagram`. После теста вернуть боевые значения обратно (ngrok-домен меняется при каждом перезапуске бесплатного тоннеля).

## 9. Production-чеклист

- [ ] `META_APP_ID` / `META_APP_SECRET` / `META_REDIRECT_URI` / `META_WEBHOOK_VERIFY_TOKEN` / `META_TOKEN_ENCRYPTION_KEY` заданы в Railway
- [ ] OAuth Redirect URI в Meta Developers совпадает с `META_REDIRECT_URI` **точь-в-точь** (включая `https://` и без завершающего слэша)
- [ ] Webhook Callback URL подписан на поле `messages`
- [ ] App Review пройден для `instagram_business_manage_messages`
- [ ] Business Verification пройдена (если Meta её требует для этого приложения)
- [ ] Опубликованы страницы Privacy Policy и Terms of Service
- [ ] `ADMIN_TOKEN` или логин/пароль админки настроены — `/api/admin/crm/instagram/*` защищены ими
