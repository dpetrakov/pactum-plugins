// «Documents» link contract v1 (EP-013-T03): one opener per window, withdrawn on unload, absent → callers show
// unavailable; leave other contract versions alone; the optional integration shares the same contract shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOCS_LINK_KEY, docsLink, docsLinkRevision, provideDocsLink, subscribeDocsLink } from "../docs-link-contract.ts";

test("provide, call, withdraw; a stale disposer does not remove a newer opener", () => {
  const scope = {};
  assert.equal(docsLink(scope), null, "absent until the plugin publishes it");
  let heard = 0;
  subscribeDocsLink(() => heard++, scope);
  const opened = [];
  const first = { contract: 1, open: (target) => { opened.push(target); return true; } };
  const dispose = provideDocsLink(first, scope);
  assert.equal(docsLink(scope).open({ hostId: "host_x", path: "/repo", doc: "docs/a.md" }), true);
  assert.deepEqual(opened, [{ hostId: "host_x", path: "/repo", doc: "docs/a.md" }]);
  const second = { contract: 1, open: () => true };
  const disposeSecond = provideDocsLink(second, scope);
  dispose();
  assert.equal(docsLink(scope), second, "a reload's newer opener survives the older disposer");
  disposeSecond();
  assert.equal(docsLink(scope), null);
  assert.ok(heard >= 3 && docsLinkRevision(scope) >= 3);
});

test("another contract major in the window is not overwritten", () => {
  const scope = { [DOCS_LINK_KEY]: { contract: 2 } };
  provideDocsLink({ contract: 1, open: () => true }, scope);
  assert.equal(docsLink(scope), null);
  assert.equal(scope[DOCS_LINK_KEY].contract, 2);
});

