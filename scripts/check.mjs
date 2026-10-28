import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const directory of ["src", "lib", "scripts", "public"]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.m?js$/u.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ["--check", `${directory}/${entry.name}`], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
