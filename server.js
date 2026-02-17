const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();

/* ================= yt-dlp INIT ================= */
const ytDlpWrap = new YTDlpWrap(undefined, {
  autoUpdate: true
});

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ================= CONSTANTS ================= */
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

/* ================= FIX yt-dlp PERMISSIONS (RAILWAY) ================= */
const ytDlpPath = ytDlpWrap.getYtDlpPath();
if (ytDlpPath && fs.existsSync(ytDlpPath)) {
  fs.chmodSync(ytDlpPath, 0o755);
}

/* ================= STATE ================= */
let clients = [];
let queue = [];
let currentJob = null;

/* ================= SSE (PROGRESS STREAM) ================= */
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
  clients.forEach(res => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

/* ================= QUEUE HANDLER ================= */
function startNext() {
  if (currentJob || queue.length === 0) return;

  currentJob = queue.shift();
  const { id, url } = currentJob;

  const outputTemplate = path.join(
    DOWNLOAD_DIR,
    `video_${id}.%(ext)s`
  );

  console.log("Starting download:", url);

  const yt = ytDlpWrap.exec([
    "--newline",
    "-f", "mp4/bestaudio+best",
    "--merge-output-format", "mp4",
    "-o", outputTemplate,
    url
  ]);

  currentJob.process = yt;

  yt.stdout.on("data", data => {
    const text = data.toString();

    const percent = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    const speed = text.match(/at\s+([\d.]+(?:KiB|MiB|GiB)\/s)/);
    const eta = text.match(/ETA\s+([\d:]+)/);

    broadcast({
      id,
      percent: percent?.[1] || null,
      speed: speed?.[1] || null,
      eta: eta?.[1] || null
    });
  });

  yt.stderr.on("data", err => {
    console.error("yt-dlp error:", err.toString());
  });

  yt.on("close", code => {
    console.log("Download finished:", id, "code:", code);
    broadcast({ id, done: true });
    currentJob = null;
    startNext();
  });
}

/* ================= ROUTES ================= */

/* START DOWNLOAD (SAFE JSON RESPONSE) */
app.post("/download", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }

    const id = Date.now().toString();
    queue.push({ id, url });
    startNext();

    res.json({ id });
  } catch (err) {
    console.error("DOWNLOAD ROUTE ERROR:", err);
    res.status(500).json({ error: "Download initialization failed" });
  }
});

/* CANCEL DOWNLOAD */
app.post("/cancel/:id", (req, res) => {
  const { id } = req.params;

  if (currentJob && currentJob.id === id) {
    currentJob.process.kill("SIGTERM");
    currentJob = null;
    broadcast({ id, cancelled: true });
    startNext();
    return res.json({ cancelled: true });
  }

  queue = queue.filter(job => job.id !== id);
  broadcast({ id, cancelled: true });
  res.json({ cancelled: true });
});

/* SERVE FILE TO BROWSER */
app.get("/file/:id", (req, res) => {
  const files = fs.readdirSync(DOWNLOAD_DIR);
  const file = files.find(f => f.includes(`video_${req.params.id}`));

  if (!file) return res.sendStatus(404);

  const filePath = path.join(DOWNLOAD_DIR, file);

  res.download(filePath, () => {
    fs.unlinkSync(filePath); // auto cleanup
  });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
