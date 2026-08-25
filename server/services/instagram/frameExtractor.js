// Извлечение кадров из видео Story через ffmpeg — без временного постоянного
// хранения: файл видео и кадры пишутся в os.tmpdir() и удаляются в finally.
// child_process.execFile (НЕ shell: true) — аргументы фиксированным массивом,
// путь к временному файлу никогда не подставляется в строку команды.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const sharp = require("sharp");

const execFileAsync = promisify(execFile);

class FrameExtractionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FrameExtractionError";
    this.code = code;
  }
}

function isBinaryMissing(error) {
  return error?.code === "ENOENT" || /ENOENT|not found/i.test(String(error?.message || ""));
}

async function probeDurationSeconds(filePath, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: timeoutMs }
    );
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (error) {
    if (isBinaryMissing(error)) throw new FrameExtractionError("ffprobe не найден в окружении", "ffmpeg_not_found");
    return null; // не смогли определить длительность — извлечём кадры по умолчанию (см. ниже)
  }
}

// Доли длительности, на которых берём кадр. Очень короткое видео (меньше
// пары секунд между отметками) — адаптируем количество, чтобы не просить
// у ffmpeg дважды один и тот же кадр.
function pickTimestamps(durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return [0];
  if (durationSeconds < 1.5) return [durationSeconds * 0.5];
  if (durationSeconds < 4) return [durationSeconds * 0.3, durationSeconds * 0.7];
  return [durationSeconds * 0.2, durationSeconds * 0.5, durationSeconds * 0.8];
}

async function extractFrameAt(videoPath, timestampSeconds, outputPath, timeoutMs) {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-ss", timestampSeconds.toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        outputPath,
      ],
      { timeout: timeoutMs }
    );
  } catch (error) {
    if (isBinaryMissing(error)) throw new FrameExtractionError("ffmpeg не найден в окружении", "ffmpeg_not_found");
    throw new FrameExtractionError(`ffmpeg не смог извлечь кадр: ${error.message}`, "ffmpeg_failed");
  }
}

/**
 * @param {Buffer} videoBytes
 * @param {{ maxSide?: number, quality?: number, timeoutMs?: number }} opts
 * @returns {Promise<Buffer[]>} JPEG-кадры, уменьшенные до maxSide по большей стороне
 */
async function extractFrames(videoBytes, { maxSide = 1280, quality = 82, timeoutMs = 20000 } = {}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-story-"));
  const videoPath = path.join(workDir, `src-${crypto.randomUUID()}.mp4`);
  try {
    await fs.writeFile(videoPath, videoBytes);
    const duration = await probeDurationSeconds(videoPath, timeoutMs);
    const timestamps = pickTimestamps(duration);

    const frames = [];
    for (const [index, ts] of timestamps.entries()) {
      const rawFramePath = path.join(workDir, `frame-${index}-${crypto.randomUUID()}.jpg`);
      await extractFrameAt(videoPath, ts, rawFramePath, timeoutMs);
      const rawBuffer = await fs.readFile(rawFramePath).catch(() => null);
      await fs.unlink(rawFramePath).catch(() => {});
      if (!rawBuffer || !rawBuffer.length) continue;
      const resized = await sharp(rawBuffer, { failOn: "error" })
        .rotate()
        .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      frames.push(resized);
    }
    if (!frames.length) throw new FrameExtractionError("Не удалось извлечь ни одного кадра из видео", "no_frames_extracted");
    return frames;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { extractFrames, pickTimestamps, FrameExtractionError };
