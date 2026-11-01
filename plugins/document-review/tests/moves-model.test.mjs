import assert from "node:assert/strict";
import test from "node:test";
import { moveGroups, sureCandidate, splitPath } from "../ui/moves-model.ts";

const c = (path, extra = {}) => ({ path, exact: false, git: false, similarity: 0.5, ...extra });
test("missing files: one evident new path — accepted at once; no candidate — removed at once; the rest is asked", () => {
  const proposals = [
    { docId: "1", candidates: [c("a/new.md", { git: true })] },
    { docId: "2", candidates: [c("b/same.md", { exact: true })] },
    { docId: "3", candidates: [c("x.md", { git: true }), c("y.md", { git: true })] },
    { docId: "4", candidates: [c("z.md", { similarity: 0.8 })] },
    { docId: "5", candidates: [] },
    { docId: "6", candidates: [], local: true },
  ];
  const groups = moveGroups(proposals);
  assert.deepEqual(groups.sure.map((p) => p.docId), ["1", "2"]);
  assert.deepEqual(groups.gone.map((p) => p.docId), ["5"]);
  assert.deepEqual(groups.ask.map((p) => p.docId), ["3", "4", "6"], "a local file is forgotten one by one, never in bulk");
  assert.equal(sureCandidate(proposals[0]).path, "a/new.md");
  assert.equal(sureCandidate(proposals[3]), null);
  assert.deepEqual(splitPath("05-architecture/_archive/README.md"), { dir: "05-architecture/_archive/", name: "README.md" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
});
