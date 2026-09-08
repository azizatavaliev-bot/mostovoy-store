// Ручной запуск бэкапа БД (тот же путь, что и автоматический раз в 6 часов
// из server/index.js): npm run backup
const { getDb, closeDb } = require("../db");
const { runBackup, enabled } = require("../services/backup");

async function main() {
  if (!enabled) {
    console.error("Бэкап выключен: задайте BACKUP_S3_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET.");
    process.exit(1);
  }
  const db = getDb();
  try {
    const result = await runBackup({ db });
    console.log(`Готово: ${result.key} (${result.bytes} байт), удалено старых: ${result.deleted}`);
  } finally {
    closeDb();
  }
}

main().catch((error) => {
  console.error("Бэкап не удался:", error.message);
  process.exit(1);
});
