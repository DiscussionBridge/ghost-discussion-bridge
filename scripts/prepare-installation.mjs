import { parseArgs } from "node:util";
import { installationDiagnostic, prepareInstallation } from "../src/installation.mjs";

try {
  const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, user: { type: "string" }, help: { type: "boolean" } }, allowPositionals: false });
  if (values.help) {
    process.stdout.write("Usage: npm run prepare:install -- --config /absolute/adapter.env --output /new/absolute/directory --user non_root_account\nValidates and prepares only; never activates, enrolls or overwrites. See docs/INSTALLATION.md.\n");
  } else {
    const result = await prepareInstallation({ configFile: values.config, outputDirectory: values.output, user: values.user });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  // Never include protected-file contents or arbitrary parser input in logs.
  process.stderr.write(`Installation preparation failed. ${installationDiagnostic(error)} Nothing was activated.\n`);
  process.exitCode = 1;
}
