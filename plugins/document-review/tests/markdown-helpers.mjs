// Shared helpers of the markdown-*.test.mjs suites: corpus loading, revision chains and ground truth.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../core/hash.ts";
import { buildRevision } from "../core/markdown/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = path.join(here, "fixtures", "markdown");

export function read(relative) {
  return fs.readFileSync(path.join(CORPUS, relative), "utf8");
}

export function readBytes(relative) {
  return fs.readFileSync(path.join(CORPUS, relative));
}

/** Every single-version document of the corpus: syntax fixtures and real documents. */
export function corpusDocuments() {
  const out = [];
  for (const dir of ["syntax", "real"]) {
    for (const name of fs.readdirSync(path.join(CORPUS, dir)).sort()) if (name.endsWith(".md")) out.push(`${dir}/${name}`);
  }
  return out;
}

export function sequenceNames() {
  return fs.readdirSync(path.join(CORPUS, "sequences")).filter((name) => fs.statSync(path.join(CORPUS, "sequences", name)).isDirectory()).sort();
}

export function loadSequence(name) {
  const dir = path.join(CORPUS, "sequences", name);
  const versions = {};
  for (const file of fs.readdirSync(dir).sort()) if (/^[a-z]\.md$/.test(file)) versions[file[0]] = fs.readFileSync(path.join(dir, file), "utf8");
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));
  return { name, versions, truth };
}

/** Build a persistent revision; ids are `${doc}:${letter}` so they sort in sequence order. */
export function revise(id, source, parents = []) {
  return buildRevision({ revisionId: id, docId: "doc", path: "doc.md", source, snapshot: sha256(source), parents: parents.map((p) => ({ revision: p.revision, source: p.source })) });
}

export function withSource(built, source) {
  return { ...built, source };
}

/** Linear chain a -> b -> c ... and, for c and later, a direct revision from a skipping the middle (DR-03). */
export function buildChain(sequence) {
  const letters = Object.keys(sequence.versions).sort();
  const chain = {};
  let previous = null;
  for (const letter of letters) {
    const source = sequence.versions[letter];
    chain[letter] = withSource(revise(`${sequence.name}:${letter}`, source, previous ? [previous] : []), source);
    previous = chain[letter];
  }
  const direct = {};
  for (const letter of letters.slice(2)) {
    const source = sequence.versions[letter];
    direct[letter] = withSource(revise(`${sequence.name}:${letter}-direct`, source, [chain.a]), source);
  }
  return { letters, chain, direct };
}

/** Block index addressed by "#n" or by a unique text prefix. */
export function select(projection, selector) {
  if (selector.startsWith("#")) {
    const index = Number(selector.slice(1));
    if (!(index >= 0 && index < projection.blocks.length)) throw new Error(`selector ${selector} out of range`);
    return index;
  }
  const hits = projection.blocks.map((b, i) => (b.text.startsWith(selector) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`selector "${selector}" matches ${hits.length} blocks`);
  return hits[0];
}

/**
 * Ground truth old block -> new blocks for one step. Listed entries win; an unlisted block whose semanticHash is
 * unique in the old version maps to the single new block with that hash, or to nothing when none has it.
 * Unlisted duplicates are an error: the fixture must say what happened to them.
 */
export function truthStep(step, oldProjection, newProjection) {
  const out = oldProjection.blocks.map(() => undefined);
  for (const [from, to] of step.map ?? []) out[select(oldProjection, from)] = to.map((s) => select(newProjection, s));
  for (const from of step.unknown ?? []) out[select(oldProjection, from)] = "unknown";
  oldProjection.blocks.forEach((block, i) => {
    if (out[i] !== undefined) return;
    const olds = oldProjection.blocks.filter((b) => b.semanticHash === block.semanticHash).length;
    const news = newProjection.blocks.map((b, j) => (b.semanticHash === block.semanticHash ? j : -1)).filter((j) => j >= 0);
    if (olds === 1 && news.length <= 1) out[i] = news;
    else throw new Error(`truth incomplete: block ${i} "${block.text.slice(0, 40)}" has ${olds} copies before and ${news.length} after`);
  });
  return out;
}

export function compose(first, second) {
  return first.map((targets) => {
    if (targets === "unknown") return "unknown";
    const out = new Set();
    for (const t of targets) {
      const next = second[t];
      if (next === "unknown") return "unknown";
      for (const u of next) out.add(u);
    }
    return [...out].sort((a, b) => a - b);
  });
}

/** Ground truth for every pair of versions of a sequence (x<y), composed through the intermediate steps. */
export function sequenceTruth(sequence, chain) {
  const letters = Object.keys(sequence.versions).sort();
  const steps = {};
  for (let k = 0; k + 1 < letters.length; k += 1) {
    const [x, y] = [letters[k], letters[k + 1]];
    const step = sequence.truth.steps[`${x}>${y}`];
    if (!step) throw new Error(`${sequence.name}: missing truth for ${x}>${y}`);
    steps[`${x}>${y}`] = truthStep(step, chain[x].projection, chain[y].projection);
  }
  for (let i = 0; i < letters.length; i += 1) {
    for (let j = i + 2; j < letters.length; j += 1) {
      let map = steps[`${letters[i]}>${letters[i + 1]}`];
      for (let k = i + 1; k < j; k += 1) map = compose(map, steps[`${letters[k]}>${letters[k + 1]}`]);
      steps[`${letters[i]}>${letters[j]}`] = map;
    }
  }
  return steps;
}
