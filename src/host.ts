/**
 * THE HOST HALF — what the Conexus X app itself runs to mount a custom view.
 *
 * It ships in the same package as the guest so the two cannot drift apart. The
 * app imports `@conexus-x/sdk/host`; a third party never does, and nothing here
 * is useful without the app credentials anyway.
 *
 *     const host = createViewHost({
 *         iframe,
 *         appOrigin: "https://apps.example.com",
 *         grantedScopes: install.scopes,
 *         getContext: () => contextRef.current,
 *         transport: fetchTransport({ baseUrl: API_URL, token: () => getToken() }),
 *         storage: memoryStorage(),
 *         commands: { notice: async ({ message }) => toast(message) }
 *     });
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the guest asks, the host decides. Every
 * call is checked against the granted scopes and the route allowlist before it
 * is allowed anywhere near the API, and it is then made with the SIGNED-IN USER
 * credentials — so the server permission checks still run underneath ours. Two
 * independent gates, neither trusting the other.
 */

import {
    MESSAGE_NAMESPACE,
    PROTOCOL_VERSION,
    isEnvelope,
    isRpcMethod,
    isScope,
    isSpeakable,
    newId,
    protocolError,
    type EventTopic,
    type ProtocolError,
    type RpcMethod,
    type Scope
} from "./protocol.js";

import { matchRoute } from "./routes.js";

import type {
    ApiRequest,
    ApiResponse,
    ChangeEvent,
    CommandMap,
    CommandName,
    EventMap,
    ViewContext
} from "./types.js";

export const HOST_VERSION = "0.1.0";

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the host actually reaches the CRM API.
 *
 * An interface rather than a fetch call baked into the bridge: the app already
 * owns token refresh, the API base URL and its error conventions, and a second
 * copy of that logic living in the SDK is a second thing to keep in step.
 */
export type HostTransport = (input: ApiRequest) => Promise<ApiResponse>;

/**
 * A per-instance key-value store.
 *
 * `namespace` is the view instance id, so two mounts of the same app never see
 * each other keys. Backing it with localStorage, a table, or nothing at all is
 * the app decision — the SDK only needs these four operations.
 */
export interface HostStorage {
    get(namespace: string, key: string): Promise<unknown>;
    set(namespace: string, key: string, value: unknown): Promise<void>;
    delete(namespace: string, key: string): Promise<void>;
    keys(namespace: string): Promise<string[]>;
}

/** Fine for the test environment and for development. Dies with the tab. */
export const memoryStorage = (): HostStorage => {
    const store = new Map<string, Map<string, unknown>>();

    const bucket = (namespace: string) => {
        const existing = store.get(namespace);

        if (existing) return existing;

        const created = new Map<string, unknown>();
        store.set(namespace, created);
        return created;
    };

    return {
        async get(namespace, key) {
            return bucket(namespace).get(key) ?? null;
        },
        async set(namespace, key, value) {
            bucket(namespace).set(key, value);
        },
        async delete(namespace, key) {
            bucket(namespace).delete(key);
        },
        async keys(namespace) {
            return [...bucket(namespace).keys()];
        }
    };
};

/**
 * The obvious transport: bearer token, JSON in and out.
 *
 * `token` is a FUNCTION so a refresh mid-session is picked up on the next call
 * rather than pinned at mount — a long-lived board is exactly where a captured
 * token goes stale.
 */
export const fetchTransport = (options: {
    baseUrl: string;
    token: () => string | null | undefined;
    fetchImpl?: typeof fetch;
}): HostTransport => {
    const doFetch = options.fetchImpl ?? fetch;
    const base = options.baseUrl.replace(/\/$/, "");

    return async (input) => {
        const query = new URLSearchParams();

        for (const [key, value] of Object.entries(input.query ?? {})) {
            if (value !== undefined) query.set(key, String(value));
        }

        const suffix = query.toString();
        const url = `${base}${input.path}${suffix ? `?${suffix}` : ""}`;
        const token = options.token();

        const response = await doFetch(url, {
            method: input.method,
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
        });

        // Some endpoints answer 204, and a body-less response is not an error.
        const text = await response.text();
        let data: unknown = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        return { status: response.status, data };
    };
};

