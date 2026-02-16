export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function set(patch) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  }

  function update(mutator) {
    const next = mutator(state);
    state = next;
    listeners.forEach((listener) => listener(state));
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  }

  function get() {
    return state;
  }

  return { set, update, subscribe, get };
}
