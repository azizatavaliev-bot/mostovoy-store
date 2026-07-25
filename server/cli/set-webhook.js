// Регистрация webhook в Telegram.
//
//   npm run set-webhook -- --url https://ваш-домен/api/telegram/webhook
//   npm run set-webhook -- --info      показать текущее состояние
//   npm run set-webhook -- --delete    снять webhook
//
// URL можно не указывать, если задан PUBLIC_URL в .env.
const config = require("../config");

async function call(method, body) {
  const res = await fetch(`${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function main() {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? true;
  };

  if (argv.includes("--info")) {
    console.log(JSON.stringify(await call("getWebhookInfo"), null, 2));
    return;
  }
  if (argv.includes("--delete")) {
    console.log(JSON.stringify(await call("deleteWebhook", { drop_pending_updates: false }), null, 2));
    return;
  }

  const url = flag("--url") || (config.publicUrl ? `${config.publicUrl}/api/telegram/webhook` : null);
  if (!url) throw new Error("Укажите --url или задайте PUBLIC_URL в .env");
  if (!config.telegram.webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET не задан");

  const result = await call("setWebhook", {
    url,
    secret_token: config.telegram.webhookSecret,
    // Нужны только посты канала — лишние апдейты не запрашиваем.
    allowed_updates: ["channel_post", "edited_channel_post"],
    max_connections: 10,
  });
  console.log(JSON.stringify(result, null, 2));
  console.log(JSON.stringify(await call("getWebhookInfo"), null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
