const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();

/* yt-dlp auto download (Railway compatible) */
const ytDlpWrap = new YTDlpWrap(undefined, { autoUpdate: true });

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ================= HEALTH ================= */
app.get("/health", (_, res) => res.send("OK"));

/* ================= CONSTANTS ================= */
const DOWNLOAD_DIR = process.env.RAILWAY_ENVIRONMENT
  ? "/tmp/downloads"
  : path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/* ================= STATE ================= */
let clients = [];
let queue = [];
let currentJob = null;

/* ================= SSE ================= */
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);
  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

function broadcast(data) {
  clients.forEach(res =>
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  );
}

/* ================= QUEUE ================= */
function startNext() {
  if (currentJob || queue.length === 0) return;

  currentJob = queue.shift();
  const { id, url, quality } = currentJob;

  const format =
    quality === "audio"
      ? "bestaudio"
      : `bestvideo[height<=${quality}]+bestaudio/best`;

  const outputTemplate = path.join(
    DOWNLOAD_DIR,
    `video_${id}.%(ext)s`
  );

  const yt = ytDlpWrap.exec([
    "--newline",
    "-f", format,
    "--merge-output-format", "mp4",
    "-o", outputTemplate,
    url
  ]);

  yt.stdout.on("data", data => {
    const text = data.toString();
    broadcast({
      id,
      percent: text.match(/(\d+(?:\.\d+)?)%/)?.[1] || null,
      speed: text.match(/at\s+([^\s]+)/)?.[1] || null,
      eta: text.match(/ETA\s+([^\s]+)/)?.[1] || null
    });
  });

  yt.on("close", code => {
    if (code === 0) {
      broadcast({ id, done: true });
    } else {
      broadcast({ id, error: "Download failed" });
    }

    currentJob = null;
    startNext();
  });
}

/* ================= ROUTES ================= */
app.post("/download", (req, res) => {
  const { url, quality } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const id = Date.now().toString();
  queue.push({ id, url, quality: quality || "720" });
  startNext();

  res.json({ id });
});

app.get("/file/:id", (req, res) => {
  const file = fs.readdirSync(DOWNLOAD_DIR)
    .find(f => f.includes(`video_${req.params.id}`));

  if (!file) return res.sendStatus(404);

  const filePath = path.join(DOWNLOAD_DIR, file);
  res.download(filePath, () => fs.unlinkSync(filePath));
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
