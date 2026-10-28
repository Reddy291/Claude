const $ = (sel) => document.querySelector(sel);

const state = {
  models: [],
  generations: [],
  references: [], // data URLs
  filter: "all",
  pollTimer: null,
};

const SURPRISE_PROMPTS = [
  "A lighthouse keeper's cat watching a storm roll in over the sea, warm window light, slow push-in",
  "Macro shot of a dew drop sliding off a fern leaf at sunrise, shallow depth of field",
  "A vintage tram climbing a steep hill in Lisbon at golden hour, handheld documentary style",
  "An origami crane unfolding into a real bird and flying out of an open book, studio lighting",
  "Drone shot gliding over a misty pine forest, revealing a hidden turquoise lake",
  "A street food vendor flipping noodles in a flaming wok at night, sparks and steam, 120fps slow motion",
];

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4500);
}

const setCredits = (n) => ($("#credits").textContent = n.toLocaleString());

// ---------- Form ----------

const currentModel = () => state.models.find((m) => m.id === $("#models input:checked")?.value);

function radioGroup(container, name, values, selected, render = (v) => v) {
  container.replaceChildren(
    ...values.map((v) => {
      const label = document.createElement("label");
      const input = Object.assign(document.createElement("input"), { type: "radio", name, value: v });
      input.checked = String(v) === String(selected);
      const span = document.createElement("span");
      span.append(render(v));
      label.append(input, span);
      return label;
    }),
  );
}

function ratioIcon(ratio) {
  const frag = document.createDocumentFragment();
  const [w, h] = ratio.split(":").map(Number);
  const scale = 18 / Math.max(w, h);
  const shape = document.createElement("i");
  shape.className = "ratio-shape";
  shape.style.width = `${Math.round(w * scale)}px`;
  shape.style.height = `${Math.round(h * scale)}px`;
  frag.append(shape, ratio);
  return frag;
}

const pick = (name) => $(`input[name=${name}]:checked`)?.value;

// Re-render the option groups for the selected model, keeping the user's
// choices whenever the new model still supports them.
function applyModel(preferred = {}) {
  const model = currentModel();
  if (!model) return;
  const keep = (name, options, fallback) => {
    const want = preferred[name] ?? pick(name);
    return options.map(String).includes(String(want)) ? want : fallback;
  };
  radioGroup($("#durations"), "duration", model.durations,
    keep("duration", model.durations, model.durations[Math.min(1, model.durations.length - 1)]), (d) => `${d}s`);
  radioGroup($("#ratios"), "aspectRatio", model.aspectRatios, keep("aspectRatio", model.aspectRatios, model.aspectRatios[0]), ratioIcon);
  radioGroup($("#resolutions"), "resolution", model.resolutions,
    keep("resolution", model.resolutions, model.resolutions.includes("1080p") ? "1080p" : model.resolutions[0]),
    (r) => r.toUpperCase());

  $("#audioRow").classList.toggle("disabled", !model.audio);
  if (!model.audio) $("#audio").checked = false;
  else if (preferred.audio !== undefined) $("#audio").checked = preferred.audio;

  if (state.references.length > model.maxReferences) {
    state.references.length = model.maxReferences;
    toast(`${model.name} accepts ${model.maxReferences} reference image${model.maxReferences > 1 ? "s" : ""}; extras were removed.`);
  }
  renderRefs();
  updateQuote();
}

function renderModels() {
  $("#models").replaceChildren(
    ...state.models.map((m, i) => {
      const label = document.createElement("label");
      label.className = "model";
      label.innerHTML = `<input type="radio" name="model"><strong></strong><span class="vendor"></span><p></p>`;
      const input = label.querySelector("input");
      input.value = m.id;
      input.checked = i === 0;
      label.querySelector("strong").textContent = m.name;
      label.querySelector(".vendor").textContent = `${m.vendor} · up to ${m.maxDuration}s`;
      label.querySelector("p").textContent = m.blurb;
      return label;
    }),
  );
}

function renderRefs() {
  const model = currentModel();
  const max = model?.maxReferences ?? 0;
  $("#refLimit").textContent = `${state.references.length}/${max}`;
  $("#dropzone").classList.toggle("disabled", state.references.length >= max);
  $("#refs").replaceChildren(
    ...state.references.map((src, i) => {
      const div = document.createElement("div");
      div.className = "ref";
      const img = Object.assign(document.createElement("img"), { src, alt: `Reference ${i + 1}` });
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "✕", ariaLabel: "Remove reference" });
      remove.onclick = () => {
        state.references.splice(i, 1);
        renderRefs();
      };
      div.append(img, remove);
      return div;
    }),
  );
}

async function addReferences(files) {
  const max = currentModel()?.maxReferences ?? 0;
  for (const file of files) {
    if (state.references.length >= max) {
      toast(`This model accepts up to ${max} reference image${max === 1 ? "" : "s"}.`);
      break;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast(`${file.name}: only PNG, JPEG or WebP.`, "error");
      continue;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast(`${file.name} is over 8 MB.`, "error");
      continue;
    }
    state.references.push(await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }));
  }
  renderRefs();
}

