// EP-039-T02/T07: the secret classifier and the redacted form in the core — every canary of every format is inside a
// secret span, the redacted form keeps line numbers and parses, classification of the redacted form reveals nothing,
// rule levels (built-in ∪ repository for shared data, ∪ global for the user's own outputs), narrowing is refused, a
// mask-only change is not an edit, exemptions by key path with element fingerprints and the protection from shifts.
import assert from "node:assert/strict";
import test from "node:test";
import { projectFile } from "../core/formats/project.ts";
import { classify, exemptionKeyPath, isRedactedFixedPoint, looksExplicit, MASK, patternProblem, rulesHash } from "../core/formats/secrets.ts";
import { parseStructured } from "../core/formats/structured.ts";
import { sha256 } from "../core/hash.ts";
import { buildRevision } from "../core/markdown/index.ts";
import { canaries, fixtures } from "./leak-fixtures.mjs";

const c = canaries();
const files = fixtures(c);

test("EP-039-T02 every canary of every format falls inside a secret span; the redacted form has no canary and the same lines", () => {
  for (const [file, source] of Object.entries(files)) {
    if (file === ".gitignore") continue;
    const result = classify(file, source);
    for (const [name, value] of Object.entries(c)) {
      if (!source.includes(value)) continue;
      const at = source.indexOf(value);
      assert.ok(result.spans.some((span) => span.start <= at && at + value.length <= span.end), `${file}: ${name} is inside a secret span`);
      assert.ok(!result.redacted.includes(value), `${file}: ${name} is not in the redacted form`);
      assert.ok(!result.redacted.includes(value.slice(0, 6)), `${file}: no prefix of ${name}`);
    }
    assert.equal(result.redacted.split("\n").length, source.split("\n").length, `${file}: same number of lines`);
    assert.ok(isRedactedFixedPoint(file, result.redacted), `${file}: classifying the redacted form reveals nothing`);
    const p = projectFile(file, result.redacted);
    const original = projectFile(file, source);
    assert.equal(p.parseError, original.parseError, `${file}: the redacted form parses as the original`);
    assert.equal(p.blocks.length, original.blocks.length, `${file}: same structure`);
  }
});

test("EP-039-T02 masks: fixed length, no derivative of the value; lengths only in the span report", () => {
  const result = classify("config/app.yaml", files["config/app.yaml"]);
  for (const span of result.spans) {
    const masked = result.redacted.slice(span.redactedStart, span.redactedEnd);
    assert.ok(/^[\s'"`|>-]*(•{8}[\s'"`]*)+$/.test(masked) || masked.split("\n").every((line) => /^\s*(•{8})?\s*['"]?$/.test(line) || /^[|>]/.test(line.trim())), `mask «${masked}»`);
    assert.ok(span.length > 0);
  }
  const yamlPassword = result.spans.find((span) => JSON.stringify(span.path) === JSON.stringify(["db", "password"]));
  assert.equal(yamlPassword.length, [...c.YAML_PASSWORD].length, "the length is reported to the UI only");
  assert.ok(!result.redacted.includes(String(yamlPassword.length) + " "), "the redacted text has no length");
  // Masked: object under a secret key entirely, the anchored value of an alias under a secret key, block scalar, explicit URL password.
  for (const name of ["YAML_CRED_USER", "YAML_CRED_PIN", "YAML_ANCHOR", "YAML_BLOCK", "YAML_URL", "YAML_APIKEY"]) assert.ok(!result.redacted.includes(c[name]), name);
  assert.ok(result.redacted.includes("service: api") && result.redacted.includes("host: db.internal") && result.redacted.includes("replicas: 3"), "other values stay");
  assert.ok(result.redacted.includes("postgres://admin:••••••••@db.internal:5432/app"), "only the URL password is masked");
});

test("EP-039-T02 false masks of ordinary keys are named and accepted; explicit shapes are masked under any key and in any format", () => {
  // Accepted false positives of the built-in pattern (one click «Show»; F17 exemption for a permanent one).
  const yaml = "token_count: 42\nsession_key_ttl: 30\npassword_policy: strong\nkeyboard: qwerty\nmonkey: 1\n";
  const result = classify("a.yaml", yaml);
  assert.deepEqual(result.spans.map((span) => span.key), ["token_count", "session_key_ttl", "password_policy"], "accepted false masks");
  assert.ok(result.redacted.includes("keyboard: qwerty") && result.redacted.includes("monkey: 1"));
  assert.ok(looksExplicit("-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----"));
  assert.ok(looksExplicit("https://u:p@h/"));
  assert.ok(!looksExplicit("https://example.com/path"));
  const md = classify("x.md", "Пример: redis://user:hunter2-secret@cache:6379/0 и ссылка https://example.com\n");
  assert.equal(md.spans.length, 1);
  assert.ok(md.redacted.includes("redis://user:••••••••@cache"));
});

