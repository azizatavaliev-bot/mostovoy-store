// Восстановление БД из бэкапа. Скачивает, распаковывает, проверяет
// PRAGMA integrity_check и только потом пишет на диск — не перезаписывает
// существующий файл молча.
//
//   npm run restore-backup -- --list                     список доступных бэкапов
//   npm run restore-backup -- --key mostovoy-store/20260908-1200.db.gz --out ./restored.db
const fs = require("fs");
const { listBackups, restoreBackup, enabled } = require("../services/backup");

function parseArgs(argv) {
  const args = { list: false, key: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") args.list = true;
    if (argv[i] === "--key") args.key = argv[++i];
    if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  if (!enabled) {
    console.error("Бэкап выключен: задайте BACKUP_S3_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET.");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const keys = await listBackups();
    if (!keys.length) return console.log("Бэкапов пока нет.");
    return keys.sort().forEach((k) => console.log(k));
  }

  if (!args.key || !args.out) {
    console.error("Нужны --key <имя бэкапа> и --out <путь для восстановленного файла>. Или --list, чтобы увидеть доступные бэкапы.");
    process.exit(1);
  }
  if (fs.existsSync(args.out)) {
    console.error(`Файл ${args.out} уже существует — уберите его или укажите другой --out, чтобы не перезаписать текущую базу молча.`);
    process.exit(1);
  }
  const result = await restoreBackup(args.key, args.out);
  console.log(`Восстановлено: ${result.restoredTo} (${result.bytes} байт), целостность подтверждена.`);
}

main().catch((error) => {
  console.error("Восстановление не удалось:", error.message);
  process.exit(1);
});
