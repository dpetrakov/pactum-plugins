// Secret leak harness: unique random canaries in every
// format, a search of each canary, its base64/base64url/hex/URL encodings, its sha256 and its prefixes (≥ 6 characters)
// in every output of the plugin. A finding names the output, the canary and the encoding. Used by
// tests/leak-w06c.test.mjs (full cycle) and the self-check that a deliberate leak is found.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** A canary: «cn» + 18 hex + «/» + 6 hex — the slash makes URL-encoding differ from the raw text. */
export function canary() {
  const hex = randomBytes(12).toString("hex");
  return `cn${hex.slice(0, 18)}/${hex.slice(18, 24)}`;
}

/** Every form of a canary the search looks for. */
export function encodings(value) {
  const bytes = Buffer.from(value, "utf8");
  const forms = [
    ["raw", value],
    ["base64", bytes.toString("base64").replace(/=+$/, "")],
    ["base64url", bytes.toString("base64url")],
    ["hex", bytes.toString("hex")],
    ["hex-upper", bytes.toString("hex").toUpperCase()],
    ["url", encodeURIComponent(value)],
    ["json-escaped", JSON.stringify(value).slice(1, -1).replace(/\//g, "\\/")],
    ["sha256", createHash("sha256").update(value).digest("hex")],
    ["prefix-6", value.slice(0, 6)],
    ["prefix-10", value.slice(0, 10)],
    ["suffix-after-slash", value.slice(value.indexOf("/") + 1)],
  ];
  // The 6-hex tail after the slash alone is too short to be distinctive (could appear in a uuid): keep only ≥ 6 with the «cn» start or ≥ 12.
  return forms.filter(([label, form]) => label !== "suffix-after-slash" && form.length >= 6);
}

export class LeakHarness {
  constructor(canaries) {
    /** name → canary value */
    this.canaries = canaries;
    this.forms = [];
    for (const [name, value] of Object.entries(canaries)) for (const [encoding, form] of encodings(value)) this.forms.push({ name, encoding, form });
    /** Named outputs checked so far (each is a separate check, §8 and §15 of file-types.md). */
    this.outputs = new Map();
    this.findings = [];
    /** Canaries allowed to appear in a named output (positive controls: a repository exemption makes a value public). */
    this.allowed = new Map();
    /** Every scanned string, so other values (device key, HMACs) can be searched in the same outputs later. */
    this.kept = [];
  }

  /** Search the outputs scanned so far for other values (exact text): [{output, name}]. */
  rescan(values) {
    const found = [];
    for (const { output, value } of this.kept) for (const [name, needle] of Object.entries(values)) if (needle && value.includes(needle)) found.push({ output, name });
    return found;
  }

  allow(output, name) {
    this.allowed.set(`${output}\0${name}`, true);
  }

  /** Search a string under an output name. */
  scan(output, text, where = "") {
    const value = typeof text === "string" ? text : JSON.stringify(text);
    const stats = this.outputs.get(output) ?? { strings: 0, bytes: 0 };
    stats.strings++;
    stats.bytes += value?.length ?? 0;
    this.outputs.set(output, stats);
    if (!value) return;
    this.kept.push({ output, value });
    for (const { name, encoding, form } of this.forms) {
      if (this.allowed.has(`${output}\0${name}`)) continue;
      const at = value.indexOf(form);
      if (at >= 0) this.findings.push({ output, canary: name, encoding, where, context: value.slice(Math.max(0, at - 40), at + form.length + 40) });
    }
  }

  /** Search every file under a directory (binary-safe: UTF-8 and Latin-1 views). */
  async scanDir(output, dir, { exclude = () => false } = {}) {
    const walk = async (current) => {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const rel = path.relative(dir, full);
        if (exclude(rel)) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(full);
          this.scan(output, bytes.toString("utf8"), rel);
          this.scan(output, bytes.toString("latin1"), rel);
        }
      }
    };
    await walk(dir);
    const stats = this.outputs.get(output) ?? { strings: 0, bytes: 0 };
    this.outputs.set(output, stats);
  }

  report() {
    const unique = new Map();
    for (const finding of this.findings) unique.set(`${finding.output}|${finding.canary}|${finding.encoding}|${finding.where}`, finding);
    return { outputs: Object.fromEntries([...this.outputs].map(([name, stats]) => [name, stats])), findings: [...unique.values()] };
  }
}

/** Wrap an async function so every result (and error message) it returns is scanned under `output`. */
export function scanned(harness, output, run) {
  return async (...args) => {
    try {
      const result = await run(...args);
      harness.scan(output, result, JSON.stringify(args?.[0]?.path ?? args?.[0]?.method ?? ""));
      return result;
    } catch (error) {
      harness.scan(`${output}:errors`, `${error?.code ?? ""} ${error?.message ?? String(error)}`);
      throw error;
    }
  };
}
