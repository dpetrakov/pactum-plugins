// Writes schemas/v1/*.schema.json from core/schema.ts. `--check` fails when a committed file is stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson } from "../core/canonical-json.ts";
import { JSON_SCHEMAS, VOCAB } from "../core/schema.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../schemas/v1");

export function renderSchemas() {
  return Object.entries(JSON_SCHEMAS).map(([name, schema]) => {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
    return { file: `${name}.schema.json`, text: canonicalJson({ ...json, $id: `${VOCAB}schema/${name}`, title: `bb-docs ${name} v1` }) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  fs.mkdirSync(dir, { recursive: true });
  for (const { file, text } of renderSchemas()) {
    const target = path.join(dir, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === text) continue;
    stale++;
    if (check) console.error(`stale: schemas/v1/${file}`);
    else fs.writeFileSync(target, text);
  }
  if (check && stale) process.exit(1);
  console.log(check ? "schemas up to date" : `wrote ${stale} schema file(s)`);
}
