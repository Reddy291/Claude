import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { creditCost, findModel, validateRequest } from "./models.js";
import { FFMPEG } from "./paths.js";
import { getProvider } from "./providers/index.js";

const MAX_CONCURRENT = 2;
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Owns the generation lifecycle: validate -> charge credits -> queue ->
// run provider -> thumbnail -> done (or refund on failure/cancel).
export class JobRunner {
  constructor(store, { videosDir, uploadsDir }) {
    this.store = store;
    this.videosDir = videosDir;
    this.uploadsDir = uploadsDir;
    this.queue = [];
    this.running = new Map(); // id -> AbortController

    // Jobs that were mid-flight when the server stopped can't resume; refund them.
    for (const g of store.list()) {
      if (g.status === "queued" || g.status === "processing") this.fail(g.id, "Interrupted by a server restart.");
    }
  }

  create(body) {
    const model = findModel(body.model);
    const references = Array.isArray(body.references) ? body.references : [];
    const req = {
      prompt: String(body.prompt ?? ""),
      negativePrompt: String(body.negativePrompt ?? "").slice(0, 1000),
      duration: Number(body.duration),
      resolution: String(body.resolution),
      aspectRatio: String(body.aspectRatio),
      audio: Boolean(body.audio),
      references,
    };
    const invalid = validateRequest(model, req);
    if (invalid) throw new HttpError(400, invalid);

    const cost = creditCost(model, req);
    if (this.store.credits < cost) {
      throw new HttpError(402, `This clip costs ${cost} credits; you have ${this.store.credits}.`);
    }

    const id = crypto.randomUUID();
    const referenceFiles = references.map((dataUrl, i) => this.saveReference(id, i, dataUrl));
    const seed = Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : crypto.randomInt(0, 2 ** 31);
    const now = new Date().toISOString();

    this.store.adjustCredits(-cost);
    const gen = {
      id,
      status: "queued",
      progress: 0,
      model: model.id,
      modelName: model.name,
      prompt: req.prompt.trim(),
      negativePrompt: req.negativePrompt.trim(),
      duration: req.duration,
      resolution: req.resolution,
      aspectRatio: req.aspectRatio,
      audio: req.audio,
      seed,
      cost,
      references: referenceFiles,
      video: null,
      thumbnail: null,
      error: null,
      note: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(gen);
    this.queue.push(id);
    this.pump();
    return gen;
  }

  saveReference(id, index, dataUrl) {
    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl));
    const ext = match && IMAGE_TYPES[match[1]];
    if (!ext) throw new HttpError(400, "Reference images must be PNG, JPEG or WebP.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, "Each reference image must be under 8 MB.");
    const name = `${id}-${index}.${ext}`;
    fs.writeFileSync(path.join(this.uploadsDir, name), bytes);
    return name;
  }

  pump() {
    while (this.running.size < MAX_CONCURRENT && this.queue.length) {
      const id = this.queue.shift();
      if (this.store.get(id)?.status === "queued") this.run(id);
    }
  }

  async run(id) {
    const gen = this.store.update(id, { status: "processing", progress: 0.01 });
    const model = findModel(gen.model);
    const controller = new AbortController();
    this.running.set(id, controller);
    const videoName = `${id}.mp4`;
    const outputPath = path.join(this.videosDir, videoName);
    let lastSaved = 0;

    try {
      const result = await getProvider(model.provider).generate(
        {
          ...gen,
          model,
          referencePaths: gen.references.map((r) => path.join(this.uploadsDir, r)),
        },
        {
          outputPath,
          signal: controller.signal,
          onProgress: (p) => {
            // Progress is polled by the UI; avoid rewriting the db on every tick.
            if (p - lastSaved >= 0.05) {
              lastSaved = p;
              this.store.update(id, { progress: Number(p.toFixed(2)) });
            }
          },
        },
      );
      const thumbName = `${id}.jpg`;
      await thumbnail(outputPath, path.join(this.videosDir, thumbName), gen.duration);
      this.store.update(id, {
        status: "succeeded",
        progress: 1,
        video: videoName,
        thumbnail: thumbName,
        width: result.width,
        height: result.height,
        note: result.note ?? null,
      });
    } catch (err) {
      fs.rmSync(outputPath, { force: true });
      this.fail(id, controller.signal.aborted ? "Cancelled." : err.message);
    } finally {
      this.running.delete(id);
      this.pump();
    }
  }

  fail(id, message) {
    const gen = this.store.get(id);
    if (!gen || gen.status === "failed") return;
    this.store.adjustCredits(gen.cost);
    this.store.update(id, { status: "failed", error: message, progress: 0 });
  }

  cancel(id) {
    const gen = this.store.get(id);
    if (!gen) throw new HttpError(404, "Not found.");
    if (gen.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      this.fail(id, "Cancelled.");
    } else if (gen.status === "processing") {
      this.running.get(id)?.abort();
    } else {
      throw new HttpError(409, "Only queued or running generations can be cancelled.");
    }
  }

  remove(id) {
    const gen = this.store.get(id);
    if (!gen) throw new HttpError(404, "Not found.");
    if (gen.status === "queued" || gen.status === "processing") {
      throw new HttpError(409, "Cancel the generation before deleting it.");
    }
    for (const f of [gen.video, gen.thumbnail].filter(Boolean)) fs.rmSync(path.join(this.videosDir, f), { force: true });
    for (const f of gen.references) fs.rmSync(path.join(this.uploadsDir, f), { force: true });
    this.store.remove(id);
  }
}

function thumbnail(videoPath, thumbPath, duration) {
  return new Promise((resolve, reject) => {
    const at = String(Math.min(1.5, duration / 2));
    const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i", videoPath,
      "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", thumbPath], { windowsHide: true });
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Thumbnail extraction failed"))));
  });
}
