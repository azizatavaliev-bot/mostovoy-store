// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.BACKUP_S3_ENDPOINT = "https://fake-account.r2.cloudflarestorage.com";
process.env.BACKUP_S3_ACCESS_KEY_ID = "test-access-key";
process.env.BACKUP_S3_SECRET_ACCESS_KEY = "test-secret-key";
process.env.BACKUP_S3_BUCKET = "test-bucket";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { DatabaseSync, backup: sqliteBackup } = require("node:sqlite");
const { runBackup, restoreBackup, listBackups, enabled } = require("../server/services/backup");

test("backup.enabled — true, когда все BACKUP_S3_* заданы", () => {
  assert.equal(enabled, true);
});

test("runBackup: подписывает PUT (AWS SigV4), гасит содержимое БД, чистит бэкапы старше 30 дней", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER)");
  db.exec("INSERT INTO t VALUES (1), (2), (3)");

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body });
    if (opts.method === "PUT") return { ok: true, status: 200 };
    if (opts.method === "GET" && String(url).includes("list-type=2")) {
      // Один совсем старый бэкап (должен быть удалён) и один свежий (должен остаться).
      const oldKey = "mostovoy-store/20200101-0000.db.gz";
      const freshKey = "mostovoy-store/20990101-0000.db.gz";
      return {
        ok: true,
        status: 200,
        text: async () => `<ListBucketResult><Contents><Key>${oldKey}</Key></Contents><Contents><Key>${freshKey}</Key></Contents></ListBucketResult>`,
      };
    }
    if (opts.method === "DELETE") return { ok: true, status: 204 };
    throw new Error(`unexpected fetch: ${opts.method} ${url}`);
  };

  let result;
  try {
    result = await runBackup({ db, projectName: "mostovoy-store" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(result.key, /^mostovoy-store\/\d{8}-\d{4}\.db\.gz$/);
  assert.equal(result.deleted, 1, "должен удалить ровно один старый бэкап (2020 год), не трогая свежий (2099)");

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "должен быть PUT-запрос загрузки");
  assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//, "подпись SigV4 с нашим access key");
  assert.ok(put.headers["x-amz-content-sha256"], "хеш тела запроса должен присутствовать в подписанных заголовках");

  // Само содержимое — валидный gzip с реальным снимком БД.
  const raw = zlib.gunzipSync(put.body);
  const tmpFile = path.join(os.tmpdir(), `verify-${Date.now()}.db`);
  fs.writeFileSync(tmpFile, raw);
  try {
    const check = new DatabaseSync(tmpFile);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM t").get().n, 3);
    check.close();
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  const deleteCall = calls.find((c) => c.method === "DELETE");
  assert.match(deleteCall.url, /20200101-0000\.db\.gz/, "удалён именно старый бэкап");
});

test("restoreBackup: скачивает, распаковывает, проверяет целостность и только потом пишет файл", async () => {
  const src = new DatabaseSync(":memory:");
  src.exec("CREATE TABLE t (id INTEGER)");
  src.exec("INSERT INTO t VALUES (7)");
  const tmpSrc = path.join(os.tmpdir(), `src-${Date.now()}.db`);
  await sqliteBackup(src, tmpSrc);
  const gzipped = zlib.gzipSync(fs.readFileSync(tmpSrc));
  fs.rmSync(tmpSrc, { force: true });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => gzipped.buffer.slice(gzipped.byteOffset, gzipped.byteOffset + gzipped.byteLength) });

  const outPath = path.join(os.tmpdir(), `restored-${Date.now()}.db`);
  try {
    const result = await restoreBackup("mostovoy-store/20260908-1200.db.gz", outPath);
    assert.equal(result.restoredTo, outPath);
    const restored = new DatabaseSync(outPath);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
    restored.close();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(outPath, { force: true });
  }
});

test("restoreBackup: повреждённый файл проваливает integrity_check и не пишется на диск", async () => {
  const originalFetch = globalThis.fetch;
  const corrupted = zlib.gzipSync(Buffer.from("this is not a sqlite file at all"));
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => corrupted.buffer.slice(corrupted.byteOffset, corrupted.byteOffset + corrupted.byteLength) });

  const outPath = path.join(os.tmpdir(), `restored-corrupt-${Date.now()}.db`);
  try {
    await assert.rejects(restoreBackup("mostovoy-store/bad.db.gz", outPath));
    assert.equal(fs.existsSync(outPath), false, "повреждённый бэкап не должен попасть на целевой путь");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(outPath, { force: true });
  }
});

test("listBackups отдаёт ключи из ListObjectsV2", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => `<ListBucketResult><Contents><Key>mostovoy-store/a.db.gz</Key></Contents></ListBucketResult>`,
  });
  try {
    const keys = await listBackups("mostovoy-store");
    assert.deepEqual(keys, ["mostovoy-store/a.db.gz"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