test("EP-039-T02 levels: global extensions mask in the user's outputs only; repository extensions change the shared form for everyone; narrowing is refused", () => {
  const yaml = "internal_id: abc123\nsigning_salt: s4lt\nname: x\n";
  const shared = classify("a.yaml", yaml, { repo: ["signing_salt"], global: ["internal_id"] }, "shared");
  const personal = classify("a.yaml", yaml, { repo: ["signing_salt"], global: ["internal_id"] }, "personal");
  assert.ok(shared.redacted.includes("internal_id: abc123"), "the global extension does not change the shared form");
  assert.ok(!shared.redacted.includes("s4lt"), "the repository extension does");
  assert.ok(!personal.redacted.includes("abc123") && !personal.redacted.includes("s4lt"), "personal outputs use both");
  assert.notEqual(rulesHash({ repo: ["signing_salt"] }), rulesHash({}), "the rule set is part of the redaction flag");
  assert.equal(rulesHash({ repo: ["b", "a"] }), rulesHash({ repo: ["a", "b", "a"] }), "canonical: sorted, deduplicated");
  assert.equal(rulesHash({ repo: ["x"], global: ["y"] }, "shared"), rulesHash({ repo: ["x"] }, "shared"), "global rules never enter the shared hash");
  // There is no way to narrow the built-in set: an extension is only added; a pattern that would match everything is refused.
  assert.equal(classify("a.yaml", "password: p\n", { repo: ["^nothing$"] }).spans.length, 1, "the built-in set always applies");
  assert.match(patternProblem("") ?? "", /empty/);
  assert.match(patternProblem(".*") ?? "", /empty name/);
  assert.match(patternProblem("(") ?? "", /not a regular expression/);
  assert.equal(patternProblem("signing_salt"), null);
  // Determinism: the same input gives the same redaction (and hash) twice.
  assert.deepEqual(classify("config/app.toml", files["config/app.toml"]), classify("config/app.toml", files["config/app.toml"]));
});

test("EP-039-T02 extending the pattern or masking only (rules changed) is not an edit: versions are kept", () => {
  const source = "name: demo\ninternal_id: abc123\nport: 1\n";
  const before = classify("a.yaml", source, {}).redacted;
  const after = classify("a.yaml", source, { repo: ["internal_id"] }).redacted;
  assert.notEqual(before, after);
  const a = buildRevision({ revisionId: "00000000-0000-4000-8000-0000000000a1", docId: "00000000-0000-4000-8000-0000000000d1", path: "a.yaml", source: before, snapshot: sha256(before), parents: [] });
  const b = buildRevision({ revisionId: "00000000-0000-4000-8000-0000000000a2", docId: "00000000-0000-4000-8000-0000000000d1", path: "a.yaml", source: after, snapshot: sha256(after), parents: [{ revision: a.revision, source: before }] });
  assert.deepEqual(b.revision.blocks.map((block) => block.versionId), a.revision.blocks.map((block) => block.versionId), "no version changes");
  // A secret value changed in Git: masked on both sides — no edit in shared data (the device HMAC tells «value changed»).
  const env1 = classify(".env.example", "A=one\nB=two\n").redacted;
  const env2 = classify(".env.example", "A=one-changed\nB=two\n").redacted;
  assert.equal(env1, env2, "the redacted form of a changed secret value is the same");
});

test("EP-039-T07 exemptions by key path: element fingerprints from non-secret siblings only; shifts and renames stop the exemption; explicit secrets are never exempted", () => {
  const yaml = "limits:\n  token_count: 42\nlist:\n  - name: a\n    token: t-a\n  - name: b\n    token: t-b\n";
  const atoms = parseStructured("yaml", yaml);
  const metas = atoms.atoms.map((atom) => atom.meta ?? {});
  const isSecret = (path) => path.some((segment) => typeof segment === "string" && /token/i.test(segment));
  const exemptCount = exemptionKeyPath(metas, ["limits", "token_count"], isSecret);
  const exemptB = exemptionKeyPath(metas, ["list", 1, "token"], isSecret);
  assert.ok(!exemptB.includes("t-b"), "the fingerprint has no derivative of the secret value");
  let result = classify("a.yaml", yaml, { exemptions: [exemptCount, exemptB] });
  assert.ok(result.redacted.includes("token_count: 42"), "exempted leaf is visible");
  assert.ok(result.redacted.includes("token: t-b") && !result.redacted.includes("t-a"), "only element b");
  assert.deepEqual(result.exemptions.map((e) => e.reason), ["applied", "applied"]);
  // An element inserted before b: b is found by its fingerprint at index 2.
  const shifted = "limits:\n  token_count: 42\nlist:\n  - name: z\n    token: t-z\n  - name: a\n    token: t-a\n  - name: b\n    token: t-b\n";
  result = classify("a.yaml", shifted, { exemptions: [exemptB] });
  assert.ok(result.redacted.includes("token: t-b") && !result.redacted.includes("t-z"), "follows the element, not the index");
  // The element's non-secret sibling changed: not identified — masked again and reported.
  const renamed = yaml.replace("name: b", "name: bb");
  result = classify("a.yaml", renamed, { exemptions: [exemptB] });
  assert.ok(!result.redacted.includes("t-b"));
  assert.equal(result.exemptions[0].reason, "structure-changed");
  // Two elements with the same fingerprint: ambiguous — not applied.
  const twins = "list:\n  - name: b\n    token: t-1\n  - name: b\n    token: t-2\n";
  const twinMetas = parseStructured("yaml", twins).atoms.map((atom) => atom.meta ?? {});
  result = classify("a.yaml", twins, { exemptions: [exemptionKeyPath(twinMetas, ["list", 0, "token"], isSecret)] });
  assert.ok(!result.redacted.includes("t-1") && !result.redacted.includes("t-2"));
  // The key renamed: the path is gone.
  result = classify("a.yaml", yaml.replace("token_count", "tokens_count"), { exemptions: [exemptCount] });
  assert.equal(result.exemptions[0].applied, false);
  // An explicit secret under an exempted path stays masked.
  const pem = "limits:\n  token_count: \"https://u:hunter2@h/\"\n";
  result = classify("a.yaml", pem, { exemptions: [exemptCount] });
  assert.ok(!result.redacted.includes("hunter2"));
  assert.equal(result.exemptions[0].reason, "explicit");
  // .env: a repository exemption needs a file in Git (the host sets envExemptions); otherwise ignored.
  assert.ok(!classify(".env", "MODE=dev\n", { exemptions: ['["MODE"]'] }).redacted.includes("dev"));
  assert.ok(classify(".env", "MODE=dev\n", { exemptions: ['["MODE"]'], envExemptions: true }).redacted.includes("MODE=dev"));
  assert.ok(!classify(".env", "MODE=redis://u:p4ss@h/\n", { exemptions: ['["MODE"]'], envExemptions: true }).redacted.includes("p4ss"), "explicit in .env too");
  // Removing an exemption returns the mask and is not an edit (mask-only change).
  assert.equal(MASK.length, 8);
});

