# МОСТОВОЙ — контекст проекта

Интернет-витрина магазина техники в Бишкеке. На сайте есть каталог и карточки
товаров, корзина с переходом в WhatsApp, новости, trade-in, рассрочка и админка
с товарами, CRM-диалогами, ответами бота, аналитикой и инструментами разработчика.

## Архитектура

- Backend: Node.js 22+, Express, SQLite (`node:sqlite`).
- Frontend: TypeScript + Vite без UI-фреймворка; страницы находятся в
  `frontend/*.html`, логика и общие стили — в `frontend/src/`.
- Production frontend размещён на Vercel: `https://mostovoy.vercel.app`.
- API и загруженные файлы работают на Railway. Правила проксирования описаны в
  `vercel.json`; конфигурация backend-деплоя — в `railway.json`.
- Постоянные данные хранятся в SQLite. Миграции находятся в
  `server/db/migrations.js`; на Railway база и uploads должны быть на Volume.

## Основные потоки

- Telegram-пост или его изменение → webhook → SQLite-очередь → AI-разбор →
  проверка цены → сопоставление товара → обновление каталога.
- Публичный каталог читает `/api/catalog`; страница товара —
  `/api/products/:slug`.
- Нажатие «Купить» формирует готовое сообщение для WhatsApp и записывает событие
  в аналитику через `/api/analytics/buy-click`.
- CRM объединяет Telegram, WhatsApp/Instagram через amoCRM webhook и Azis CRM.
  Бот видит каталог, поддерживает изображения и аудио, а гипервизор используется
  только для краткого пересказа контекста диалога.
- Админка рассчитана на одну учётную запись владельца, без ролей.

## Где искать код

- `server/app.js` — сборка приложения и подключение маршрутов.
- `server/routes/` — HTTP API; `server/services/` — бизнес-логика.
- `server/services/sync.js` — синхронизация каталога из Telegram.
- `server/services/crm.js` и `server/prompts.js` — бот, CRM и промпты.
- `frontend/src/admin-page.ts` — интерфейс админки и демо-аналитика.
- `frontend/src/catalog.ts`, `render.ts`, `product-page.ts` — витрина и покупка.
- `frontend/src/styles.css` — стили всех публичных и административных страниц.
- `test/` — backend и интеграционные тесты.

## Команды и правила

```bash
npm run dev                 # backend + Vite
npm run build               # production-сборка frontend
npm test                    # полный набор тестов
npm run migrate             # применить миграции
```

Перед изменениями сохраняйте совместимость с Telegram-синхронизацией и ручным
редактированием из админки. Не храните секреты в коде и не коммитьте `.env` или
SQLite-базу. Делайте точечные изменения, запускайте сборку и полный набор тестов.
