/**
 * THE WIRE CONTRACT between a custom view (the guest, in an iframe) and the
 * Conexus X app hosting it.
 *
 * It lives in ONE file imported by both halves — src/guest.ts and src/host.ts —
 * for the same reason the client and server enums in the main repo are marked
 * "change both together": a protocol defined twice is a protocol that drifts,
 * and the drift only shows up in a third party's app, in production, where it
 * is the hardest thing we could possibly be asked to debug.
 *
 * WHY postMessage AND NOT a shared React tree: a custom view is code we did not
 * write. Rendered into the host's DOM it would share globals, styles, and — the
 * part that actually matters — the signed-in user's JWT sitting in the host's
 * storage. An iframe on a separate origin can read none of that. Every piece of
 * data a view gets, it gets because the host handed it over deliberately.
 */

/**
 * Bumped ONLY on a breaking change to the envelopes below.
 *
 * The host refuses a guest whose major version it does not know rather than
 * half-speaking to it: a view that renders with three of its five fields
 * missing looks like our bug and reads like data loss to the customer.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Marks a message as ours. The window.postMessage bus is shared — browser
 * extensions, dev tools, HMR and analytics scripts all post into it, and this
 * session has already seen an injected script crash inside one such listener.
 */
export const MESSAGE_NAMESPACE = "conexus-x";

/** How long a guest waits for the host to answer one request before rejecting. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** How long a guest waits for the handshake before giving up. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What an app may ask for, declared in its manifest and granted by the host.
 *
 * Deliberately coarse — one scope per resource per direction. A per-field or
 * per-column permission model sounds safer and is not: nobody can hold it in
 * their head at review time, so every app ends up approved with the whole set
 * ticked, which is the outcome the granularity was supposed to prevent.
 *
 * NOTE the ceiling: a scope can never widen what the SIGNED-IN USER may do. The
 * host proxies every call with that person's own credentials and the API
 * re-checks workspace membership and module access on each one, so a view
 * granted `records:write` inside a board the user may only read still gets a
 * 403 from the server. Scopes narrow; they do not grant.
 */
export const SCOPES = [
    "records:read",
    "records:write",
    "collections:read",
    "collections:write",
    "columns:read",
    "columns:write",
    "values:read",
    "values:write",
    "amendments:read",
    "amendments:write",
    "members:read",
    "activity:read",
    "storage"
] as const;

export type Scope = (typeof SCOPES)[number];

export const isScope = (value: unknown): value is Scope =>
    typeof value === "string" && (SCOPES as readonly string[]).includes(value);

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

export interface BaseEnvelope {
    /** Namespace tag. Anything without it is somebody else's message. */
    cx: typeof MESSAGE_NAMESPACE;
    v: number;
}

/** guest -> host, once, to open the channel. */
export interface HelloMessage extends BaseEnvelope {
    kind: "hello";
    /** The app asking, as declared in its manifest. */
    appId: string;
    /** Version of this SDK, so the host can report which apps are on old builds. */
    sdkVersion: string;
    /** What the app wants. The host answers with what it actually granted. */
    scopes: Scope[];
}

/** host -> guest, the answer to hello. */
export interface WelcomeMessage extends BaseEnvelope {
    kind: "welcome";
    /**
     * Identifies THIS MOUNT of the view, not the app and not the view.
     * Storage is namespaced by it, so the same app placed on two boards keeps
     * two separate sets of state rather than one that fights itself.
     */
    instanceId: string;
    context: unknown;
    settings: Record<string, unknown>;
    /**
     * The subset of the requested scopes the host will actually serve. An app
     * asking for more than it was approved for is NOT rejected outright — it
     * runs degraded, because a view that renders read-only is more useful to
     * the person looking at it than one that refuses to load.
     */
    grantedScopes: Scope[];
    hostVersion: string;
}

/** guest -> host, an RPC call. */
export interface RequestMessage extends BaseEnvelope {
    kind: "request";
    /** Correlation id, generated by the guest. */
    id: string;
    method: RpcMethod;
    params: unknown;
}

