// Кэш результата анализа Story/Highlight — на SQLite (в проекте нет Redis,
// остальной кэш/состояние тоже живёт в той же базе, см. server/db). Ключ —
// cacheKey из parser.js ("instagram_story:<id>" / "instagram_highlight:<id>").
class StoryCache {
  constructor({ db, now } = {}) {
    this.db = db;
    this._now = now || (() => new Date());
  }

  get(cacheKey) {
    const row = this.db.prepare(
      "SELECT payload, expires_at FROM instagram_story_cache WHERE cache_key = ?"
    ).get(cacheKey);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= this._now().getTime()) {
      // Протухшую запись не отдаём и подчищаем сразу — не обязательно, но
      // не даём таблице расти вхолостую при активном использовании.
      this.db.prepare("DELETE FROM instagram_story_cache WHERE cache_key = ?").run(cacheKey);
      return null;
    }
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  }

  set(cacheKey, payload, ttlHours) {
    const expiresAt = new Date(this._now().getTime() + ttlHours * 60 * 60 * 1000).toISOString();
    this.db.prepare(
      `INSERT INTO instagram_story_cache (cache_key, payload, created_at, expires_at)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`
    ).run(cacheKey, JSON.stringify(payload), expiresAt);
  }
}

module.exports = { StoryCache };
