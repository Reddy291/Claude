import fs from "node:fs";
import path from "node:path";

// Tiny JSON-file store. Writes go through a temp file + rename so a crash
// mid-write never leaves a truncated database behind.
export class Store {
  constructor(dataDir, { startingCredits }) {
    this.file = path.join(dataDir, "db.json");
    this.state = { credits: startingCredits, generations: [] };
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get credits() {
    return this.state.credits;
  }

  adjustCredits(delta) {
    this.state.credits += delta;
    this.save();
  }

  list() {
    return [...this.state.generations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.state.generations.find((g) => g.id === id);
  }

  insert(gen) {
    this.state.generations.push(gen);
    this.save();
  }

  update(id, patch) {
    const gen = this.get(id);
    if (!gen) return;
    Object.assign(gen, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return gen;
  }

  remove(id) {
    this.state.generations = this.state.generations.filter((g) => g.id !== id);
    this.save();
  }
}
