import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

// True when running as the packaged single-executable (Framecast.exe).
// Packaged builds keep their files next to the executable and their data in
// the user's profile, since the install folder may not be writable.
export const IS_PACKAGED = isSea();

export const APP_ROOT = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PUBLIC_DIR = path.join(APP_ROOT, "public");

export const DATA_DIR =
  process.env.FRAMECAST_DATA ??
  (IS_PACKAGED
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Framecast", "data")
    : path.join(APP_ROOT, "data"));

const exe = process.platform === "win32" ? ".exe" : "";
const bundledFfmpeg = path.join(APP_ROOT, "ffmpeg", `ffmpeg${exe}`);
export const FFMPEG = process.env.FRAMECAST_FFMPEG ?? (fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");

// Fonts ship in ./fonts for packaged builds; fall back to the system DejaVu install on Linux.
const fontPath = (name) =>
  [path.join(APP_ROOT, "fonts", name), path.join("/usr/share/fonts/truetype/dejavu", name)].find((p) =>
    fs.existsSync(p),
  );
export const FONTS = { regular: fontPath("DejaVuSans.ttf"), bold: fontPath("DejaVuSans-Bold.ttf") };
