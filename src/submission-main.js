import { createApiClient } from "./api-client.js";
import { collectDomDiagnostics, parseBmsirPage } from "./bmsir-parser.js";
import { createLogger } from "./logger.js";
import { installSubmissionUi } from "./ui.js";

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
    logger.warn("SUBMISSION_INIT_FAILED", error?.code ?? "INTERNAL_ERROR");
  }
}