/* -------------------------------------------------------------------------- */
/* The bridge                                                                 */
/* -------------------------------------------------------------------------- */

export type CommandHandlers = {
    [K in CommandName]?: (params: CommandMap[K]) => Promise<unknown> | unknown;
};

export interface ViewHostOptions {
    iframe: HTMLIFrameElement;
    /**
     * The exact origin the view is served from, as recorded on the installed
     * app. Messages from anywhere else are ignored and replies are addressed
     * only here — this is what stops a second frame on the page from answering
     * on the app behalf or reading what we send it.
     */
    appOrigin: string;
    /**
     * What this installation is actually allowed to do. The app may ASK for
     * more in its manifest; this is the answer, and it is the only one that
     * counts.
     */
    grantedScopes: Scope[];
    /** Read fresh on every request, so a board change is never served stale. */
    getContext: () => ViewContext;
    getSettings?: () => Record<string, unknown>;
    transport: HostTransport;
    storage?: HostStorage;
    commands?: CommandHandlers;
    /** Called for every refusal and internal failure. Wire it to your logging. */
    onError?: (error: ProtocolError, detail?: unknown) => void;
    /** Called once the guest has completed the handshake. */
    onConnect?: (info: { appId: string; sdkVersion: string; grantedScopes: Scope[] }) => void;
}

export interface ViewHost {
    readonly connected: boolean;
    /** Push an event down to the view. No-op until the guest has said hello. */
    push<T extends EventTopic>(topic: T, payload: EventMap[T]): void;
    /** Re-send the current context — call it when the board, theme or selection moves. */
    pushContext(): void;
    /**
     * Forward one CRM realtime envelope, dropped unless it belongs to the board
     * this view is mounted on. The filter is here rather than in the guest
     * because a view must not be able to learn about a board its user cannot
     * open, and only the host knows which board that is.
     */
    forwardChange(event: ChangeEvent): void;
    destroy(): void;
}

