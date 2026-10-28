# Framecast

A small AI video studio: write a prompt, add reference images, pick a model,
length, aspect ratio and resolution, and get back a video in a gallery you can
play, download, remix or delete. Generations run in a background queue and are
paid for with credits, which are refunded when a job fails or is cancelled.

It currently runs in **demo mode**: the `demo` provider renders a placeholder
MP4 locally with ffmpeg (animated gradient, your first reference image, the
prompt as a caption, optional tone for audio) so the whole flow works without a
paid API.

## Run

Requires Node 20+ and `ffmpeg` on the PATH. No npm dependencies.

```bash
npm start            # http://127.0.0.1:3000
```

Environment variables: `PORT`, `HOST`, `FRAMECAST_DATA` (default `./data`),
`FRAMECAST_CREDITS` (starting balance for a new database, default 500).

## Windows installer

```bash
packaging/windows/build.sh
```

Builds `dist/Framecast-Setup-<version>.exe` (64-bit NSIS installer) and a
portable `dist/Framecast-<version>-win-x64.zip` from Linux. It needs `makensis`
(NSIS 3), `osslsigncode`, `zip`, `curl` and `npm`. It downloads the Windows
Node.js runtime and a Windows ffmpeg build, checks their SHA-256 against the
publishers' lists, embeds the app into `Framecast.exe` as a Node single
executable, and bundles ffmpeg and the DejaVu fonts next to it.

The installer installs per user to `%LOCALAPPDATA%\Programs\Framecast` (no
admin prompt), adds Start menu and optional desktop shortcuts, and registers an
uninstaller in Settings > Apps. Videos and credits live in
`%LOCALAPPDATA%\Framecast\data` and survive upgrades. Running `Framecast.exe`
starts the server and opens the browser; a second launch reuses the running
copy. The executables are unsigned, so Windows SmartScreen will warn on first
run until they are signed with a code-signing certificate.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server: JSON API, static files, video serving with Range support |
| `lib/models.js` | Model catalog, credit pricing, request validation |
| `lib/jobs.js` | Queue (2 concurrent), credits, uploads, thumbnails, cancel/refund |
| `lib/store.js` | JSON-file persistence (`data/db.json`) |
| `lib/providers/` | Video backends; `demo.js` is the ffmpeg renderer |
| `public/` | Browser UI (vanilla JS) |

## API

| Method | Route | |
| --- | --- | --- |
| GET | `/api/models` | Model catalog |
| GET | `/api/account` | Credit balance |
| POST | `/api/quote` | Credit cost for `{model, duration, resolution, audio}` |
| GET | `/api/generations` | All generations, newest first |
| POST | `/api/generations` | Create: `{model, prompt, negativePrompt?, duration, aspectRatio, resolution, audio, seed?, references?: [dataUrl]}` |
| GET | `/api/generations/:id` | One generation |
| POST | `/api/generations/:id/cancel` | Cancel a queued or running job (refunds) |
| DELETE | `/api/generations/:id` | Delete a finished job and its files |

## Adding a real video model

Write an adapter in `lib/providers/` with the same shape as `demo.js`:

```js
export const myProvider = {
  id: "my-provider",
  async generate(job, { outputPath, onProgress, signal }) {
    // 1. submit job.prompt, job.duration, job.aspectRatio, job.referencePaths... to the vendor API
    // 2. poll its status, calling onProgress(0..1); stop if signal.aborted
    // 3. download the finished MP4 to outputPath
    return { width, height };
  },
};
```

Register it in `lib/providers/index.js`, set `provider: "my-provider"` on the
models in `lib/models.js`, and keep the API key in an environment variable,
never in the browser.

## Not included yet

User accounts and auth, real payments, content moderation of prompts and
uploads, and cloud storage for videos. All of these are needed before running
this for other people.
