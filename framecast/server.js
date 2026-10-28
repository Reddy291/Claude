import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { HttpError, JobRunner } from "./lib/jobs.js";
import { MODELS, creditCost, findModel } from "./lib/models.js";
import { DATA_DIR, FFMPEG, IS_PACKAGED, PUBLIC_DIR } from "./lib/paths.js";
import { Store } from "./lib/store.js";

const VIDEOS_DIR = path.join(DATA_DIR, "videos");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 40 * 1024 * 1024;

for (const dir of [VIDEOS_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });

const store = new Store(DATA_DIR, { startingCredits: Number(process.env.FRAMECAST_CREDITS ?? 500) });
const jobs = new JobRunner(store, { videosDir: VIDEOS_DIR, uploadsDir: UPLOADS_DIR });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

// Serves a file from `baseDir`, refusing anything that resolves outside it.
// Supports Range requests so the browser can seek inside videos.
function serveFile(req, res, baseDir, relPath, { download } = {}) {
  const filePath = path.resolve(baseDir, "." + path.posix.normalize("/" + relPath));
  if (!filePath.startsWith(baseDir + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: "Not found." });
  }
  const { size } = fs.statSync(filePath);
  const headers = {
    "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
  };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": size });
  fs.createReadStream(filePath).pipe(res);
}

const publicGeneration = (g) => ({
  ...g,
  videoUrl: g.video ? `/media/videos/${g.video}` : null,
  thumbnailUrl: g.thumbnail ? `/media/videos/${g.thumbnail}` : null,
  referenceUrls: g.references.map((r) => `/media/uploads/${r}`),
});

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const [resource, id, action] = parts;

  if (resource === "models" && req.method === "GET") return sendJson(res, 200, { models: MODELS });
  if (resource === "account" && req.method === "GET") return sendJson(res, 200, { app: "framecast", credits: store.credits });

  if (resource === "quote" && req.method === "POST") {
    const body = await readJson(req);
    const model = findModel(body.model);
    if (!model) throw new HttpError(400, "Unknown model.");
    return sendJson(res, 200, {
      cost: creditCost(model, { duration: Number(body.duration), resolution: body.resolution, audio: !!body.audio }),
    });
  }

  if (resource === "generations") {
    if (!id && req.method === "GET") {
      return sendJson(res, 200, { generations: store.list().map(publicGeneration), credits: store.credits });
    }
    if (!id && req.method === "POST") {
      const gen = jobs.create(await readJson(req));
      return sendJson(res, 201, { generation: publicGeneration(gen), credits: store.credits });
    }
    const gen = id && store.get(id);
    if (!gen) throw new HttpError(404, "Not found.");
    if (!action && req.method === "GET") return sendJson(res, 200, { generation: publicGeneration(gen) });
    if (action === "cancel" && req.method === "POST") {
      jobs.cancel(id);
      return sendJson(res, 200, { generation: publicGeneration(store.get(id)), credits: store.credits });
    }
    if (!action && req.method === "DELETE") {
      jobs.remove(id);
      return sendJson(res, 200, { ok: true, credits: store.credits });
    }
  }
  throw new HttpError(404, "Unknown API route.");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    if (url.pathname.startsWith("/media/videos/")) {
      const name = decodeURIComponent(url.pathname.slice("/media/videos/".length));
      return serveFile(req, res, VIDEOS_DIR, name, {
        download: url.searchParams.has("download") ? `framecast-${name}` : undefined,
      });
    }
    if (url.pathname.startsWith("/media/uploads/")) {
      return serveFile(req, res, UPLOADS_DIR, decodeURIComponent(url.pathname.slice("/media/uploads/".length)));
    }
    return serveFile(req, res, PUBLIC_DIR, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "Something went wrong." : err.message });
  }
});

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
}

// When Framecast is already running on the default port, reuse that instance.
// Uses plain http rather than fetch: it starts faster and never goes through
// a system proxy, so a local check can't be misrouted.
function existingInstance(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/account`, { timeout: 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).app === "framecast");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

// Packaged builds act like a desktop app: open the browser and pick another
// port if the default one is taken by something else.
// (No top-level await: the packaged build is bundled to CommonJS.)
async function main() {
  const shouldOpen = IS_PACKAGED || process.argv.includes("--open");
  const defaultUrl = `http://${HOST}:${PORT}`;
  if (shouldOpen && (await existingInstance(defaultUrl))) {
    console.log(`Framecast is already running at ${defaultUrl}; opening it.`);
    openBrowser(defaultUrl);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  let port;
  try {
    port = await listen(PORT);
  } catch (err) {
    if (err.code !== "EADDRINUSE" || !IS_PACKAGED) throw err;
    port = await listen(0);
  }
  const url = `http://${HOST}:${port}`;
  console.log(`Framecast running at ${url}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`ffmpeg: ${FFMPEG}`);
  if (IS_PACKAGED) console.log("\nKeep this window open while you use Framecast. Close it to quit.");
  if (shouldOpen) openBrowser(url);
}

main().catch((err) => {
  console.error(`Framecast could not start: ${err.message}`);
  // Keep the console window readable when launched by double-click.
  if (IS_PACKAGED) setTimeout(() => process.exit(1), 30000);
  else process.exit(1);
});