/** host -> guest, the answer to exactly one request. */
export type ResponseMessage = BaseEnvelope & {
    kind: "response";
    id: string;
} & (
    | { ok: true; result: unknown }
    | { ok: false; error: ProtocolError }
);

/** host -> guest, unsolicited. */
export interface EventMessage extends BaseEnvelope {
    kind: "event";
    topic: EventTopic;
    payload: unknown;
}

export type GuestMessage = HelloMessage | RequestMessage;
export type HostMessage = WelcomeMessage | ResponseMessage | EventMessage;
export type AnyMessage = GuestMessage | HostMessage;

/* -------------------------------------------------------------------------- */
/* Methods and topics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Dotted names rather than one message kind per operation: adding a capability
 * should be a row in a table on both sides, not a new envelope type that every
 * switch statement in the package has to learn.
 */
export const RPC_METHODS = [
    "context.get",
    "settings.get",
    "api.request",
    "command.execute",
    "storage.get",
    "storage.set",
    "storage.delete",
    "storage.keys"
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export const isRpcMethod = (value: unknown): value is RpcMethod =>
    typeof value === "string" && (RPC_METHODS as readonly string[]).includes(value);

/**
 * What the host pushes without being asked.
 *
 * `change` is the CRM realtime envelope forwarded down, already filtered to the
 * module this view is mounted in — a view must not learn that a record moved on
 * a board its user cannot open, and the host is the only place that rule can be
 * enforced.
 */
export const EVENT_TOPICS = [
    "context",
    "settings",
    "selection",
    "change",
    "theme"
] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Codes, not sentences. The guest branches on `code`; `message` is for the
 * developer console and may be reworded at any time.
 */
export const ERROR_CODES = [
    "protocol_mismatch",
    "not_connected",
    "timeout",
    "scope_denied",
    "route_denied",
    "bad_request",
    "command_unsupported",
    "storage_unavailable",
    "host_error",
    "api_error"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolError {
    code: ErrorCode;
    message: string;
    /** HTTP status, when the failure came from the CRM API rather than the bridge. */
    status?: number;
    details?: unknown;
}

/** Thrown guest-side so `catch (e) { if (e instanceof ConexusError) ... }` works. */
export class ConexusError extends Error {
    readonly code: ErrorCode;
    readonly status?: number;
    readonly details?: unknown;

    constructor(error: ProtocolError) {
        super(error.message);
        this.name = "ConexusError";
        this.code = error.code;
        this.status = error.status;
        this.details = error.details;
    }
}

export const protocolError = (
    code: ErrorCode,
    message: string,
    extra?: { status?: number; details?: unknown }
): ProtocolError => ({
    code,
    message,
    ...(extra?.status === undefined ? {} : { status: extra.status }),
    ...(extra?.details === undefined ? {} : { details: extra.details })
});

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Is this one of ours, and can we speak its version?
 *
 * Checked on EVERY inbound message on both sides. The window message bus is
 * shared with anything else on the page, so "it has a .kind I recognise" is not
 * enough to act on.
 */
export const isEnvelope = (
    data: unknown
): data is BaseEnvelope & { kind: string } & Record<string, unknown> => {
    if (typeof data !== "object" || data === null) return false;

    const candidate = data as Partial<BaseEnvelope> & { kind?: unknown };

    return (
        candidate.cx === MESSAGE_NAMESPACE &&
        typeof candidate.v === "number" &&
        typeof candidate.kind === "string"
    );
};

export const isSpeakable = (data: BaseEnvelope): boolean =>
    data.v === PROTOCOL_VERSION;

/**
 * Correlation ids.
 *
 * crypto.randomUUID is deliberately not assumed: this runs in whatever browser
 * the customer opens, and an id that only has to be unique within one channel
 * does not need to be cryptographically strong.
 */
export const newId = (prefix: string): string =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
