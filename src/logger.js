const PREFIX = "[appamada-userscript]";

export function createLogger({ debug = false, sink = globalThis.console } = {}) {
  function write(level, eventCode, detail) {
    if (level === "debug" && !debug) {
      return;
    }

    const method = typeof sink?.[level] === "function" ? sink[level] : sink?.log;
    if (typeof method !== "function") {
      return;
    }

    const message = `${PREFIX} ${eventCode}`;
    if (detail === undefined) {
      method.call(sink, message);
    } else {
      method.call(sink, message, detail);
    }
  }

  return Object.freeze({
    error(eventCode, detail) {
      write("error", eventCode, detail);
    },
    warn(eventCode, detail) {
      write("warn", eventCode, detail);
    },
    debug(eventCode, detail) {
      write("debug", eventCode, detail);
    },
  });
}