function formValues() {
  const seed = $("#seed").value.trim();
  return {
    model: currentModel()?.id,
    prompt: $("#prompt").value,
    negativePrompt: $("#negativePrompt").value,
    duration: Number(pick("duration")),
    aspectRatio: pick("aspectRatio"),
    resolution: pick("resolution"),
    audio: $("#audio").checked,
    seed: seed === "" ? undefined : Number(seed),
    references: state.references,
  };
}

let quoteSeq = 0;
async function updateQuote() {
  const { model, duration, resolution, audio } = formValues();
  if (!model) return;
  const seq = ++quoteSeq;
  try {
    const { cost } = await api("/quote", { method: "POST", body: JSON.stringify({ model, duration, resolution, audio }) });
    if (seq === quoteSeq) $("#cost").textContent = `${cost} credits`;
  } catch {
    $("#cost").textContent = "";
  }
}

async function submit(event) {
  event.preventDefault();
  const button = $("#generate");
  button.disabled = true;
  try {
    const { generation, credits } = await api("/generations", { method: "POST", body: JSON.stringify(formValues()) });
    setCredits(credits);
    state.generations.unshift(generation);
    if (state.filter === "succeeded" || state.filter === "failed") setFilter("all");
    renderGallery();
    schedulePoll();
    toast("Generation queued.", "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

function remix(gen) {
  const radio = $(`#models input[value="${CSS.escape(gen.model)}"]`);
  if (radio) radio.checked = true;
  $("#prompt").value = gen.prompt;
  $("#negativePrompt").value = gen.negativePrompt ?? "";
  $("#seed").value = gen.seed;
  if (gen.negativePrompt) $(".advanced").open = true;
  updatePromptCount();
  applyModel({ duration: gen.duration, aspectRatio: gen.aspectRatio, resolution: gen.resolution, audio: gen.audio });
  $("#prompt").focus();
  $("#create").scrollIntoView({ behavior: "smooth", block: "start" });
}

const updatePromptCount = () => ($("#promptCount").textContent = $("#prompt").value.length);

// ---------- Gallery ----------

const isActive = (g) => g.status === "queued" || g.status === "processing";

function setFilter(filter) {
  state.filter = filter;
  for (const b of document.querySelectorAll("#filters button")) b.classList.toggle("active", b.dataset.filter === filter);
  renderGallery();
}

function visibleGenerations() {
  const f = state.filter;
  return state.generations.filter((g) => f === "all" || (f === "active" ? isActive(g) : g.status === f));
}

function chip(text) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = text;
  return span;
}

function button(text, onClick, extra = "") {
  const b = Object.assign(document.createElement("button"), { type: "button", className: `btn ${extra}`, textContent: text });
  b.onclick = onClick;
  return b;
}

function renderCard(gen) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = gen.id;

  const media = document.createElement("div");
  media.className = "media";
  const [w, h] = gen.aspectRatio.split(":").map(Number);
  media.style.aspectRatio = w / h >= 1 ? "16 / 9" : "4 / 5";

  if (gen.status === "succeeded") {
    const img = Object.assign(document.createElement("img"), { src: gen.thumbnailUrl, alt: gen.prompt, loading: "lazy" });
    media.append(img);
    media.append(Object.assign(document.createElement("span"), { className: "duration", textContent: `${gen.duration}s` }));
    // Preview on hover, open the player on click.
    let video;
    media.onmouseenter = () => {
      video = Object.assign(document.createElement("video"), { src: gen.videoUrl, muted: true, loop: true, playsInline: true });
      media.append(video);
      video.play().catch(() => {});
    };
    media.onmouseleave = () => video?.remove();
    media.onclick = () => openViewer(gen);
  } else {
    const status = document.createElement("div");
    status.className = `status ${gen.status}`;
    const label = document.createElement("div");
    label.className = "label";
    const sub = document.createElement("div");
    sub.className = "sub";
    if (gen.status === "failed") {
      label.textContent = gen.error === "Cancelled." ? "Cancelled" : "Generation failed";
      sub.textContent = gen.error === "Cancelled." ? `${gen.cost} credits refunded` : `${gen.error} · ${gen.cost} credits refunded`;
      status.append(label, sub);
    } else {
      const pct = Math.round(gen.progress * 100);
      label.textContent = gen.status === "queued" ? "Queued" : `Rendering… ${pct}%`;
      sub.textContent = `${gen.modelName} · ${gen.duration}s · ${gen.resolution}`;
      const bar = document.createElement("div");
      bar.className = `bar ${gen.status === "queued" ? "indeterminate" : ""}`;
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(3, pct)}%`;
      bar.append(fill);
      status.append(label, bar, sub);
    }
    media.append(status);
  }

  const body = document.createElement("div");
  body.className = "card-body";
  const prompt = Object.assign(document.createElement("p"), { className: "card-prompt", textContent: gen.prompt, title: gen.prompt });
  const chips = document.createElement("div");
  chips.className = "chips";
  chips.append(chip(gen.modelName), chip(gen.aspectRatio), chip(gen.resolution.toUpperCase()));
  if (gen.audio) chips.append(chip("Audio"));
  if (gen.references.length) chips.append(chip(`${gen.references.length} ref`));

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (gen.status === "succeeded") {
    actions.append(
      button("Play", () => openViewer(gen), "grow"),
      Object.assign(document.createElement("a"), { className: "btn", href: `${gen.videoUrl}?download`, textContent: "Download" }),
      button("Remix", () => remix(gen)),
    );
  } else if (isActive(gen)) {
    actions.append(button("Cancel", () => cancel(gen), "grow danger"));
  } else {
    actions.append(button("Retry", () => remix(gen), "grow"));
  }
  if (!isActive(gen)) actions.append(button("Delete", () => remove(gen), "danger"));

  body.append(prompt, chips, actions);
  card.append(media, body);
  return card;
}

function renderGallery() {
  const list = visibleGenerations();
  // Keep a card whose hover preview is playing; re-rendering it would restart the video.
  const hovering = document.querySelector(".card .media:hover")?.closest(".card")?.dataset.id;
  const existing = new Map([...document.querySelectorAll("#grid .card")].map((c) => [c.dataset.id, c]));
  $("#grid").replaceChildren(
    ...list.map((g) => (g.id === hovering && g.status === "succeeded" && existing.has(g.id) ? existing.get(g.id) : renderCard(g))),
  );
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  empty.querySelector("p").textContent = state.generations.length
    ? "Nothing in this view."
    : "No videos yet. Describe a scene and press Generate.";
}

async function cancel(gen) {
  try {
    const { credits } = await api(`/generations/${gen.id}/cancel`, { method: "POST" });
    setCredits(credits);
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function remove(gen) {
  if (!confirm("Delete this video? This cannot be undone.")) return;
  try {
    await api(`/generations/${gen.id}`, { method: "DELETE" });
    state.generations = state.generations.filter((g) => g.id !== gen.id);
    renderGallery();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function refresh() {
  const previous = new Map(state.generations.map((g) => [g.id, g.status]));
  const { generations, credits } = await api("/generations");
  state.generations = generations;
  setCredits(credits);
  for (const g of generations) {
    const before = previous.get(g.id);
    if (before && before !== g.status && g.status === "succeeded") toast("Your video is ready.", "success");
    if (before && before !== g.status && g.status === "failed" && g.error !== "Cancelled.") toast(`Generation failed: ${g.error}`, "error");
  }
  renderGallery();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.generations.some(isActive)) {
    state.pollTimer = setTimeout(() => refresh().catch(() => schedulePoll()), 1200);
  }
}

// ---------- Viewer ----------

function openViewer(gen) {
  const video = $("#viewerVideo");
  video.src = gen.videoUrl;
  video.poster = gen.thumbnailUrl;
  $("#viewerPrompt").textContent = gen.prompt;
  const meta = {
    Model: gen.modelName,
    Duration: `${gen.duration}s`,
    "Aspect ratio": gen.aspectRatio,
    Resolution: gen.resolution.toUpperCase(),
    Audio: gen.audio ? "Yes" : "No",
    Seed: gen.seed,
    Credits: gen.cost,
    Created: new Date(gen.createdAt).toLocaleString(),
  };
  if (gen.negativePrompt) meta["Negative"] = gen.negativePrompt;
  $("#viewerMeta").replaceChildren(
    ...Object.entries(meta).flatMap(([k, v]) => [
      Object.assign(document.createElement("dt"), { textContent: k }),
      Object.assign(document.createElement("dd"), { textContent: String(v) }),
    ]),
  );
  $("#viewerNote").textContent = gen.note ?? "";
  $("#viewerDownload").href = `${gen.videoUrl}?download`;
  $("#viewerRemix").onclick = () => {
    $("#viewer").close();
    remix(gen);
  };
  $("#viewer").showModal();
  video.play().catch(() => {});
}

// ---------- Boot ----------

async function init() {
  const [{ models }, _] = await Promise.all([api("/models"), refresh()]);
  state.models = models;
  renderModels();
  applyModel();

  $("#models").addEventListener("change", () => applyModel());
  for (const id of ["#durations", "#resolutions", "#audioRow"]) $(id).addEventListener("change", updateQuote);
  $("#create").addEventListener("submit", submit);
  $("#prompt").addEventListener("input", updatePromptCount);
  $("#surprise").onclick = () => {
    $("#prompt").value = SURPRISE_PROMPTS[Math.floor(Math.random() * SURPRISE_PROMPTS.length)];
    updatePromptCount();
  };
  $("#refInput").addEventListener("change", (e) => {
    addReferences([...e.target.files]);
    e.target.value = "";
  });
  const drop = $("#dropzone");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    addReferences([...e.dataTransfer.files]);
  });
  $("#filters").addEventListener("click", (e) => {
    if (e.target.dataset.filter) setFilter(e.target.dataset.filter);
  });
  $("#viewer").addEventListener("close", () => $("#viewerVideo").pause());
  $("#viewer").addEventListener("click", (e) => {
    if (e.target === $("#viewer")) $("#viewer").close();
  });
}

init().catch((err) => toast(`Could not load the studio: ${err.message}`, "error"));
