import { createApiClient } from "./api-client.js";
import { parseBmsirPage } from "./bmsir-parser.js";
import { createLogger } from "./logger.js";
import { installSubmissionUi } from "./ui.js";

const CLIENT_VERSION = "0.2.0-test";
const DEBUG = false;
const logger = createLogger({ debug: DEBUG });
const parseResult = parseBmsirPage(document, location.href);

if (!parseResult.ok) {
  logger.debug("PARSE_FAILED", parseResult.error);
} else {
  try {
    const apiClient = createApiClient({
      apiUrl: __APPAMADA_API_URL__,
      gmRequest: GM_xmlhttpRequest,
    });
    installSubmissionUi({
      document,
      window,
      parsedPage: parseResult,
      apiClient,
      clientVersion: CLIENT_VERSION,
      addStyle: typeof GM_addStyle === "function" ? GM_addStyle : undefined,
      logger,
    });
  } catch (error) {
    logger.warn("PHASE2_INIT_FAILED", error?.code ?? "INTERNAL_ERROR");
  }
}
