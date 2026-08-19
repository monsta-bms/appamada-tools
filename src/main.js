import { collectDomDiagnostics, parseBmsirPage } from "./bmsir-parser.js";
import { createLogger } from "./logger.js";

const DEBUG = false;
const logger = createLogger({ debug: DEBUG });
const parseResult = parseBmsirPage(document, location.href);

if (!parseResult.ok) {
  logger.warn("PARSE_FAILED", {
    code: parseResult.error,
    ...collectDomDiagnostics(document, location.href),
  });
} else {
  // Phase 1ではページ情報をローカルな内部状態へ保持するだけで、外部通信もUI追加も行わない。
  const phase1State = Object.freeze({
    user: Object.freeze({ ...parseResult.user }),
    song: Object.freeze({ ...parseResult.song }),
  });
  void phase1State;
  logger.debug("PARSE_READY");
}
