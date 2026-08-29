import { dirname } from "node:path";
import { mkdir, open, readFile, rename } from "node:fs/promises";

export class StateStore {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || parsed.version !== 1 || typeof parsed.posts !== "object" || typeof parsed.presentations !== "object") throw new Error();
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, posts: {}, presentations: {} };
      throw new Error("Invalid DiscussionBridge state file");
    }
  }

  async write(state) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.path);
  }
}
