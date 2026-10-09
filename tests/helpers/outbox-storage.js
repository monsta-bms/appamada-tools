export function memoryStorage(values = new Map()) {
  return {
    values,
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
    async keys() { return [...values.keys()]; },
  };
}
