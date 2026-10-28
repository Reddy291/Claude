import { demoProvider } from "./demo.js";

// A provider turns a generation request into a video file on disk.
//
//   generate(job, { outputPath, onProgress, signal }) -> Promise<{ width, height, note? }>
//
// job: { prompt, negativePrompt, duration, resolution, aspectRatio, audio,
//        seed, model, referencePaths }
// onProgress(fraction 0..1) may be called any number of times.
//
// To add a real backend (OpenRouter, fal.ai, BytePlus...), write an adapter
// that submits the job to the vendor, polls until done, downloads the MP4 to
// outputPath, then register it here and point a model's `provider` at it.
const PROVIDERS = {
  demo: demoProvider,
};

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`No provider registered for "${id}"`);
  return provider;
}
