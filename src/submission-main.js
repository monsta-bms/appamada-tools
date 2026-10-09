import { createApiClient } from "./api-client.js";
import { collectDomDiagnostics, parseBmsirPage } from "./bmsir-parser.js";
import { createLogger } from "./logger.js";
import { installSubmissionUi } from "./ui.js";
import { createGmStorage, createOutbox, startOutboxSync } from "./outbox.js";

const CLIENT_VERSION = __APPAMADA_CLIENT_VERSION__;
const DEBUG = false;
const logger = createLogger({ debug: DEBUG });
const parseResult = parseBmsirPage(document, location.href);

if (!parseResult.ok) {
  logger.warn("PARSE_FAILED", {
    code: parseResult.error,
    ...collectDomDiagnostics(document, location.href),
  });
} else {
  try {
    const apiClient = createApiClient({
      apiUrl: __APPAMADA_API_URL__,
      gmRequest: GM_xmlhttpRequest,
    });
    const storage = createGmStorage({
      modern: typeof GM === "object" ? GM : undefined,
      legacy: {
        get: typeof GM_getValue === "function" ? GM_getValue : undefined,
        set: typeof GM_setValue === "function" ? GM_setValue : undefined,
        remove: typeof GM_deleteValue === "function" ? GM_deleteValue : undefined,
        keys: typeof GM_listValues === "function" ? GM_listValues : undefined,
      },
    });
    const outbox = storage ? createOutbox({ storage, apiClient,
      playerId: parseResult.user.playerId, locks: window.navigator.locks }) : undefined;
    const ui = installSubmissionUi({
      document,
      window,
      parsedPage: parseResult,
      apiClient,
      outbox,
      clientVersion: CLIENT_VERSION,
      addStyle: typeof GM_addStyle === "function" ? GM_addStyle : undefined,
      logger,
    });
    if (outbox) startOutboxSync({ outbox, window,
      onError: (error) => logger.debug("OUTBOX_SYNC_FAILED", error?.code ?? "INTERNAL_ERROR") });
    // Apps Scriptの起動・redirect待ちをユーザー操作より先に済ませる。
    // openWorkflow側の同一MD5 lookupはin-flight共有またはcache hitになる。
    void apiClient.lookup(parseResult.song.md5).catch((error) => {
      logger.debug("LOOKUP_PREFETCH_FAILED", error?.code ?? "INTERNAL_ERROR");
      ui.markLookupUnavailable(error?.code);
    });
  } catch (error) {
    logger.warn("SUBMISSION_INIT_FAILED", error?.code ?? "INTERNAL_ERROR");
  }
}
