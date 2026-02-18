const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();
const ytDlp = new YTDlpWrap(undefined, { autoUpdate: true });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ================= DIR ================= */
const DOWNLOAD_DIR = process.env.RAILWAY_ENVIRONMENT
  ? "/tmp/downloads"
  : path.join(__dirname, "downloads");

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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
  clients.forEach(c =>
    c.write(`data: ${JSON.stringify(data)}\n\n`)
  );
}

/* ================= QUEUE ================= */
function startNext() {
  if (currentJob || queue.length === 0) return;

  currentJob = queue.shift();
  const { id, url } = currentJob;

  const output = path.join(DOWNLOAD_DIR, `video_${id}.%(ext)s`);

  const yt = ytDlp.exec([
    "--newline",
    "-f", "bestvideo+bestaudio/best",
    "--merge-output-format", "mp4",
    "-o", output,
    url
  ]);

  yt.stdout.on("data", d => {
    const t = d.toString();
    broadcast({
      id,
      percent: t.match(/(\d+(\.\d+)?)%/)?.[1] || null,
      speed: t.match(/at\s+([^\s]+)/)?.[1] || null,
      eta: t.match(/ETA\s+([^\s]+)/)?.[1] || null
    });
  });

  yt.stderr.on("data", d => {
    console.error("yt-dlp:", d.toString());
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
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const id = Date.now().toString();
  queue.push({ id, url });
  startNext();

  res.json({ id });
});

app.post("/cancel/:id", (_, res) => {
  if (currentJob) {
    currentJob = null;
  }
  res.json({ cancelled: true });
});

app.get("/file/:id", (req, res) => {
  const file = fs.readdirSync(DOWNLOAD_DIR)
    .find(f => f.includes(`video_${req.params.id}`));

  if (!file) return res.sendStatus(404);

  res.download(path.join(DOWNLOAD_DIR, file), () =>
    fs.unlinkSync(path.join(DOWNLOAD_DIR, file))
  );
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
