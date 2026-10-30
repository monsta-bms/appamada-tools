// Normal GM JSON records retain their existing shape. Non-JSON damaged values
// are described as a graph rather than silently becoming null or losing cycles.
export function preserveRawRecord(record) {
  const seen = new WeakSet();
  function jsonCompatible(value, depth = 0) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value !== "object" || seen.has(value) || depth > 100) return false;
    seen.add(value);
    if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]") return false;
    if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
    return Object.keys(value).every(key => jsonCompatible(value[key], depth + 1));
  }
  if (jsonCompatible(record.value)) return record;
  const references = new WeakMap(), nodes = [], pending = [];
  function reference(value) {
    if (value === null || ["string", "boolean"].includes(typeof value)) return { type: "literal", value };
    if (typeof value === "number") return { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
    if (typeof value === "undefined") return { type: "undefined" };
    if (typeof value === "bigint") return { type: "bigint", value: String(value) };
    if (typeof value !== "object") return { type: "unsupported", description: typeof value };
    if (!references.has(value)) {
      const id = nodes.length;
      references.set(value, id); nodes.push(null); pending.push(value);
    }
    return { type: "reference", id: references.get(value) };
  }
  const root = reference(record.value);
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index], id = references.get(value);
    if (value instanceof Map) nodes[id] = { type: "map", entries: [...value].map(([k, v]) => [reference(k), reference(v)]) };
    else if (value instanceof Set) nodes[id] = { type: "set", values: [...value].map(reference) };
    else if (value instanceof Date) nodes[id] = { type: "date", value: String(value.getTime()) };
    else nodes[id] = { type: Array.isArray(value) ? "array" : "object",
      ...(Array.isArray(value) ? { length: value.length } : {}),
      entries: Object.keys(value).map(key => [key, reference(value[key])]) };
  }
  return { key: record.key, encoding: "structured-graph-v1", value: { root, nodes } };
}
