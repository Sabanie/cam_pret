import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "camera-watermark");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: true }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || "").toLowerCase() === ".mov" ? ".mov" : ".mp4"}`)
});
const upload = multer({
  storage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ["video/mp4", "video/quicktime", "application/octet-stream"].includes(file.mimetype)
    ? cb(null, true) : cb(new Error("Format video tidak didukung. Gunakan MP4 atau MOV."))
});
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d.toString(); if (err.length > 10000) err = err.slice(-10000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${err.slice(-2000)}`)));
  });
}
app.get("/api/health", (_req, res) => res.json({ success: true, service: "camera-watermark-backend" }));

app.post("/api/watermark", upload.single("video"), async (req, res, next) => {
  let inputPath, textPath;
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "File video (field video) wajib diisi." });
    inputPath = req.file.path;
    const id = randomUUID(), filename = `${id}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    textPath = path.join(OUTPUT_DIR, `${id}.txt`);
    const timestamp = String(req.body.timestamp || new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }));
    const locationName = String(req.body.locationName || "Lokasi tidak tersedia");
    const latitude = String(req.body.latitude || ""), longitude = String(req.body.longitude || "");
    const text = [timestamp, locationName, latitude && longitude ? `${latitude}, ${longitude}` : ""]
      .filter(Boolean).join("\n").replace(/[\u0000-\u001F]/g, "");
    await writeFile(textPath, text, "utf8");
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    const vf = `drawtext=fontfile=${font}:textfile=${textPath}:fontcolor=white:fontsize=24:line_spacing=6:box=1:boxcolor=black@0.55:boxborderw=12:x=20:y=h-th-20`;
    await runFfmpeg(["-y", "-i", inputPath, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath]);
    const baseUrl = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.json({ success: true, filename, downloadUrl: `${baseUrl}/api/videos/${filename}` });
  } catch (e) { next(e); }
  finally { if (inputPath) await unlink(inputPath).catch(() => {}); if (textPath) await unlink(textPath).catch(() => {}); }
});

app.get("/api/videos/:filename", async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    if (! /^[a-f0-9-]+\.mp4$/i.test(filename)) return res.status(400).json({ success: false, error: "Nama file tidak valid." });
    const filePath = path.join(OUTPUT_DIR, filename);
    await stat(filePath);
    res.download(filePath, filename, async err => {
      if (err && !res.headersSent) next(err);
      await unlink(filePath).catch(() => {});
    });
  } catch (e) {
    if (e?.code === "ENOENT") return res.status(404).json({ success: false, error: "Video hasil tidak ditemukan atau sudah kedaluwarsa." });
    next(e);
  }
});
app.use((err, _req, res, _next) => {
  console.error(err?.stack || err);
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: `Ukuran video melebihi ${MAX_UPLOAD_MB} MB.` });
  res.status(500).json({ success: false, error: err?.message || "Terjadi kesalahan server." });
});
app.listen(PORT, "0.0.0.0", () => console.log(`Camera watermark backend listening on port ${PORT}`));