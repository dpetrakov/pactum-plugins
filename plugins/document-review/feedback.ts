/** Shared command feedback state machines. createCommand reports running immediately, shows a spinner after 150 ms for at least 400 ms, reports slow after 1 s, ignores duplicate submissions and supports AbortSignal cancellation. createOptimistic applies values immediately, serializes writes per key, coalesces intermediate values and restores the last confirmed value on failure. createCoalesced runs one load at a time with one trailing request. createLatest rejects stale replies. React hooks expose these primitives; useDelayedFlag and useSlowFlag apply the same timing to non-command loading states. Rendering uses the fb-* classes. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Feedback timing: indicator delay, minimum visible duration and slow-operation threshold in milliseconds. */
export const FEEDBACK = { delayMs: 150, minMs: 400, slowMs: 1000 } as const;

/** Clock abstraction for tests; use global timers by default. */
export type Clock = { now: () => number; setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type CommandState = {
  /** The command is running from the first frame: expose aria-busy and aria-disabled and ignore duplicate presses. */
  running: boolean;
  /** Show the indicator after delayMs and retain it for at least minMs. */
  busy: boolean;
  /** Execution exceeded slowMs; show an explanation and cancellation where available. */
  slow: boolean;
  /** Error from the last run, cleared by the next run. */
  error: unknown;
};
export const idleCommand: CommandState = { running: false, busy: false, slow: false, error: null };

export type CommandOptions = { delayMs?: number; minMs?: number; slowMs?: number; clock?: Clock; onChange?: (state: CommandState) => void };

export function createCommand<A extends unknown[], R>(run: (signal: AbortSignal, ...args: A) => Promise<R>, options: CommandOptions = {}) {
  const clock = options.clock ?? systemClock;
  const delayMs = options.delayMs ?? FEEDBACK.delayMs;
  const minMs = options.minMs ?? FEEDBACK.minMs;
  const slowMs = options.slowMs ?? FEEDBACK.slowMs;
  let state: CommandState = idleCommand;
  let controller: AbortController | null = null;
  const set = (next: Partial<CommandState>) => { state = { ...state, ...next }; options.onChange?.(state); };
  return {
    get state() { return state; },
    /** Start a command. Return undefined while another run is active. Store errors in state.error rather than throwing. */
    async start(...args: A): Promise<R | undefined> {
      if (state.running) return undefined;
      const own = new AbortController();
      controller = own;
      let shownAt: number | null = null;
      set({ running: true, busy: false, slow: false, error: null });
      const showTimer = clock.setTimeout(() => { shownAt = clock.now(); set({ busy: true }); }, delayMs);
      const slowTimer = clock.setTimeout(() => set({ slow: true }), slowMs);
      let result: R | undefined;
      let error: unknown = null;
      try { result = await run(own.signal, ...args); } catch (cause) { error = cause; }
      clock.clearTimeout(showTimer);
      clock.clearTimeout(slowTimer);
      if (shownAt !== null) {
        const left = minMs - (clock.now() - shownAt);
        if (left > 0) await new Promise<void>((resolve) => { clock.setTimeout(resolve, left); });
      }
      if (controller === own) controller = null;
      set({ running: false, busy: false, slow: false, error });
      return error === null ? result : undefined;
    },
    /** Cancel the current run. The callback receives an abort signal. */
    cancel() { controller?.abort(); },
  };
}

export type OptimisticOptions<K, V> = {
  /** Reveal the new value immediately, or the confirmed value after a failure. */
  show: (key: K, value: V) => void;
  /** The write failed and the confirmed value was restored. retry repeats the latest requested value. */
  onError?: (key: K, error: unknown, retry: () => void) => void;
};

export function createOptimistic<K, V>(commit: (key: K, value: V) => Promise<unknown>, options: OptimisticOptions<K, V>) {
  const confirmed = new Map<K, V>();
  const wanted = new Map<K, V>();
  const writing = new Set<K>();
  async function flush(key: K): Promise<void> {
    if (writing.has(key) || !wanted.has(key)) return;
    writing.add(key);
    const value = wanted.get(key) as V;
    wanted.delete(key);
    try {
      await commit(key, value);
      confirmed.set(key, value);
    } catch (error) {
      // Newer wishes made during the failed write are dropped too: the shown value returns to the confirmed one.
      const latest = wanted.has(key) ? wanted.get(key) as V : value;
      wanted.delete(key);
      if (confirmed.has(key)) options.show(key, confirmed.get(key) as V);
      options.onError?.(key, error, () => { void apply(key, latest); });
    } finally {
      writing.delete(key);
    }
    if (wanted.has(key)) await flush(key);
  }
  /** current is the confirmed value before the first optimistic change to this key. */
  function apply(key: K, value: V, current?: V): Promise<void> {
    if (!confirmed.has(key) && current !== undefined) confirmed.set(key, current);
    wanted.set(key, value);
    options.show(key, value);
    return flush(key);
  }
  return { apply, pending: (key: K) => writing.has(key) || wanted.has(key), confirmed: (key: K) => confirmed.get(key) };
}

/** One load at a time; concurrent requests coalesce into one trailing load. */
export function createCoalesced(load: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let again = false;
  return function run(): Promise<void> {
    if (running) { again = true; return running; }
    running = load().finally(() => {
      running = null;
      if (again) { again = false; void run(); }
    });
    return running;
  };
}

/** Request token: apply a reply only if no later request for the same target has started. */
export function createLatest() {
  let current = 0;
  return { begin: () => ++current, isCurrent: (token: number) => token === current };
}

// ── React ─────────────────────────────────────────────────────────────────────────────────────────────

/** React command hook: state controls aria-busy, feedback and explanations; start handles activation. */
export function useCommand<A extends unknown[], R>(run: (signal: AbortSignal, ...args: A) => Promise<R>, options: Omit<CommandOptions, "onChange"> = {}) {
  const [state, setState] = useState<CommandState>(idleCommand);
  const runRef = useRef(run);
  runRef.current = run;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const command = useMemo(() => createCommand<A, R>((signal, ...args) => runRef.current(signal, ...args),
    { ...options, onChange: (next) => { if (mounted.current) setState(next); } }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const start = useCallback((...args: A) => command.start(...args), [command]);
  return { state, start, cancel: command.cancel };
}

/** Optimistic values by key: values contains displayed values and apply(key, value, current) updates them. */
export function useOptimisticValue<K, V>(commit: (key: K, value: V) => Promise<unknown>, onError?: (key: K, error: unknown, retry: () => void) => void) {
  const [values, setValues] = useState<ReadonlyMap<K, V>>(new Map());
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const optimistic = useMemo(() => createOptimistic<K, V>((key, value) => commitRef.current(key, value), {
    show: (key, value) => setValues((current) => new Map(current).set(key, value)),
    onError: (key, error, retry) => errorRef.current?.(key, error, retry),
  }), []);
  return { values, apply: optimistic.apply, pending: optimistic.pending };
}

/** createCoalesced with the latest loader callback. */
export function useCoalesced(load: () => Promise<void>) {
  const loadRef = useRef(load);
  loadRef.current = load;
  return useMemo(() => createCoalesced(() => loadRef.current()), []);
}

/** Become true after delayMs of activity; remain visible for at least minMs to avoid flicker. */
export function useDelayedFlag(active: boolean, delayMs: number = FEEDBACK.delayMs, minMs: number = FEEDBACK.minMs): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active) {
      if (shown) return;
      const timer = setTimeout(() => { shownAt.current = Date.now(); setShown(true); }, delayMs);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const left = minMs - (Date.now() - shownAt.current);
    if (left <= 0) { setShown(false); return; }
    const timer = setTimeout(() => setShown(false), left);
    return () => clearTimeout(timer);
  }, [active, shown, delayMs, minMs]);
  return shown;
}

/** Activity lasting more than one second needs an explanation. Clear it when the wait ends. */
export function useSlowFlag(active: boolean): boolean {
  return useDelayedFlag(active, FEEDBACK.slowMs, 0);
}
