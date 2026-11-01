// EP-042 / EP-043 (W-06c): what the “Raw” and «Pretty» views rely on — the syntax roles of every format (F22),
// tokens never overlap and stay inside the line, multi-line state (YAML block scalars, TOML multi-line strings, JSONC
// block comments, CSV quoted fields), masks keep no role of a value; “Raw” of the host: the redacted source, the
// lines of every block and the foldable ranges; key paths in the three forms people copy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { highlightLines } from "../core/formats/highlight.ts";
import { dottedPath, jqPath, jsonPointer } from "../core/formats/paths.ts";
import { ReviewService } from "../node/service.ts";
import { documentText } from "../node/view.ts";

const roles = (language, text) => {
  const lines = text.split("\n");
  const tokens = highlightLines(language, lines);
  tokens.forEach((list, row) => {
    let last = 0;
    for (const token of list) {
      assert.ok(token.s >= last && token.e > token.s && token.e <= lines[row].length, `${language} line ${row + 1}: ${JSON.stringify(token)}`);
      last = token.e;
    }
  });
  return tokens.map((list, row) => list.map((token) => `${token.role}:${lines[row].slice(token.s, token.e)}`));
};

test("EP-042-T01 syntax roles of every format, line by line with the multi-line state", () => {
  const yaml = roles("yaml", "# c\nkey: \"v\"\nn: 12\nflag: true\nref: *anchor\nblock: |\n  text: not a key\nnext: 1");
  assert.ok(yaml[0].includes("c:# c"));
  assert.ok(yaml[1].includes("k:key") && yaml[1].some((t) => t.startsWith("s:")));
  assert.ok(yaml[2].includes("n:12") && yaml[3].includes("l:true") && yaml[4].some((t) => t.startsWith("l:*anchor")));
  assert.ok(!yaml[6].includes("k:text"), "inside a block scalar nothing is a key");
  assert.ok(yaml[7].includes("k:next"), "the block scalar ends with the indentation");
  const json = roles("json", '{\n  "a": "x", /* c\n still */ "b": 1\n}');
  assert.ok(json[1].includes('k:"a"') && json[1].includes('s:"x"'));
  assert.ok(json[2].some((t) => t.startsWith("c:")), "a JSONC block comment continues on the next line");
  assert.ok(json[2].includes('k:"b"') && json[2].includes("n:1"));
  const toml = roles("toml", '[server]\nport = 8080\nnote = """\nmulti = not a key\n"""\nok = false');
  assert.ok(toml[0].some((t) => t.startsWith("h:")) && toml[1].includes("k:port") && toml[1].includes("n:8080"));
  assert.ok(!toml[3].includes("k:multi"), "inside a multi-line string nothing is a key");
  assert.ok(toml[5].includes("k:ok") && toml[5].includes("l:false"));
  const env = roles("dotenv", "# top\nexport A=1\nB=\"x\" # tail");
  assert.ok(env[0].includes("c:# top") && env[1].includes("k:A") && env[2].includes("c:# tail"));
  const csv = roles("csv", 'id,name\n1,"a,\nb",3');
  assert.ok(csv[0].includes("c0:id") && csv[0].includes("c1:name"));
  assert.ok(csv[2].some((t) => t.startsWith("c1:")) && csv[2].some((t) => t.startsWith("c2:")), "a quoted field spans lines; the column count goes on");
  const md = roles("markdown", "# Title\n\n```\n# not a heading\n```");
  assert.ok(md[0].some((t) => t.startsWith("d:")) && !md[3].some((t) => t.startsWith("d:")));
  assert.deepEqual(roles("text", "plain"), [[]]);
});

test("EP-043-T01 key paths in the three forms people copy", () => {
  const p = ["services", "api", "env", 1, "value"];
  assert.equal(dottedPath(p), "services.api.env[1].value");
  assert.equal(jsonPointer(p), "/services/api/env/1/value");
  assert.equal(jqPath(p), ".services.api.env[1].value");
  assert.equal(dottedPath([{ doc: 1 }, "a b", "c"]), '[document 2]["a b"].c');
  assert.equal(jsonPointer(["a/b", "c~d"]), "/a~1b/c~0d");
});

test("EP-042-T01/T03 the host's «Как есть»: the redacted source, the lines of every block, foldable ranges", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-view-")));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "bb-docs-view-data-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "owner@bb-docs.invalid");
    git("config", "user.name", "Owner");
    await fs.mkdir(path.join(dir, "config"));
    await fs.writeFile(path.join(dir, "config/app.yaml"), "server:\n  host: h\n  password: hunter2hunter2\nlist:\n  - a\n  - b\n");
    await fs.writeFile(path.join(dir, "config/app.json"), '{\n  "a": {\n    "b": 1\n  },\n  "c": 2\n}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const service = new ReviewService(dir, data);
    const text = await documentText(service, "config/app.yaml", { source: true });
    assert.ok(!text.source.includes("hunter2"), "the source is the redacted form");
    assert.equal(text.source.split("\n").length, 7, "the same lines as the file");
    assert.equal(text.blockLines.length, text.total);
    const password = text.meta.findIndex((entry) => entry?.key === "password");
    assert.deepEqual(text.blockLines[password], [3, 3]);
    assert.deepEqual(text.folds.map((fold) => [fold.line, fold.end]), [[1, 3], [4, 6]]);
    const secret = text.secrets[0];
    assert.equal(text.source.slice(secret.start, secret.end).replace(/[^•]/g, "").length, 8, "the mask of the value at the secret's range");
    const json = await documentText(service, "config/app.json", { source: true });
    assert.deepEqual(json.folds.map((fold) => [fold.line, fold.end]), [[2, 4]], "a JSON group folds to its closing bracket");
  } finally {
    await Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]);
  }
});
