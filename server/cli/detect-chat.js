// Определяет ID канала/группы, куда добавлен бот.
//
//   npm run detect-chat
//
// Скрипт опрашивает getUpdates и печатает все чаты, которые видит бот.
// Работает только пока НЕ зарегистрирован webhook (они взаимоисключающи),
// поэтому порядок такой: добавить бота в канал → detect-chat → set-webhook.
const config = require("../config");

const WAIT_SECONDS = Number(process.argv[2]) || 60;

// Long polling рвётся сам по себе (прокси, сон ноутбука, таймаут сети),
// поэтому запрос всегда с собственным таймаутом, а обрыв — не фатальная ошибка.
async function call(method, params = {}, { timeoutMs = 30000 } = {}) {
  const url = new URL(`${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function describe(update) {
  const kind = Object.keys(update).find((k) => k !== "update_id");
  const payload = update[kind] || {};
  const chat = payload.chat || payload.from || {};
  return { kind, chat, text: payload.text || payload.caption || "" };
}

async function main() {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан в .env");

  const me = await call("getMe");
  if (!me.ok) throw new Error(`Токен не принят: ${me.description}`);
  console.log(`Бот: @${me.result.username} (${me.result.first_name})`);

  const hook = await call("getWebhookInfo");
  if (hook.result?.url) {
    console.log(`\n⚠ Уже зарегистрирован webhook: ${hook.result.url}`);
    console.log("getUpdates при активном webhook не работает. Снимите его:");
    console.log("  npm run set-webhook -- --delete");
    return;
  }

  console.log(`\nЖду события ${WAIT_SECONDS} с. Сейчас:`);
  console.log("  1. Добавьте бота администратором канала");
  console.log("  2. Опубликуйте в канале любой пост\n");

  const seen = new Map();
  const until = Date.now() + WAIT_SECONDS * 1000;
  let offset;

  let hiccups = 0;
  while (Date.now() < until) {
    let upd;
    try {
      upd = await call(
        "getUpdates",
        {
          timeout: 10,
          offset,
          allowed_updates: ["channel_post", "edited_channel_post", "message", "my_chat_member"],
        },
        { timeoutMs: 20000 }
      );
    } catch (e) {
      // Обрыв длинного запроса — обычное дело, просто пробуем снова.
      if (++hiccups % 5 === 0) console.log(`  (сеть: ${e.message}, продолжаю ждать)`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!upd.ok) {
      console.log(`  (Telegram: ${upd.description})`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of upd.result || []) {
      offset = u.update_id + 1;
      const { kind, chat, text } = describe(u);
      if (!chat.id) continue;
      if (!seen.has(chat.id)) {
        seen.set(chat.id, chat);
        console.log(`✓ ${chat.type || "?"} «${chat.title || chat.username || chat.id}» → id ${chat.id}`);
        if (text) console.log(`  текст: ${text.slice(0, 70).replace(/\n/g, " ⏎ ")}…`);
        console.log(`  событие: ${kind}`);
      }
    }
    if (seen.size) break;
  }

  if (!seen.size) {
    console.log("\nНичего не пришло. Проверьте, что бот именно АДМИНИСТРАТОР канала,");
    console.log("и что после добавления в канале был опубликован новый пост.");
    return;
  }

  const [id, chat] = [...seen.entries()][0];
  console.log(`\nВпишите в .env:\n  TELEGRAM_CHANNEL_ID=${id}`);
  if (chat.type && chat.type !== "channel") {
    console.log(`\n⚠ Это «${chat.type}», а не channel. Сервис слушает channel_post,`);
    console.log("  то есть рассчитан на КАНАЛ. Для группы нужна доработка обработчика.");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
