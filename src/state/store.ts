export type Listener<S> = (state: S, prev: S) => void;

export interface Store<S extends object> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
  /** Call `fn` only when `select(state)` changes (by `Object.is`, or `eq`). Calls it once immediately. */
  select<T>(select: (s: S) => T, fn: (value: T, prev: T | undefined) => void, eq?: (a: T, b: T) => boolean): () => void;
}

/** A minimal immutable store. State objects are replaced, never mutated. */
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    select(select, fn, eq = Object.is) {
      let current = select(state);
      fn(current, undefined);
      const listener: Listener<S> = (s) => {
        const next = select(s);
        if (eq(next, current)) return;
        const prev = current;
        current = next;
        fn(next, prev);
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
