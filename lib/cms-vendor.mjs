import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const cmsVendor = Object.freeze({
  candidate_id: "discussionbridge-v4-core-20261025-r6",
  wire_version: "v4",
  implementation_version: "0.4.0-alpha.1",
  release_version: null,
  status: "implementation_candidate_not_exact_approved_not_frozen",
  runtime: Object.freeze({ source: "v4/adapter-contract/src/cms-runtime.mjs", bytes: 35144, sha256: "e1790fd800abcae9772d327625ea188f04ec68c63ce7917cb0785f5cdea22538" }),
  schema: Object.freeze({ source: "v4/adapter-contract/src/cms-schema.json", bytes: 115670, sha256: "8563a9b1346e3bf82635bd65a46bb1e25415a1003d7432f8fcb8c1c6e4f03c14" }),
  normative: Object.freeze({ source: "v4/adapter-contract/normative/CONTRACT.json", bytes: 187682, sha256: "df31c5d2fc387a8b12b388438450eccd97966de34c82b1bf417634b21a36b495" }),
});

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
