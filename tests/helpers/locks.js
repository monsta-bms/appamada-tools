// Deterministic browser-lock substitute. Separate instances model separate origins.
export function lockManager() {
  const held = new Set(), tails = new Map(), names = [];
  return { names, async request(name, options, callback) {
    names.push(name);
    if (typeof options === "function") { callback = options; options = {}; }
    if (options.ifAvailable && held.has(name)) return callback(null);
    const previous = tails.get(name) ?? Promise.resolve();
    let release;
    const tail = new Promise(resolve => { release = resolve; });
    tails.set(name, tail);
    await previous;
    held.add(name);
    try { return await callback({ name }); }
    finally { held.delete(name); release(); if (tails.get(name) === tail) tails.delete(name); }
  } };
}
