import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FFMPEG, FONTS } from "../paths.js";

// Demo provider: renders a real MP4 locally with ffmpeg so the whole app flow
// (queue, progress, playback, download) works without a paid video API.
// The clip is an animated gradient, the first reference image drifting across
// it, the prompt as a caption, and an optional ambient tone for "audio".
//
// ffmpeg runs inside a per-job work directory holding copies of the fonts and
// caption files, so the filter graph only uses bare file names. Absolute
// paths would need filter escaping, which Windows drive letters ("C:") break.
const FONT = "font.ttf";
const FONT_BOLD = "font-bold.ttf";
const CAPTION_FILE = "caption.txt";
const LABEL_FILE = "label.txt";
const PREVIEW_SHORT_SIDE = 480; // demo renders stay small so they finish fast
const FPS = 24;

const PALETTES = [
  ["0x0f2027", "0x2c5364", "0xf7971e"],
  ["0x1a1a2e", "0x7b2ff7", "0xf107a3"],
  ["0x0b3d2e", "0x2a9d8f", "0xe9c46a"],
  ["0x22223b", "0x4a4e69", "0xf2e9e4"],
  ["0x03045e", "0x0077b6", "0x90e0ef"],
  ["0x3d0c02", "0xc1440e", "0xffd166"],
];

function frameSize(aspectRatio) {
  const [w, h] = aspectRatio.split(":").map(Number);
  const even = (n) => Math.round(n / 2) * 2;
  return w >= h
    ? { width: even((PREVIEW_SHORT_SIDE * w) / h), height: PREVIEW_SHORT_SIDE }
    : { width: PREVIEW_SHORT_SIDE, height: even((PREVIEW_SHORT_SIDE * h) / w) };
}

function wrap(text, maxChars, maxLines) {
  const lines = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, "...");
  }
  return lines.join("\n");
}

function buildArgs(job, { width, height, outputPath }) {
  const d = job.duration;
  const palette = PALETTES[job.seed % PALETTES.length];
  const fontSize = Math.round(Math.min(width, height) / 18);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-nostats", "-progress", "pipe:1"];

  args.push("-f", "lavfi", "-i",
    `gradients=s=${width}x${height}:r=${FPS}:d=${d}:speed=0.015:n=3:seed=${job.seed}` +
    `:c0=${palette[0]}:c1=${palette[1]}:c2=${palette[2]}`);

  const ref = job.referencePaths?.[0];
  if (ref) args.push("-loop", "1", "-t", String(d), "-i", ref);
  if (job.audio) {
    args.push("-f", "lavfi", "-i", `sine=f=196:d=${d}`, "-f", "lavfi", "-i", `sine=f=294:d=${d}`);
  }

  const filters = [];
  let video = "[0:v]";
  if (ref) {
    // Cover-scale the reference slightly oversized, pan it across the frame,
    // and lay it over the gradient at partial opacity.
    filters.push(
      `[1:v]scale=${Math.round(width * 1.2)}:${Math.round(height * 1.2)}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:x='(iw-ow)*t/${d}':y='(ih-oh)/2',format=yuva420p,colorchannelmixer=aa=0.7[ref]`,
      `${video}[ref]overlay=0:0:shortest=1[bg]`,
    );
    video = "[bg]";
  }
  filters.push(
    `${video}drawtext=fontfile=${FONT}:textfile=${CAPTION_FILE}:fontsize=${fontSize}:fontcolor=white` +
    `:line_spacing=${Math.round(fontSize / 3)}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(fontSize / 1.5)}` +
    `:x=(w-text_w)/2:y=(h-text_h)/2:alpha='min(1,t/0.8)',` +
    `drawtext=fontfile=${FONT_BOLD}:textfile=${LABEL_FILE}:fontsize=${Math.round(fontSize * 0.6)}` +
    `:fontcolor=white@0.85:x=${fontSize}:y=${fontSize},` +
    `drawtext=fontfile=${FONT}:text='%{pts\\:hms}':fontsize=${Math.round(fontSize * 0.6)}` +
    `:fontcolor=white@0.85:x=w-text_w-${fontSize}:y=h-text_h-${fontSize},` +
    `fade=t=in:d=0.5,fade=t=out:st=${Math.max(0, d - 0.6)}:d=0.6,format=yuv420p[v]`,
  );
  if (job.audio) {
    const a = ref ? 2 : 1;
    filters.push(
      `[${a}:a][${a + 1}:a]amix=inputs=2,volume=0.15,afade=t=in:d=1,afade=t=out:st=${Math.max(0, d - 1)}:d=1[a]`,
    );
  }

  args.push("-filter_complex", filters.join(";"), "-map", "[v]");
  if (job.audio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "96k");
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-t", String(d), outputPath,
  );
  return args;
}

export const demoProvider = {
  id: "demo",

  async generate(job, { outputPath, onProgress, signal }) {
    const { width, height } = frameSize(job.aspectRatio);
    const workDir = path.join(path.dirname(outputPath), `.work-${crypto.randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });
    const charsPerLine = Math.max(16, Math.floor(width / (Math.min(width, height) / 18) / 0.62));

    try {
      if (!FONTS.regular || !FONTS.bold) throw new Error("DejaVu fonts not found; reinstall Framecast.");
      fs.copyFileSync(FONTS.regular, path.join(workDir, FONT));
      fs.copyFileSync(FONTS.bold, path.join(workDir, FONT_BOLD));
      fs.writeFileSync(path.join(workDir, CAPTION_FILE), wrap(job.prompt, charsPerLine, 5));
      fs.writeFileSync(path.join(workDir, LABEL_FILE), `DEMO · ${job.model.name} · ${job.resolution} · seed ${job.seed}`);

      await new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG, buildArgs(job, { width, height, outputPath }), { cwd: workDir, windowsHide: true });
        let stderr = "";
        const abort = () => ff.kill("SIGKILL");
        signal?.addEventListener("abort", abort, { once: true });
        ff.stderr.on("data", (c) => (stderr += c));
        ff.stdout.on("data", (chunk) => {
          const m = /out_time_us=(\d+)/g;
          let match, last;
          while ((match = m.exec(chunk.toString()))) last = match;
          if (last) onProgress?.(Math.min(0.99, Number(last[1]) / 1e6 / job.duration));
        });
        ff.on("error", reject);
        ff.on("close", (code) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(new Error("Cancelled"));
          else if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-400)}`));
        });
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    return {
      width,
      height,
      note: `Demo render at ${width}x${height}. A real provider would return ${job.resolution}.`,
    };
  },
};
