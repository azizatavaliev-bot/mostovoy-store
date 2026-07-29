const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const sharp = require("sharp");
const config = require("../config");
const logger = require("../logger");
const { safeFetch, readLimited } = require("../lib/safeFetch");

function escapedLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function createImageRouter({ db }) {
  const router = express.Router();
  const cacheDir = path.join(config.uploads.dir, "optimized");
  const pending = new Map();
  fs.mkdirSync(cacheDir, { recursive: true });

  const productImage = db.prepare(
    `SELECT 1 FROM products
     WHERE main_image_url = ?
        OR image_urls LIKE ? ESCAPE '\\'
     LIMIT 1`
  );
  const postImage = db.prepare("SELECT 1 FROM posts WHERE image = ? LIMIT 1");

  function isCatalogImage(src) {
    const encoded = escapedLike(JSON.stringify(src).slice(1, -1));
    return Boolean(productImage.get(src, `%${encoded}%`) || postImage.get(src));
  }

  async function sourceBuffer(src) {
    if (src.startsWith("/uploads/")) {
      const relative = src.slice("/uploads/".length);
      if (!relative || relative !== path.basename(relative)) throw new Error("invalid_local_path");
      return fs.promises.readFile(path.join(config.uploads.dir, relative));
    }

    const { res } = await safeFetch(src, {
      timeoutMs: config.images.timeoutMs,
      maxBytes: config.images.maxBytes,
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/") || contentType.includes("svg")) throw new Error("not_raster_image");
    return readLimited(res, config.images.maxBytes);
  }

  async function optimize(src, width, outputPath) {
    const input = await sourceBuffer(src);
    await sharp(input, { failOn: "error" })
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true })
      .toFile(outputPath);
  }

  router.get("/webp", async (req, res) => {
    const src = typeof req.query.src === "string" ? req.query.src : "";
    const requestedWidth = Number(req.query.w);
    const width = Math.max(64, Math.min(1600, Number.isFinite(requestedWidth) ? Math.round(requestedWidth) : 720));

    if ((!src.startsWith("https://") && !src.startsWith("/uploads/")) || !isCatalogImage(src)) {
      return res.status(404).end();
    }

    const key = crypto.createHash("sha256").update(`${src}\n${width}\n82`).digest("hex");
    const outputPath = path.join(cacheDir, `${key}.webp`);

    try {
      if (!fs.existsSync(outputPath)) {
        if (!pending.has(key)) {
          pending.set(
            key,
            optimize(src, width, outputPath).finally(() => pending.delete(key))
          );
        }
        await pending.get(key);
      }

      res.set({
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return res.sendFile(outputPath);
    } catch (error) {
      logger.warn("image.optimize_failed", { src, width, error: error.message });
      return res.redirect(302, src);
    }
  });

  return router;
}

module.exports = { createImageRouter };
