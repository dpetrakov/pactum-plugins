// Localization defaults to English with optional Russian and correct plural forms for both languages;
// batch prompts follow the window language; strict host calls carry that language, including initial loading.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { counted, forms, lang, setLang, tr } from "../core/i18n.ts";
import { hostContract } from "../host-contract.ts";
import { dispatchText, rpcContract } from "../server.ts";

const BOOK = () => forms(["comment", "comments"], ["замечание", "замечания", "замечаний"]);

test("English by default; tr and plural forms follow the chosen language", () => {
  assert.equal(lang(), "en");
  assert.equal(tr("Send to agent", "Передать агенту"), "Send to agent");
  assert.equal(counted(1, BOOK()), "1 comment");
  assert.equal(counted(21, BOOK()), "21 comments");
  setLang("ru");
  try {
    assert.equal(tr("Send to agent", "Передать агенту"), "Передать агенту");
    assert.deepEqual([1, 3, 5, 21].map((n) => counted(n, BOOK())), ["1 замечание", "3 замечания", "5 замечаний", "21 замечание"]);
  } finally {
    setLang("en");
  }
  setLang("de");
  assert.equal(lang(), "en", "an unknown language is ignored");
});

test("the batch prompt to the agent is in the window's language; commands stay the same", () => {
  const input = { runId: "run_1", items: 2, documents: ["docs/a.md"], requestedBy: { name: "Dim", email: "d@x" } };
  const english = dispatchText(input);
  assert.match(english, /^Document review batch \(document-review\) from Dim: 2 comments in docs\/a\.md/);
  assert.doesNotMatch(english, /[А-Яа-яЁё]/);
  setLang("ru");
  let russian;
  try {
    russian = dispatchText(input);
  } finally {
    setLang("en");
  }
  assert.match(russian, /^Пакет обзора документов \(document-review\) от Dim: 2 замечания в docs\/a\.md/);
  const commands = (text) => text.match(/bb document-review [a-z]+ [a-z]+ --run [\w<>]+/g);
  assert.deepEqual(commands(russian), commands(english));
});

test("review.lang takes en or ru; every host call takes lang and stays strict", () => {
  assert.equal(rpcContract["review.lang"].input.safeParse({ lang: "ru" }).success, true);
  assert.equal(rpcContract["review.lang"].input.safeParse({ lang: "de" }).success, false);
  for (const [name, method] of Object.entries(hostContract)) {
    const shape = method.input.shape;
    if (!shape) continue;
    assert.ok("lang" in shape, `${name} takes lang`);
    assert.equal(method.input.safeParse({ lang: "ru", unknownField: 1 }).success, false, `${name} stays strict`);
  }
});

test("the window chosen in Russian builds its wording in Russian at load", () => {
  // A separate process: the window fixes the language at load (ui/lang.ts reads localStorage before any wording).
  const script = `
    const store = new Map([["bb-workbench:lang:v1", "ru"]]);
    globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
    await import("./ui/lang.ts");
    const { VERB, W, counted } = await import("./ui/words.ts");
    const { AGENT_LABEL } = await import("./ui/labels.ts");
    console.log(JSON.stringify([VERB.send.button, counted(3, W.block), AGENT_LABEL.done]));`;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), ["Передать агенту", "3 блока", "Сделано"]);
});

test("the legacy Documents language key remains readable", async () => {
  const { readFileSync } = await import("node:fs");
  const script = `
    globalThis.localStorage = { getItem: (key) => key === "bbdr:lang:v1" ? "ru" : null };
    const { loadWindowLang } = await import("./core/i18n.ts");
    console.log(loadWindowLang());`;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(run.stdout.trim().split("\n").at(-1), "ru", run.stderr);

});
