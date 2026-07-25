// Слой БД. SQLite из стандартной библиотеки Node (node:sqlite) — без внешних зависимостей.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const migrations = require("./migrations");
const logger = require("../logger");

let db = null;

function open(dbPath) {
  const file = dbPath || require("../config").databasePath;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec("PRAGMA busy_timeout = 5000");
  return conn;
}

function migrate(conn) {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(conn.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    conn.exec("BEGIN");
    try {
      conn.exec(m.sql);
      conn.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(m.name);
      conn.exec("COMMIT");
      logger.info("migration.applied", { name: m.name });
    } catch (e) {
      conn.exec("ROLLBACK");
      throw new Error(`Миграция ${m.name} упала: ${e.message}`);
    }
  }
}

function getDb() {
  if (!db) {
    db = open();
    migrate(db);
  }
  return db;
}

// Отдельное подключение — для тестов и CLI.
function createConnection(dbPath) {
  const conn = open(dbPath);
  migrate(conn);
  return conn;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Транзакция. node:sqlite не даёт вложенных — используем SAVEPOINT для вложенных вызовов.
let depth = 0;
function transaction(conn, fn) {
  const nested = depth > 0;
  const sp = `sp_${depth}`;
  conn.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN");
  depth++;
  try {
    const result = fn();
    depth--;
    conn.exec(nested ? `RELEASE ${sp}` : "COMMIT");
    return result;
  } catch (e) {
    depth--;
    try {
      conn.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
    } catch {
      /* соединение уже могло откатиться само */
    }
    throw e;
  }
}

function logSync(conn, { level = "info", event, chatId, messageId, productId, details }) {
  conn
    .prepare(
      `INSERT INTO sync_log (level, event, chat_id, message_id, product_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      level,
      event,
      chatId != null ? String(chatId) : null,
      messageId != null ? Number(messageId) : null,
      productId != null ? Number(productId) : null,
      details ? JSON.stringify(details) : null
    );
}

module.exports = { getDb, createConnection, closeDb, transaction, migrate, logSync };
