import { createHash } from "node:crypto";
import { validateCms } from "../lib/cms-runtime.mjs";
import { nativeTopicUrl } from "./topic-identity.mjs";

const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const sourceKey = (id, revision) => createHash("sha256").update(JSON.stringify([id, revision])).digest("hex");

// Native registration authorizes this local presentation, not a new resolve or
// publication. Current scoped metadata/chunk reads remain server-side only.
export async function readGhostPresentation(config, store, client, resourceId) {
  validateCms("UUID", resourceId);
  const local = await store.read(), publication = local.publications[resourceId];
  check(local.presentations[resourceId] && publication?.cms?.mapping_id, "Ghost presentation has no current owned native mapping");
  const connection = await client.connection(); validateCms("Connection", connection);
  check(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("from_discourse") && connection.policy.enabled && (!config.lane || connection.publication_lane === config.lane), "Ghost current presentation source scope is unavailable");
  check(local.cms_feed?.binding?.scope_revision === connection.scope_revision && local.cms_feed.binding.policy_revision === connection.policy.policy_revision, "Ghost presentation metadata requires current scope/policy synchronization");
  const record = await client.sourceRecord(resourceId); validateCms("Record", record);
  check(record.resource_id === resourceId && record.direction === "from_discourse" && record.mapping_id === publication.cms.mapping_id && record.external_id === publication.cms.external_id && record.canonical_url === publication.canonical_url && record.topic_id === String(publication.topic_id), "Ghost presentation source binding differs");
  nativeTopicUrl(record.topic_url, config.serverUrl, record.topic_id);
  if (record.state === "withdrawn") return record;
  check(record.state === "active" && record.source_revision, "Ghost current presentation publication is unavailable");
  const mapping = await client.mapping(record.mapping_id); validateCms("Mapping", mapping);
  check(mapping.connection_id === config.connectionId && mapping.resource_id === resourceId && mapping.mapping_id === record.mapping_id && mapping.source_id === publication.cms.source_id && mapping.external_id === record.external_id && mapping.canonical_url === record.canonical_url && mapping.desired_source_revision === record.source_revision, "Ghost presentation mapping/source revision differs");
  const mode = connection.policy.presentation_mode;
  check(connection.native_capabilities.supported_presentations.includes(mode) && mapping.presentation_mode === mode, "Ghost presentation mode is unavailable or differs from current policy");
  const source = local.cms_feed.sources[sourceKey(mapping.source_id, record.source_revision)];
  validateCms("Source", source);
  check(source.source_id === mapping.source_id && source.source_revision === record.source_revision && source.topic_id === record.topic_id && source.topic_url === record.topic_url, "Ghost presentation immutable source descriptor differs");
  const complete = await client.completeSource(source);
  return { ...record, topic_url: source.topic_url, content_html: complete.html, presentation_mode: mode, forum_name: connection.forum_name };
}
