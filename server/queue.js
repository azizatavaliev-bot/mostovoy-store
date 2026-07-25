// Очередь фоновой синхронизации.
//
// Вебхук обязан ответить Telegram быстро, поэтому он только кладёт задачу сюда
// и сразу отвечает 200. Тяжёлое (DeepSeek, веб-поиск, проверка картинок)
// выполняется воркером отдельно.
//
// Очередь живёт в SQLite, поэтому переживает рестарт. Расчёт на ОДИН процесс:
// блокировка сообщения — внутрипроцессная. Для нескольких инстансов
// понадобится внешняя блокировка (см. README, раздел «Ограничения»).
const logger = require("./logger");

const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 120, 600];

// Один и тот же пост никогда не обрабатывается двумя задачами параллельно.
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  // .then(fn, fn) — следующая задача стартует и после успеха, и после падения предыдущей.
  const run = prev.then(fn, fn);
  // В карте держим «обезвреженную» цепочку, чтобы отказ не всплыл как unhandled.
  const chain = run.then(
    () => {},
    () => {}
  );
  locks.set(key, chain);
  chain.then(() => {
    if (locks.get(key) === chain) locks.delete(key);
  });
  return run;
}

class SyncQueue {
  constructor({ db, syncService, pollIntervalMs = 1000 }) {
    this.db = db;
    this.syncService = syncService;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.running = false;
    this.draining = false;
  }

  enqueue({ chatId, messageId, eventType, payload }) {
    this.db
      .prepare(
        `INSERT INTO sync_jobs (chat_id, message_id, event_type, payload, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(String(chatId), Number(messageId), eventType, JSON.stringify(payload));
    const id = this.db.prepare("SELECT last_insert_rowid() AS id").get().id;
    logger.info("queue.enqueued", { jobId: id, chatId, messageId, eventType });
    return id;
  }

  _claimNext() {
    const job = this.db
      .prepare(
        `SELECT * FROM sync_jobs
         WHERE status = 'pending' AND run_after <= datetime('now')
         ORDER BY id LIMIT 1`
      )
      .get();
    if (!job) return null;
    this.db
      .prepare("UPDATE sync_jobs SET status = 'processing', updated_at = datetime('now') WHERE id = ?")
      .run(job.id);
    return job;
  }

  async processNext() {
    const job = this._claimNext();
    if (!job) return null;

    const key = `${job.chat_id}:${job.message_id}`;
    return withLock(key, async () => {
      const payload = JSON.parse(job.payload);
      const attempts = job.attempts + 1;
      try {
        const result = await this.syncService.syncMessage(payload);
        this.db
          .prepare(
            "UPDATE sync_jobs SET status = 'done', attempts = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?"
          )
          .run(attempts, job.id);
        return { job, result };
      } catch (e) {
        const giveUp = attempts >= MAX_ATTEMPTS;
        const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
        this.db
          .prepare(
            `UPDATE sync_jobs
             SET status = ?, attempts = ?, last_error = ?,
                 run_after = datetime('now', ?), updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(giveUp ? "failed" : "pending", attempts, String(e.message).slice(0, 500), `+${delay} seconds`, job.id);
        logger.error("queue.job_failed", { jobId: job.id, attempts, giveUp, error: e.message });
        return { job, error: e };
      }
    });
  }

  // Обрабатывает всё, что накопилось. Используется в тестах и CLI.
  async drain(limit = 100) {
    const done = [];
    for (let i = 0; i < limit; i++) {
      const r = await this.processNext();
      if (!r) break;
      done.push(r);
    }
    return done;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      if (!this.draining) {
        this.draining = true;
        try {
          await this.drain(10);
        } catch (e) {
          logger.error("queue.tick_failed", { error: e.message });
        } finally {
          this.draining = false;
        }
      }
      this.timer = setTimeout(tick, this.pollIntervalMs);
      this.timer.unref?.();
    };
    tick();
    logger.info("queue.started", { pollIntervalMs: this.pollIntervalMs });
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { SyncQueue, withLock, MAX_ATTEMPTS };
