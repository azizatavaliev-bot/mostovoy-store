// Ручная повторная синхронизация.
//
//   npm run resync -- --all              все сохранённые публикации
//   npm run resync -- --message 1234     одну публикацию по telegram_message_id
//   npm run resync -- --file post.txt    текст из файла (для отладки без Telegram)
//   npm run resync -- --stdin            текст из stdin
//
// --force игнорирует совпадение хеша и обрабатывает пост заново.
const fs = require("fs");
const config = require("../config");
const { getDb, closeDb } = require("../db");
const { DeepSeekClient } = require("../services/deepseek");
const { ProductResearchService } = require("../services/research");
const { createResearchProvider } = require("../services/research/providers");
const { SyncService } = require("../services/sync");

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--force") args.force = true;
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--message") args.message = Number(argv[++i]);
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--chat") args.chat = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const deepseek = new DeepSeekClient();
  const research = new ProductResearchService({ provider: createResearchProvider(), deepseek, db });
  const sync = new SyncService({ db, deepseek, research });

  let jobs = [];

  if (args.file || args.stdin) {
    const text = args.file
      ? fs.readFileSync(args.file, "utf8")
      : fs.readFileSync(0, "utf8");
    jobs = [
      {
        chatId: args.chat || config.telegram.channelId || "manual",
        messageId: args.message || Math.floor(Date.now() / 1000),
        text,
        messageUpdatedAt: new Date().toISOString(),
        force: true,
      },
    ];
  } else if (args.message) {
    const row = db
      .prepare("SELECT * FROM telegram_messages WHERE telegram_message_id = ?")
      .get(args.message);
    if (!row) throw new Error(`Публикация ${args.message} не найдена в базе`);
    jobs = [rowToJob(row, args.force)];
  } else if (args.all) {
    jobs = db
      .prepare("SELECT * FROM telegram_messages WHERE is_deleted = 0 ORDER BY id")
      .all()
      .map((r) => rowToJob(r, args.force));
  } else {
    console.log("Укажите --all, --message <id>, --file <путь> или --stdin");
    closeDb();
    return;
  }

  for (const job of jobs) {
    try {
      const result = await sync.syncMessage(job);
      console.log(
        `[${job.messageId}] ${result.status}: создано ${result.created ?? 0}, обновлено ${result.updated ?? 0}, ` +
          `снято ${result.deactivated ?? 0}, needs_research ${result.needsResearch ?? 0}`
      );
    } catch (e) {
      console.error(`[${job.messageId}] ошибка: ${e.message}`);
    }
  }
  closeDb();
}

function rowToJob(row, force) {
  return {
    chatId: row.telegram_chat_id,
    messageId: row.telegram_message_id,
    text: row.telegram_original_text,
    messageUpdatedAt: row.telegram_message_updated_at,
    force,
  };
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