export const createViewHost = (options: ViewHostOptions): ViewHost => {
    const storage = options.storage ?? memoryStorage();

    let connected = false;
    let destroyed = false;
    let grantedForInstance: Scope[] = [];

    const fail = (error: ProtocolError, detail?: unknown): ProtocolError => {
        options.onError?.(error, detail);
        return error;
    };

    const post = (message: Record<string, unknown>): void => {
        const target = options.iframe.contentWindow;

        if (!target) return;

        // Never "*": the payload carries the customer own data.
        target.postMessage(
            { cx: MESSAGE_NAMESPACE, v: PROTOCOL_VERSION, ...message },
            options.appOrigin
        );
    };

    const requireScope = (scope: Scope): void => {
        if (grantedForInstance.includes(scope)) return;

        throw fail(
            protocolError(
                "scope_denied",
                `This app was not granted "${scope}".`,
                { details: { scope } }
            )
        );
    };

    /* ---- method dispatch ------------------------------------------------ */

    const handleApiRequest = async (params: unknown): Promise<ApiResponse> => {
        const input = params as ApiRequest;

        if (!input || typeof input.path !== "string" || typeof input.method !== "string") {
            throw fail(protocolError("bad_request", "An api.request needs a method and a path."));
        }

        const match = matchRoute(input.method, input.path);

        // Unknown and forbidden get the SAME answer on purpose — telling an app
        // which internal endpoints exist is free reconnaissance.
        if (!match) {
            throw fail(
                protocolError(
                    "route_denied",
                    `${input.method} ${input.path} is not an endpoint apps may call.`,
                    { details: { method: input.method, path: input.path } }
                )
            );
        }

        requireScope(match.rule.scope);

        try {
            const response = await options.transport({
                method: match.rule.method,
                path: input.path,
                ...(input.query === undefined ? {} : { query: input.query }),
                ...(input.body === undefined ? {} : { body: input.body })
            });

            // A 4xx from the API is DATA, not a bridge failure: the app asked
            // for something its user may not have, and it should see the status
            // rather than a generic transport error.
            return response;
        } catch (error) {
            throw fail(
                protocolError("api_error", "The request to the Conexus X API failed."),
                error
            );
        }
    };

    const handleCommand = async (params: unknown): Promise<unknown> => {
        const input = params as { command?: CommandName; params?: unknown };
        const name = input?.command;

        if (!name) {
            throw fail(protocolError("bad_request", "A command.execute needs a command name."));
        }

        const handler = options.commands?.[name] as
            | ((value: unknown) => Promise<unknown> | unknown)
            | undefined;

        if (!handler) {
            throw fail(
                protocolError(
                    "command_unsupported",
                    `This host does not implement "${name}".`,
                    { details: { command: name } }
                )
            );
        }

        try {
            return (await handler(input.params)) ?? null;
        } catch (error) {
            throw fail(protocolError("host_error", `"${name}" failed.`), error);
        }
    };

    const handleStorage = async (method: RpcMethod, params: unknown): Promise<unknown> => {
        requireScope("storage");

        const namespace = options.getContext().instanceId;
        const input = (params ?? {}) as { key?: unknown; value?: unknown };

        if (method === "storage.keys") return storage.keys(namespace);

        if (typeof input.key !== "string" || input.key.length === 0) {
            throw fail(protocolError("bad_request", "A storage call needs a string key."));
        }

        try {
            if (method === "storage.get") return (await storage.get(namespace, input.key)) ?? null;
            if (method === "storage.set") return (await storage.set(namespace, input.key, input.value)) ?? null;
            if (method === "storage.delete") return (await storage.delete(namespace, input.key)) ?? null;
        } catch (error) {
            throw fail(protocolError("storage_unavailable", "Storage is not available."), error);
        }

        throw fail(protocolError("bad_request", `Unknown storage method ${method}.`));
    };

    const dispatch = async (method: RpcMethod, params: unknown): Promise<unknown> => {
        switch (method) {
            case "context.get":
                return options.getContext();

            case "settings.get":
                return options.getSettings?.() ?? {};

            case "api.request":
                return handleApiRequest(params);

            case "command.execute":
                return handleCommand(params);

            case "storage.get":
            case "storage.set":
            case "storage.delete":
            case "storage.keys":
                return handleStorage(method, params);

            default:
                throw fail(protocolError("bad_request", `Unknown method ${method}.`));
        }
    };

    /* ---- the channel ---------------------------------------------------- */

    const onMessage = async (event: MessageEvent): Promise<void> => {
        if (destroyed) return;

        // Same three checks the guest makes, in the other direction.
        if (event.origin !== options.appOrigin) return;
        if (event.source !== options.iframe.contentWindow) return;
        if (!isEnvelope(event.data)) return;

        const message = event.data as { kind: string } & Record<string, unknown>;

        if (!isSpeakable(event.data)) {
            // Answer the handshake so the guest fails fast with a real reason
            // instead of timing out and reporting "the host is down".
            if (message.kind === "hello") {
                post({
                    kind: "response",
                    id: "handshake",
                    ok: false,
                    error: protocolError(
                        "protocol_mismatch",
                        `This host speaks protocol v${PROTOCOL_VERSION}.`
                    )
                });
            }
            return;
        }

        if (message.kind === "hello") {
            const requested = Array.isArray(message.scopes)
                ? (message.scopes as unknown[]).filter(isScope)
                : [];

            // The intersection, never the union. An app that asks for more than
            // it was approved for runs degraded rather than being refused —
            // read-only is more useful to the person looking at it than a view
            // that will not load.
            grantedForInstance = requested.filter((scope) =>
                options.grantedScopes.includes(scope)
            );

            connected = true;

            post({
                kind: "welcome",
                instanceId: options.getContext().instanceId,
                context: options.getContext(),
                settings: options.getSettings?.() ?? {},
                grantedScopes: grantedForInstance,
                hostVersion: HOST_VERSION
            });

            options.onConnect?.({
                appId: String(message.appId ?? "unknown"),
                sdkVersion: String(message.sdkVersion ?? "unknown"),
                grantedScopes: grantedForInstance
            });

            return;
        }

        if (message.kind !== "request") return;

        const id = String(message.id ?? "");

        if (!id) return;

        if (!isRpcMethod(message.method)) {
            post({
                kind: "response",
                id,
                ok: false,
                error: fail(protocolError("bad_request", "Unknown method."))
            });
            return;
        }

        // A request before the handshake is not served: the scope set is not
        // known yet, and defaulting it either way is the wrong answer.
        if (!connected) {
            post({
                kind: "response",
                id,
                ok: false,
                error: fail(protocolError("not_connected", "Say hello first."))
            });
            return;
        }

        try {
            const result = await dispatch(message.method, message.params);
            post({ kind: "response", id, ok: true, result: result ?? null });
        } catch (error) {
            const known =
                error && typeof error === "object" && "code" in error
                    ? (error as ProtocolError)
                    : fail(protocolError("host_error", "The host failed to serve the request."), error);

            post({ kind: "response", id, ok: false, error: known });
        }
    };

    const listener = (event: MessageEvent) => {
        void onMessage(event);
    };

    window.addEventListener("message", listener);

    return {
        get connected() {
            return connected;
        },

        push(topic, payload) {
            if (!connected) return;
            post({ kind: "event", topic, payload });
        },

        pushContext() {
            if (!connected) return;
            post({ kind: "event", topic: "context", payload: options.getContext() });
        },

        forwardChange(event) {
            if (!connected) return;

            const context = options.getContext();

            // Board-scoped rows only reach a view mounted on that board; a
            // workspace-scoped row still has to match the workspace.
            if (event.moduleId && context.moduleId && event.moduleId !== context.moduleId) return;
            if (event.workspaceId && event.workspaceId !== context.workspaceId) return;

            post({ kind: "event", topic: "change", payload: event });
        },

        destroy() {
            destroyed = true;
            connected = false;
            window.removeEventListener("message", listener);
        }
    };
};

