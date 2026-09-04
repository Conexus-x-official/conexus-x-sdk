/**
 * @conexus-x/sdk — build a custom view that runs inside a Conexus X module.
 *
 * The default export is the guest client, which is all an app author needs:
 *
 *     import conexus from "@conexus-x/sdk";
 *     const cx = conexus();
 *
 * The host bridge is a separate entry point (`@conexus-x/sdk/host`) so a third
 * party bundle never pulls it in, and the manifest tooling is a third
 * (`@conexus-x/sdk/manifest`) so the review pipeline can validate a submission
 * without loading any browser code.
 */

export { default, default as conexus, ConexusClient, SDK_VERSION } from "./guest.js";
export type { ConexusOptions } from "./guest.js";

export {
    ConexusError,
    PROTOCOL_VERSION,
    SCOPES,
    EVENT_TOPICS,
    ERROR_CODES,
    isScope
} from "./protocol.js";

export type {
    ErrorCode,
    EventTopic,
    ProtocolError,
    Scope
} from "./protocol.js";

export { ROUTES, explainScope, matchRoute } from "./routes.js";
export type { RouteRule, RouteMatch } from "./routes.js";

export type {
    ApiRequest,
    ApiResponse,
    ChangeEvent,
    CommandMap,
    CommandName,
    CommandResults,
    Connection,
    CxAmendment,
    CxCollection,
    CxColumn,
    CxMember,
    CxRecord,
    CxRecordValue,
    CxStatusOption,
    CxUser,
    EventMap,
    HttpMethod,
    ViewContext
} from "./types.js";
