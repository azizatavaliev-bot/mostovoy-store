// Отдельный файл — без BACKUP_S3_*, чтобы проверить no-op режим в чистом
// виде (config читает env один раз при первом require).

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { runBackup, listBackups, enabled } = require("../server/services/backup");

test("backup.enabled — false без BACKUP_S3_*, runBackup не бьёт по сети и возвращает skipped", async () => {
  assert.equal(enabled, false);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    const db = new DatabaseSync(":memory:");
    const result = await runBackup({ db });
    assert.deepEqual(result, { skipped: true });
    assert.deepEqual(await listBackups(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, "выключенный бэкап не должен делать сетевых запросов вообще");
});