test("EP-039-T02 a structured file that does not parse is masked by the line heuristic (only stronger)", () => {
  const broken = "db:\n  password: hunter2\n  : broken\napi_key = \"k3y\"\n";
  const result = classify("a.yaml", broken);
  assert.equal(result.heuristic, true);
  assert.ok(!result.redacted.includes("hunter2") && !result.redacted.includes("k3y"));
  const json = '{\n  "password": "hunter2"\n  "x": 1\n}\n';
  assert.ok(!classify("a.json", json).redacted.includes("hunter2"));
});

test("EP-039-T06 security review: every leak case found by the review is masked now", () => {
  const S = "S3CRETvalue";
  const cases = [
    ["a.json", `{"url":"postgres://u:pw1@h","token":"${S}"}`],
    ["a.json", `{\n  "url": "postgres://u:pw1@h/db",\n  "credentials": {\n    "user": "${S}"\n  },\n  "tokens": [\n    "${S}"\n  ]\n}\n`],
    ["a.toml", `url = "postgres://u:pw1@h"\n[secrets]\npassword = "${S}"\ncreds = { password = "${S}" }\n`],
    ["a.json", `{"token":"${S}"} trailing`],
    ["a.json", `{"token":"${S}",}`],
    ["a.yaml", `password: |\n  ${S}\nbroken: [`],
    ["a.yaml", `creds: {password: ${S}}\nx: [`],
    ["a.yaml", `﻿password: ${S}\r\nx: 1\r\n`],
    [".env", `1A=${S}\n`],
    [".env", `KEY ${S}\n`],
    [".env", `#OLD_TOKEN=${S}\n`],
    [".env", `A='x\n${S}'\n`],
    [".env", `A="x" ${S}\n`],
    ["a.md", `redis://:${S}@h:6379\n`],
    ["a.md", `postgres://u:p@${S}@h/db\n`],
    ["a.txt", `-----BEGIN PRIVATE KEY-----\n${S}\n`],
    ["a.txt", `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${S}\n-----END PGP PRIVATE KEY BLOCK-----\n`],
  ];
  for (const [file, source] of cases) {
    const result = classify(file, source);
    assert.ok(!result.redacted.includes(S), `${file}: ${JSON.stringify(source)} → ${JSON.stringify(result.redacted)}`);
    assert.ok(!result.redacted.includes("pw1"), `${file}: URL password`);
  }
  // The explicit span inside a JSON string keeps the JSON valid (no quotes are added inside it).
  const json = classify("a.json", `{"url":"postgres://u:pw1@h","token":"${S}","name":"n"}`);
  assert.equal(json.heuristic, false);
  assert.ok(json.redacted.includes('"name":"n"'), "the file is still parsed — ordinary values stay");
  assert.equal(projectFile("a.json", json.redacted).parseError, null);
  // A YAML file with a BOM parses (and keeps ordinary values).
  const bom = classify("a.yaml", `﻿password: ${S}\nname: n\nport: 1\n`);
  assert.equal(bom.heuristic, false);
  assert.ok(bom.redacted.includes("name: n"));
  // Nested repetition in a repository pattern is refused (ReDoS on the host).
  assert.match(patternProblem("(a+)+") ?? "", /nested repetition/);
  assert.match(patternProblem("(x|y*)*") ?? "", /nested repetition/);
});
