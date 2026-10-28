// Model catalog shown in the UI. `provider` picks the adapter in lib/providers;
// every entry points at "demo" until a real provider is configured.
export const MODELS = [
  {
    id: "seedance-2.5",
    name: "Seedance 2.5",
    vendor: "ByteDance",
    provider: "demo",
    maxDuration: 30,
    durations: [5, 10, 15, 30],
    resolutions: ["720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "21:9"],
    audio: true,
    maxReferences: 4,
    creditsPerSecond: 6,
    blurb: "Long single-pass clips with native audio and multi-reference control.",
  },
  {
    id: "seedance-2.0",
    name: "Seedance 2.0",
    vendor: "ByteDance",
    provider: "demo",
    maxDuration: 15,
    durations: [5, 10, 15],
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: true,
    maxReferences: 3,
    creditsPerSecond: 4,
    blurb: "Fast, reliable motion for short social clips.",
  },
  {
    id: "lite",
    name: "Framecast Lite",
    vendor: "Framecast",
    provider: "demo",
    maxDuration: 10,
    durations: [5, 10],
    resolutions: ["720p"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: false,
    maxReferences: 1,
    creditsPerSecond: 1,
    blurb: "Cheap drafts to test ideas before a full render.",
  },
];

const RES_MULTIPLIER = { "720p": 1, "1080p": 1.5, "4k": 3 };

export const findModel = (id) => MODELS.find((m) => m.id === id);

export function creditCost(model, { duration, resolution, audio }) {
  const base = model.creditsPerSecond * duration * (RES_MULTIPLIER[resolution] ?? 1);
  return Math.ceil(base * (audio ? 1.2 : 1));
}

// Returns an error message, or null when the request fits the model.
export function validateRequest(model, req) {
  if (!model) return "Unknown model.";
  const prompt = (req.prompt ?? "").trim();
  if (prompt.length < 3) return "Write a prompt of at least 3 characters.";
  if (prompt.length > 2000) return "Prompts are limited to 2000 characters.";
  if (!model.durations.includes(req.duration)) return `${model.name} supports ${model.durations.join(", ")} second clips.`;
  if (!model.resolutions.includes(req.resolution)) return `${model.name} does not render ${req.resolution}.`;
  if (!model.aspectRatios.includes(req.aspectRatio)) return `${model.name} does not support ${req.aspectRatio}.`;
  if (req.audio && !model.audio) return `${model.name} cannot generate audio.`;
  if ((req.references?.length ?? 0) > model.maxReferences) return `${model.name} accepts up to ${model.maxReferences} reference images.`;
  return null;
}
