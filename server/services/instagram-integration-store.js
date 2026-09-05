"use strict";

// Хранилище одной-единственной интеграции Instagram Direct (см.
// instagram_integration в migrations.js) — не мультитенантно, id всегда 1.
// Работа с access token инкапсулирована здесь: наружу токен в открытом виде
// не отдаётся никогда (см. getDecryptedAccessToken — используется только
// внутри instagram-graph.js/crm.js на сервере, не в API-ответах).

const { encryptToken, decryptToken } = require("./instagram-graph");

function getIntegration(db) {
  return db.prepare("SELECT * FROM instagram_integration WHERE id = 1").get() || null;
}

// Публичный статус для фронта — без токена и прочих секретов.
function getPublicStatus(db) {
  const row = getIntegration(db);
  if (!row) return { connected: false };
  return {
    connected: row.status === "connected",
    status: row.status,
    username: row.username,
    instagramAccountId: row.instagram_account_id,
    connectedAt: row.connected_at,
    tokenExpiresAt: row.token_expires_at,
    lastError: row.status === "error" ? row.last_error : null,
  };
}

function upsertIntegration(db, { instagramAccountId, username, accessToken, expiresAt, scopes }) {
  db.prepare(
    `INSERT INTO instagram_integration
      (id, instagram_account_id, username, access_token_encrypted, token_expires_at, scopes, status, last_error, connected_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 'connected', NULL, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       instagram_account_id = excluded.instagram_account_id,
       username = excluded.username,
       access_token_encrypted = excluded.access_token_encrypted,
       token_expires_at = excluded.token_expires_at,
       scopes = excluded.scopes,
       status = 'connected',
       last_error = NULL,
       updated_at = datetime('now')`
  ).run(instagramAccountId, username || null, encryptToken(accessToken), expiresAt || null, (scopes || []).join(","));
}

function updateAccessToken(db, { accessToken, expiresAt }) {
  db.prepare(
    `UPDATE instagram_integration SET access_token_encrypted = ?, token_expires_at = ?, status = 'connected', last_error = NULL, updated_at = datetime('now') WHERE id = 1`
  ).run(encryptToken(accessToken), expiresAt || null);
}

function markReauthRequired(db, reason) {
  db.prepare(
    `UPDATE instagram_integration SET status = 'reauth_required', last_error = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(String(reason || "").slice(0, 500));
}

function markError(db, reason) {
  db.prepare(
    `UPDATE instagram_integration SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(String(reason || "").slice(0, 500));
}

function deleteIntegration(db) {
  db.prepare("DELETE FROM instagram_integration WHERE id = 1").run();
}

function getDecryptedAccessToken(db) {
  const row = getIntegration(db);
  if (!row || row.status !== "connected") return null;
  return decryptToken(row.access_token_encrypted);
}

module.exports = {
  getIntegration,
  getPublicStatus,
  upsertIntegration,
  updateAccessToken,
  markReauthRequired,
  markError,
  deleteIntegration,
  getDecryptedAccessToken,
};
