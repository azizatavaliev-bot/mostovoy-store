"use strict";

// Бэкап SQLite в S3-совместимое объектное хранилище (Cloudflare R2, Railway
// bucket или любой другой S3-совместимый эндпоинт — креды только через env,
// см. BACKUP_S3_* ниже). Без внешних зависимостей: подпись запроса —
// AWS Signature V4 на встроенном node:crypto, загрузка — встроенный fetch.
// Пусто в BACKUP_S3_* — всё становится no-op с одним warn при старте,
// как и в control-center.js.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { DatabaseSync, backup: sqliteBackup } = require("node:sqlite");
const config = require("../config");
const logger = require("../logger");
const controlCenter = require("./control-center");

const RETENTION_DAYS = 30;

const enabled = config.features.backup;
if (!enabled) {
  logger.warn("backup.disabled", { hint: "задайте BACKUP_S3_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET, чтобы включить бэкап" });
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// AWS Signature V4 для одного HTTP-запроса к S3-совместимому эндпоинту.
// region для R2 — буквально "auto"; для настоящего S3 — реальный регион.
function signRequest({ method, host, path: reqPath, query = "", body = Buffer.alloc(0), extraHeaders = {} }) {
  const { accessKeyId, secretAccessKey, region } = config.backup;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [method, reqPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...headers, authorization };
}

function bucketUrl(key = "") {
  const { endpoint, bucket } = config.backup;
  return `${endpoint}/${bucket}/${key}`;
}

async function s3Put(key, body) {
  const host = new URL(config.backup.endpoint).host;
  const headers = signRequest({ method: "PUT", host, path: `/${config.backup.bucket}/${key}`, body });
  const res = await fetch(bucketUrl(key), { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`S3 PUT ${key}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

async function s3Get(key) {
  const host = new URL(config.backup.endpoint).host;
  const headers = signRequest({ method: "GET", host, path: `/${config.backup.bucket}/${key}` });
  const res = await fetch(bucketUrl(key), { method: "GET", headers });
  if (!res.ok) throw new Error(`S3 GET ${key}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function s3Delete(key) {
  const host = new URL(config.backup.endpoint).host;
  const headers = signRequest({ method: "DELETE", host, path: `/${config.backup.bucket}/${key}` });
  const res = await fetch(bucketUrl(key), { method: "DELETE", headers });
  if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: HTTP ${res.status}`);
}

// ListObjectsV2, только под наш префикс (project/) — минимальный XML-парсер
// без зависимостей: ключи между <Key>...</Key> достаточно для ретеншена.
async function s3List(prefix) {
  const host = new URL(config.backup.endpoint).host;
  const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const headers = signRequest({ method: "GET", host, path: `/${config.backup.bucket}/`, query });
  const res = await fetch(`${bucketUrl("")}?${query}`, { method: "GET", headers });
  if (!res.ok) throw new Error(`S3 LIST ${prefix}: HTTP ${res.status}`);
  const xml = await res.text();
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  return keys;
}

function backupFileName(projectName) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
  return `${projectName}/${stamp}.db.gz`;
}

// Онлайн-бэкап через встроенный node:sqlite backup() (SQLite Backup API —
// консистентный снимок без блокировки записи надолго) → gzip → загрузка.
// db — открытое соединение DatabaseSync приложения (то же, что использует
// вся остальная логика), не отдельный файл — так бэкап всегда актуален.
async function runBackup({ db, projectName = "mostovoy-store" } = {}) {
  if (!enabled) return { skipped: true };
  const tmpFile = path.join(os.tmpdir(), `backup-${Date.now()}.db`);
  try {
    await sqliteBackup(db, tmpFile);
    const raw = fs.readFileSync(tmpFile);
    const gzipped = zlib.gzipSync(raw);
    const key = backupFileName(projectName);
    await s3Put(key, gzipped);
    logger.info("backup.uploaded", { key, bytes: gzipped.length });
    void controlCenter.reportEvent({ type: "backup", level: "info", title: `Бэкап загружен: ${key}`, payload: { bytes: gzipped.length } });

    const allKeys = await s3List(`${projectName}/`);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const oldKey of allKeys) {
      const match = oldKey.match(/(\d{8})-(\d{4})\.db\.gz$/);
      if (!match) continue;
      const [, ymd, hm] = match;
      const ts = Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hm.slice(0, 2)}:${hm.slice(2, 4)}:00Z`);
      if (Number.isFinite(ts) && ts < cutoff) {
        await s3Delete(oldKey);
        deleted++;
      }
    }
    return { key, bytes: gzipped.length, deleted };
  } catch (error) {
    logger.error("backup.failed", { error: error.message });
    void controlCenter.reportEvent({ type: "backup", level: "error", title: "Бэкап не удался", payload: { message: error.message } });
    throw error;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// Восстановление: скачать → распаковать → проверить целостность
// (PRAGMA integrity_check) → только тогда положить рядом с целевым путём.
// Не перезаписывает существующий файл молча — вызывающий код (CLI) решает,
// что делать, если destPath уже существует.
async function restoreBackup(key, destPath) {
  const gzipped = await s3Get(key);
  const raw = zlib.gunzipSync(gzipped);
  const tmpFile = path.join(os.tmpdir(), `restore-${Date.now()}.db`);
  fs.writeFileSync(tmpFile, raw);
  try {
    const check = new DatabaseSync(tmpFile);
    const result = check.prepare("PRAGMA integrity_check").get();
    check.close();
    if (result.integrity_check !== "ok") {
      throw new Error(`Проверка целостности не прошла: ${result.integrity_check}`);
    }
    fs.copyFileSync(tmpFile, destPath);
    return { restoredTo: destPath, bytes: raw.length };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

async function listBackups(projectName = "mostovoy-store") {
  if (!enabled) return [];
  return s3List(`${projectName}/`);
}

module.exports = { enabled, runBackup, restoreBackup, listBackups };
