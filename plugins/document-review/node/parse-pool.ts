// Parallel parse of large documents on the host (EP-012-T04). micromark dominates the first view of a big document;
// its chunks are independent (core/markdown/parse.ts), so the missing ones are parsed by a few worker threads and put
// into the chunk cache; the synchronous projection then finds every chunk ready. The worker runs this same module
// (the host bundle, or this file under tests) and only answers parse jobs. Any failure falls back to the normal
// in-thread parse: the pool is an optimisation, never a source of truth.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type ChunkJob, missingChunks, runChunkJob, storeChunk } from "../core/markdown/parse.ts";

const ROLE = "bb-document-review-parse";

if (!isMainThread && (workerData as { role?: string } | null)?.role === ROLE) {
  parentPort!.on("message", (message: { id: number; jobs: ChunkJob[] }) => {
    try {
      parentPort!.postMessage({ id: message.id, results: message.jobs.map((job) => runChunkJob(job)) });
    } catch (error) {
      parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

type Pending = { resolve: (results: unknown[][]) => void; reject: (error: Error) => void };
interface PoolWorker { worker: Worker; pending: Map<number, Pending> }

let pool: PoolWorker[] | null = null;
let broken = false;
let nextId = 1;

function size(): number {
  const configured = Number(process.env.DOCUMENT_REVIEW_PARSE_WORKERS);
  if (Number.isFinite(configured) && process.env.DOCUMENT_REVIEW_PARSE_WORKERS !== undefined) return Math.max(0, Math.min(8, Math.floor(configured)));
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(0, Math.min(4, cpus - 1));
}

function start(): PoolWorker[] {
  if (pool) return pool;
  pool = [];
  for (let index = 0; index < size(); index++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: ROLE } });
    const entry: PoolWorker = { worker, pending: new Map() };
    worker.on("message", (message: { id: number; results?: unknown[][]; error?: string }) => {
      const waiting = entry.pending.get(message.id);
      if (!waiting) return;
      entry.pending.delete(message.id);
      if (!entry.pending.size) worker.unref();
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.results ?? []);
    });
    const fail = (error: unknown) => {
      broken = true;
      for (const waiting of entry.pending.values()) waiting.reject(error instanceof Error ? error : new Error(String(error)));
      entry.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => { if (entry.pending.size) fail(new Error(`parse worker exited with ${code}`)); });
    worker.unref();
    pool.push(entry);
  }
  return pool;
}

function send(entry: PoolWorker, jobs: ChunkJob[]): Promise<unknown[][]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    entry.pending.set(id, { resolve, reject });
    // Keep the process alive while a job is out (an idle worker never holds the host open).
    entry.worker.ref();
    entry.worker.postMessage({ id, jobs });
  });
}

/**
 * Parse the chunks of `source` that are not cached yet in parallel and cache them. Small documents, a disabled pool
 * (DOCUMENT_REVIEW_PARSE_WORKERS=0) or a failing worker leave everything to the normal synchronous parse.
 */
export async function warmParse(source: string, diskDir: string | null = null): Promise<{ parsed: number; workers: number; fromDisk: number }> {
  let jobs = missingChunks(source);
  // A restorable on-disk cache of parsed chunks in the host's plugin data (EP-015-T01): a cold host or a never-opened
  // revision of a known document starts from parsed parts. Deleting it changes nothing but the time.
  let fromDisk = 0;
  if (diskDir && jobs.length) {
    const loaded = await Promise.all(jobs.map((job) => readChunk(diskDir, job.key)));
    jobs = jobs.filter((job, index) => {
      const children = loaded[index];
      if (!children) return true;
      storeChunk(job, children);
      fromDisk++;
      return false;
    });
  }
  const workers = broken || jobs.length < 6 ? [] : start();
  if (!workers.length) {
    // No pool (few parts, disabled or broken): parse here, as the synchronous projection would, and keep the parts.
    if (diskDir && jobs.length) {
      const parsed = jobs.map((job) => ({ job, children: runChunkJob(job) }));
      for (const { job, children } of parsed) storeChunk(job, children);
      void Promise.all(parsed.map(({ job, children }) => writeChunk(diskDir, job.key, children))).then(() => pruneChunks(diskDir));
    }
    return { parsed: 0, workers: 0, fromDisk };
  }
  // Interleave the jobs so every worker gets parts of the whole document.
  const batches = workers.map(() => [] as ChunkJob[]);
  jobs.forEach((job, index) => batches[index % workers.length].push(job));
  try {
    const results = await Promise.all(batches.map((batch, index) => (batch.length ? send(workers[index], batch) : Promise.resolve([]))));
    results.forEach((list, index) => list.forEach((children, at) => storeChunk(batches[index][at], children)));
    if (diskDir) void Promise.all(results.flatMap((list, index) => list.map((children, at) => writeChunk(diskDir, batches[index][at].key, children)))).then(() => pruneChunks(diskDir));
    return { parsed: jobs.length, workers: workers.length, fromDisk };
  } catch {
    return { parsed: 0, workers: workers.length, fromDisk };
  }
}

const CHUNK_DISK_LIMIT = 256 * 1024 * 1024;
const chunkFile = (dir: string, key: string) => path.join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);

async function readChunk(dir: string, key: string): Promise<unknown[] | null> {
  try {
    const value = JSON.parse(await fs.readFile(chunkFile(dir, key), "utf8")) as { key?: string; children?: unknown[] };
    // The key itself is stored: a hash collision or a damaged file is a miss, never a wrong parse.
    return value.key === key && Array.isArray(value.children) ? value.children : null;
  } catch {
    return null;
  }
}

async function writeChunk(dir: string, key: string, children: unknown): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = chunkFile(dir, key);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ key, children }));
    await fs.rename(temp, file);
  } catch {
    // A cache write failure only costs time later.
  }
}

/** Keep the on-disk chunk cache bounded: the least recently written files go first. */
async function pruneChunks(dir: string): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
    const stats = await Promise.all(names.map((name) => fs.stat(path.join(dir, name)).then((stat) => ({ name, size: stat.size, at: stat.mtimeMs }), () => null)));
    const files = stats.filter((entry): entry is { name: string; size: number; at: number } => entry !== null).sort((a, b) => b.at - a.at);
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (total > CHUNK_DISK_LIMIT) await fs.rm(path.join(dir, file.name), { force: true });
    }
  } catch {
    // Pruning is best effort.
  }
}

/** Stop the workers (host entry dispose). */
export async function disposeParsePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await Promise.all(current.map((entry) => entry.worker.terminate().catch(() => undefined)));
}
