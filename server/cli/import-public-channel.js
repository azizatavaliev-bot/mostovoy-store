// Первичный импорт публичной ленты Telegram в каталог.
// Bot API не отдаёт историю канала, поэтому читаем публичную витрину t.me/s.
// После импорта обычный webhook продолжает обновлять новые и изменённые посты.
//
// npm run import-channel -- --all
// npm run import-channel -- --max-pages 5
const crypto = require("crypto");
const config = require("../config");
const { getDb, closeDb } = require("../db");

const PAGE_SIZE = 20;

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim();
}

function parsePosts(html, channel) {
  return String(html || "")
    .split('<div class="tgme_widget_message_wrap')
    .slice(1)
    .map((chunk) => {
      const post = chunk.match(new RegExp(`data-post="${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d+)"`));
      const text = chunk.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
      const date = chunk.match(/<time[^>]+datetime="([^"]+)"/i);
      if (!post || !text) return null;
      return { messageId: Number(post[1]), text: decodeHtml(text[1]), updatedAt: date?.[1] || new Date().toISOString() };
    })
    .filter((post) => post?.text);
}

function args(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : Number(argv[index + 1]) || fallback;
  };
  return { maxPages: argv.includes("--all") ? Infinity : value("--max-pages", 1) };
}

async function loadPosts(channel, maxPages, fetchImpl = globalThis.fetch) {
  const posts = new Map();
  let before = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ""}`;
    const response = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 MostovoyCatalogSync/1.0" } });
    if (!response.ok) throw new Error(`Не удалось открыть публичный канал: HTTP ${response.status}`);
    const html = await response.text();
    const pagePosts = parsePosts(html, channel);
    for (const post of pagePosts) posts.set(post.messageId, post);
    const next = html.match(new RegExp(`/s/${channel}\\?before=(\\d+)`));
    // В публичной ленте первая страница нередко содержит 18–19 текстовых
    // публикаций (например, из-за поста только с медиа). Наличие ссылки
    // `before` — единственный надёжный признак, что история продолжается.
    if (!next || Number(next[1]) === before) break;
    before = Number(next[1]);
  }
  return [...posts.values()].sort((a, b) => a.messageId - b.messageId);
}

// Сначала читаем сам публичный канал, сохраняем исходные сообщения в базу,
// затем консультант ищет по этой локальной копии. Никакая модель ИИ не
// извлекает и не пересказывает цены до подбора товара.
async function syncPublicChannelPosts({
  db,
  channel = config.contact.channel,
  channelId = config.telegram.channelId,
  maxPages = 1,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!channel) throw new Error("TELEGRAM_CHANNEL_USERNAME не задан");
  if (!channelId) throw new Error("TELEGRAM_CHANNEL_ID не задан");
  const posts = await loadPosts(channel, maxPages, fetchImpl);
  const save = db.prepare(
    `INSERT INTO telegram_messages
       (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status, last_synced_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, 'raw', datetime('now'), 0)
     ON CONFLICT(telegram_chat_id, telegram_message_id) DO UPDATE SET
       telegram_message_updated_at = excluded.telegram_message_updated_at,
       telegram_original_text = excluded.telegram_original_text,
       telegram_text_hash = excluded.telegram_text_hash,
       last_sync_status = CASE
         WHEN telegram_messages.telegram_text_hash = excluded.telegram_text_hash
          AND telegram_messages.last_sync_status = 'ok'
         THEN 'ok'
         ELSE 'raw'
       END,
       last_sync_error = CASE
         WHEN telegram_messages.telegram_text_hash = excluded.telegram_text_hash
          AND telegram_messages.last_sync_status = 'ok'
         THEN telegram_messages.last_sync_error
         ELSE NULL
       END,
       last_synced_at = datetime('now'), is_deleted = 0, updated_at = datetime('now')`
  );
  for (const post of posts) {
    save.run(String(channelId), post.messageId, post.updatedAt, post.text,
      crypto.createHash("sha256").update(post.text).digest("hex"));
  }
  return { channel, found: posts.length, saved: posts.length };
}

async function main() {
  const { maxPages } = args(process.argv.slice(2));
  const db = getDb();
  const result = await syncPublicChannelPosts({ db, maxPages });
  console.log(JSON.stringify(result));
  closeDb();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    closeDb();
    process.exit(1);
  });
}

module.exports = { decodeHtml, parsePosts, loadPosts, syncPublicChannelPosts };
