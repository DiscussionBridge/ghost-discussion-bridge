import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const cmsVendor = Object.freeze({"candidate_id":"discussionbridge-v4-core-20261029-r7","wire_version":"v4","implementation_version":"0.4.0-alpha.1","release_version":null,"status":"implementation_candidate_not_exact_approved_not_frozen","runtime":Object.freeze({"source":"src/cms-runtime.mjs","bytes":338600,"sha256":"acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076"}),"schema":Object.freeze({"source":"src/cms-schema.json","bytes":117047,"sha256":"e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0"}),"normative":Object.freeze({"source":"normative/CONTRACT.json","bytes":190024,"sha256":"808042688cbde88fac0acdf1187e4cb8c251e13025bfcf09cf3a3c361ca02003"})});

let checked = false;
export function assertCmsVendor() {
  if (checked) return;
  for (const [name, member] of [["cms-runtime.mjs", cmsVendor.runtime], ["cms-schema.json", cmsVendor.schema]]) {
    const bytes = readFileSync(new URL(name, import.meta.url));
    if (bytes.length !== member.bytes || createHash("sha256").update(bytes).digest("hex") !== member.sha256) throw new Error("Ghost installed V4 shared artifact identity differs");
  }
  checked = true;
}

export const sourceArtifactIdentity = Object.freeze({ candidate_id: cmsVendor.candidate_id, wire_version: cmsVendor.wire_version, schema_sha256: cmsVendor.schema.sha256, runtime_sha256: cmsVendor.runtime.sha256 });