/**
 * Build the src for a view iframe.
 *
 * The guest reads its host origin, app id and requested scopes from these
 * parameters, so the app never has to hard-code where it is embedded — and the
 * origin the guest pins is one WE chose, not one it guessed from the referrer.
 */
export const buildViewUrl = (options: {
    entry: string;
    appId: string;
    viewId: string;
    instanceId?: string;
    scopes: Scope[];
    hostOrigin?: string;
}): string => {
    const url = new URL(options.entry);

    url.searchParams.set("cxApp", options.appId);
    url.searchParams.set("cxView", options.viewId);
    url.searchParams.set("cxInstance", options.instanceId ?? newId("inst"));
    url.searchParams.set("cxScopes", options.scopes.join(","));
    url.searchParams.set(
        "cxOrigin",
        options.hostOrigin ?? (typeof window === "undefined" ? "" : window.location.origin)
    );

    return url.toString();
};

/**
 * The sandbox attributes a view iframe must carry.
 *
 * `allow-same-origin` is present because the guest needs its own origin storage
 * and a usable fetch to its own backend — it does NOT grant access to ours, as
 * the app is served from a different origin. `allow-top-navigation` is absent
 * on purpose: a view must never be able to navigate the whole CRM tab somewhere
 * else, which is the classic way an embedded app phishes a login.
 */
export const VIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";
