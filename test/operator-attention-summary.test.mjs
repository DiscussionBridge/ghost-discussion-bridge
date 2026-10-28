import assert from "node:assert/strict";
import test from "node:test";
import { renderOperatorPage } from "../src/operator-surface.mjs";

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", operatorPassword: "p".repeat(32) };
const current = () => ({ version: 1, posts: {}, publications: {}, presentations: {} });
const count = state => {
  const html = renderOperatorPage(config, state);
  const match = /<strong>(\d+)<\/strong><span>Records needing attention<\/span>/.exec(html);
  assert.ok(match); return Number(match[1]);
};

test("operator attention summary includes To attention and reconciliation records", () => {
  const state = current();
  state.posts.one = { outcome: "attention" };
  state.posts.two = { outcome: "reconciliation_required" };
  assert.equal(count(state), 2);
});
test("operator attention summary retains From pending and attention records", () => {
  const state = current();
  state.publications.one = { state: "attention" };
  state.publications.two = { state: "pending" };
  assert.equal(count(state), 2);
});
test("operator attention summary deduplicates a shared resource across directions", () => {
  const state = current();
  state.posts.one = { outcome: "attention", resource_id: "11111111-1111-4111-8111-111111111111" };
  state.posts.two = { outcome: "reconciliation_required" };
  state.publications["11111111-1111-4111-8111-111111111111"] = { state: "attention" };
  state.publications.other = { state: "pending" };
  assert.equal(count(state), 3);
});
test("operator attention summary preserves an unscoped synchronization failure", () => {
  const state = current(); state.posts.one = { outcome: "attention" };
  state.publication_sync = { summary: { errors: [{ resource_id: null, reason: "Needs reconciliation" }] } };
  assert.equal(count(state), 2);
});
test("operator attention summary is zero for empty or healthy mapped content", () => {
  const state = current(); assert.equal(count(state), 0);
  state.posts.one = { outcome: "created" }; state.publications.two = { state: "complete" };
  assert.equal(count(state), 0);
});
test("operator attention summary does not equate unrelated native keys across directions", () => {
  const state = current(); state.posts.same = { outcome: "attention" };
  state.publications.same = { state: "attention" }; assert.equal(count(state), 2);
});
test("operator attention summary counts repeated errors for one explicit resource only once", () => {
  const state = current(), resourceId = "11111111-1111-4111-8111-111111111111";
  state.posts.one = { outcome: "attention", resource_id: resourceId };
  state.publication_sync = { summary: { errors: [
    { resource_id: resourceId, reason: "First failure" }, { resource_id: resourceId, reason: "Repeated failure" },
  ] } };
  assert.equal(count(state), 1);
});
