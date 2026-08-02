const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createConnection } = require("../server/db");
const { loadPosts, syncPublicChannelPosts } = require("../server/cli/import-public-channel");

function page(channel, ids, before) {
  const posts = ids.map((id) => `
    <div class="tgme_widget_message_wrap">
      <div data-post="${channel}/${id}">
        <div class="tgme_widget_message_text">Товар ${id} — ${id} USD</div>
        <time datetime="2026-08-02T00:00:00Z"></time>
      </div>
    </div>`).join("");
  return `${before ? `<a href="/s/${channel}?before=${before}">older</a>` : ""}${posts}`;
}

test("loadPosts follows before link even when a page has fewer than 20 text posts", async () => {
  const channel = "mostovoyshopp";
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const older = url.includes("before=81");
    return {
      ok: true,
      text: async () => older
        ? page(channel, [61, 62], null)
        : page(channel, Array.from({ length: 19 }, (_, index) => 81 + index), 81),
    };
  };

  const posts = await loadPosts(channel, 5, fetchImpl);

  assert.equal(urls.length, 2);
  assert.equal(posts.length, 21);
  assert.equal(posts[0].messageId, 61);
  assert.equal(posts.at(-1).messageId, 99);
});

test("syncPublicChannelPosts does not downgrade an unchanged parsed post", async () => {
  const db = createConnection(":memory:");
  const text = "iPhone 17 — 100 000 сом";
  db.prepare(`INSERT INTO telegram_messages
    (telegram_chat_id, telegram_message_id, telegram_original_text, telegram_text_hash, last_sync_status)
    VALUES (?, ?, ?, ?, 'ok')`).run("-1001", 10, text, crypto.createHash("sha256").update(text).digest("hex"));
  const fetchImpl = async () => ({
    ok: true,
    text: async () => page("shop", [10], null).replace("Товар 10 — 10 USD", text),
  });

  await syncPublicChannelPosts({ db, channel: "shop", channelId: "-1001", fetchImpl });

  assert.equal(db.prepare("SELECT last_sync_status FROM telegram_messages WHERE telegram_message_id = 10").get().last_sync_status, "ok");
  db.close();
});
