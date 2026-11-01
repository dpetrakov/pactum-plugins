// Command feedback: timing, duplicate protection, rollback, coalescing and stale-reply rejection;
// shared copies are checked when another participating package is present.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCoalesced, createCommand, createLatest, createOptimistic, FEEDBACK } from "../feedback.ts";

/** Manual clock: timers fire only when time is advanced. */
function fakeClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    setTimeout: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timers = timers.filter((item) => item !== timer); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.run();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test("the scale of the design system: 150 ms delay, 400 ms minimum, slow after 1 s", () => {
  assert.deepEqual(FEEDBACK, { delayMs: 150, minMs: 400, slowMs: 1000 });
});

test("a fast command never shows the indicator; running is set in the same frame", async () => {
  const clock = fakeClock();
  const states = [];
  const job = deferred();
  const command = createCommand(() => job.promise, { clock, onChange: (state) => states.push(state) });
  const started = command.start();
  assert.equal(command.state.running, true, "accepted at once");
  assert.equal(command.state.busy, false);
  await clock.advance(80);
  job.resolve("ok");
  assert.equal(await started, "ok");
  assert.ok(states.every((state) => !state.busy), "no indicator for an answer under 150 ms");
  assert.deepEqual(command.state, { running: false, busy: false, slow: false, error: null });
});

test("the indicator appears after 150 ms and stays at least 400 ms, then slow after 1 s", async () => {
  const clock = fakeClock();
  const job = deferred();
  let current = job;
  const command = createCommand(() => current.promise, { clock });
  const started = command.start();
  await clock.advance(149);
  assert.equal(command.state.busy, false);
  await clock.advance(1);
  assert.equal(command.state.busy, true, "shown at 150 ms");
  await clock.advance(50);
  job.resolve(1);
  await flush();
  assert.equal(command.state.busy, true, "kept: shown only 50 ms so far");
  await clock.advance(349);
  assert.equal(command.state.running, true);
  await clock.advance(1);
  assert.equal(await started, 1);
  assert.equal(command.state.running, false, "released after 400 ms of indicator");

  const slow = deferred();
  current = slow;
  const next = command.start();
  await clock.advance(999);
  assert.equal(command.state.slow, false);
  await clock.advance(1);
  assert.equal(command.state.slow, true, "slow after 1 s");
  slow.resolve(2);
  await clock.advance(400);
  await next;
});

test("a repeated press while running does not run the command again", async () => {
  const clock = fakeClock();
  let calls = 0;
  const job = deferred();
  const command = createCommand(() => { calls++; return job.promise; }, { clock });
  const first = command.start();
  assert.equal(await command.start(), undefined, "the second press answers at once without running");
  await command.start();
  job.resolve("done");
  assert.equal(await first, "done");
  assert.equal(calls, 1);
});

test("an error is kept in the state for an on-place message and «Повторить»; cancel aborts the signal", async () => {
  const clock = fakeClock();
  const command = createCommand(async () => { throw new Error("нет связи с the workstation"); }, { clock });
  assert.equal(await command.start(), undefined);
  assert.equal(command.state.error.message, "нет связи с the workstation");
  assert.equal(command.state.running, false);

  let aborted = false;
  const job = deferred();
  const reading = createCommand((signal) => { signal.addEventListener("abort", () => { aborted = true; job.reject(new Error("отменено")); }); return job.promise; }, { clock });
  const started = reading.start();
  reading.cancel();
  await started;
  assert.equal(aborted, true);
});

test("optimistic: the value shows at once; a failure rolls back to the confirmed value and offers a retry", async () => {
  const shown = [];
  const errors = [];
  const job = deferred();
  const optimistic = createOptimistic(() => job.promise, { show: (key, value) => shown.push([key, value]), onError: (key, error, retry) => errors.push({ key, error, retry }) });
  const applied = optimistic.apply("thr_1", 0, 2);
  assert.deepEqual(shown.at(-1), ["thr_1", 0], "the new priority shows at once");
  assert.equal(optimistic.pending("thr_1"), true);
  job.reject(new Error("Важность не сохранилась"));
  await applied;
  assert.deepEqual(shown.at(-1), ["thr_1", 2], "rolled back to the confirmed priority");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.message, "Важность не сохранилась");
  assert.equal(optimistic.pending("thr_1"), false);
});

test("optimistic: one write per key at a time, intermediate wishes collapse, the last one wins", async () => {
  const commits = [];
  const jobs = [];
  const optimistic = createOptimistic((key, value) => { commits.push(value); const job = deferred(); jobs.push(job); return job.promise; }, { show: () => undefined });
  void optimistic.apply("project", "code", "pause");
  void optimistic.apply("project", "wrench");
  void optimistic.apply("project", "check");
  assert.deepEqual(commits, ["code"], "one write in flight");
  jobs[0].resolve();
  await flush();
  assert.deepEqual(commits, ["code", "check"], "«wrench» collapsed: the last wish is written next");
  jobs[1].resolve();
  await flush();
  assert.equal(optimistic.confirmed("project"), "check");
});

test("coalesced: loads asked during a load collapse into one trailing load", async () => {
  let loads = 0;
  const jobs = [];
  const run = createCoalesced(() => { loads++; const job = deferred(); jobs.push(job); return job.promise; });
  const first = run();
  run(); run(); run();
  assert.equal(loads, 1);
  jobs[0].resolve();
  await first;
  await flush();
  assert.equal(loads, 2, "one trailing load");
  jobs[1].resolve();
  await flush();
  assert.equal(loads, 2);
});

test("latest: an answer to an outdated request is dropped", () => {
  const latest = createLatest();
  const first = latest.begin();
  const second = latest.begin();
  assert.equal(latest.isCurrent(first), false);
  assert.equal(latest.isCurrent(second), true);
});

test("feedback.css: only bb theme tokens — no colour literals; every state is a data attribute of the README", () => {
  const css = readFileSync(new URL("../feedback.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(|hsla?\(/, "colour literal");
  for (const state of ["data-fb-busy", "data-fb-row-busy", "data-fb-seam-busy", "data-fb-dim"]) assert.match(css, new RegExp(`\\[${state}\\]`));
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /color-mix\(in oklab, var\(--foreground\) 60%, transparent\)/, "D15: the rail at 60 %");
});
