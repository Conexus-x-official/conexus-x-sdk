/**
 * THE GUEST HALF — what a third party installs and runs inside their view.
 *
 *     import conexus from "@conexus-x/sdk";
 *
 *     const cx = conexus();
 *     const { context } = await cx.connect();
 *     const records = await cx.api.records.list(context.collectionId!);
 *
 * Everything here funnels through one postMessage channel to the host. There is
 * no fetch, no token, and no CRM base URL in this file on purpose: an app that
 * cannot address our API directly is an app that cannot be tricked into
 * addressing it with someone else credentials.
 */

import {
    ConexusError,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MESSAGE_NAMESPACE,
    PROTOCOL_VERSION,
    isEnvelope,
    isScope,
    isSpeakable,
    newId,
    protocolError,
    type EventTopic,
    type ProtocolError,
    type RpcMethod,
    type Scope
} from "./protocol.js";

import type {
    ApiRequest,
    ApiResponse,
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
    EventMap,
    ViewContext
} from "./types.js";

/** Kept in step with package.json — reported to the host at handshake. */
export const SDK_VERSION = "0.1.0";

export interface ConexusOptions {
    /**
     * The app id from the manifest. Normally left out: the host puts it in the
     * iframe URL, and hard-coding it is one more thing to get wrong when an app
     * is cloned to make a second one.
     */
    appId?: string;
    /** Scopes to ask for. Defaults to what the host already put in the URL. */
    scopes?: Scope[];
    /**
     * The exact origin of the host page. Defaults to the `cxOrigin` URL
     * parameter. Every inbound message is checked against it and every outbound
     * one is addressed to it — a "*" target here would broadcast the customer
     * data in this view to whatever page happened to frame it.
     */
    hostOrigin?: string;
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: ConexusError) => void;
    timer: ReturnType<typeof setTimeout>;
}

const readParam = (name: string): string | undefined => {
    if (typeof window === "undefined") return undefined;

    const value = new URLSearchParams(window.location.search).get(name);
    return value === null || value === "" ? undefined : value;
};

export class ConexusClient {
    private readonly options: ConexusOptions;

    /**
     * Resolved at CONNECT time, not in the constructor.
     *
     * The constructor used to read the URL and throw when `cxOrigin` was
     * missing, which broke every server-rendered view: a "use client"
     * component is still rendered once on the server, where there is no
     * `window`, so merely constructing a client threw and took the whole
     * prerender down. Caught by building the Next starter, not by reading.
     *
     * Constructing a client is therefore now free of side effects and cannot
     * fail. A missing origin is a CONNECTION failure — it arrives as a
     * rejected `connect()` with a `not_connected` code, which is a state the
     * view already has to render anyway.
     */
    private hostOrigin: string | null = null;
    private appId = "unknown-app";
    private requestedScopes: Scope[] = [];

    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Map<EventTopic, Set<(payload: never) => void>>();

    private link: Connection | null = null;
    private connecting: Promise<Connection> | null = null;
    private destroyed = false;

    private onMessage?: (event: MessageEvent) => void;
    private resizeObserver?: ResizeObserver;

    constructor(options: ConexusOptions = {}) {
        this.options = options;
    }

    /**
     * Read the mount parameters the host put in the iframe URL.
     *
     * Runs on the first connect, in the browser, where the URL exists. Returns
     * the origin or null; the caller turns null into a rejected connection with
     * a message that names the fix.
     */
    private resolveConfig(): string | null {
        const origin = this.options.hostOrigin ?? readParam("cxOrigin") ?? null;

        this.hostOrigin = origin;
        this.appId = this.options.appId ?? readParam("cxApp") ?? "unknown-app";

        const fromUrl = (readParam("cxScopes") ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(isScope);

        this.requestedScopes = this.options.scopes ?? fromUrl;

        return origin;
    }

    /* ---------------------------------------------------------------------- */
    /* Connection                                                             */
    /* ---------------------------------------------------------------------- */

    /**
     * Open the channel. Safe to call repeatedly — the same promise is returned
     * until it settles, so ten components calling it on mount produce one
     * handshake rather than ten.
     */
    connect(): Promise<Connection> {
        if (this.link) return Promise.resolve(this.link);
        if (this.connecting) return this.connecting;

        if (typeof window === "undefined") {
            return Promise.reject(
                new ConexusError(
                    protocolError("not_connected", "The SDK needs a browser window.")
                )
            );
        }

        if (window.parent === window) {
            return Promise.reject(
                new ConexusError(
                    protocolError(
                        "not_connected",
                        "This view is not embedded. A Conexus X view runs in an iframe inside the app."
                    )
                )
            );
        }

        if (!this.resolveConfig()) {
            return Promise.reject(
                new ConexusError(
                    protocolError(
                        "not_connected",
                        "No host origin. Conexus X passes it as ?cxOrigin=; pass { hostOrigin } explicitly if you are running this view outside the app."
                    )
                )
            );
        }

        this.attach();

        this.connecting = new Promise<Connection>((resolve, reject) => {
            const timeout = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

            const timer = setTimeout(() => {
                this.pending.delete("handshake");
                reject(
                    new ConexusError(
                        protocolError(
                            "timeout",
                            `The host did not answer within ${timeout}ms. Check that ${this.hostOrigin} is the page hosting this view.`
                        )
                    )
                );
            }, timeout);

            this.pending.set("handshake", {
                resolve: (value) => resolve(value as Connection),
                reject,
                timer
            });

            this.post({
                cx: MESSAGE_NAMESPACE,
                v: PROTOCOL_VERSION,
                kind: "hello",
                appId: this.appId,
                sdkVersion: SDK_VERSION,
                scopes: this.requestedScopes
            });
        });

        this.connecting
            .then((connection) => {
                this.link = connection;
            })
            .catch(() => {
                // Leave `connection` null so the next call retries rather than
                // handing every later caller the same stale rejection.
            })
            .finally(() => {
                this.connecting = null;
            });

        return this.connecting;
    }

    get isConnected(): boolean {
        return this.link !== null;
    }

    /**
     * The live connection, or null before the handshake finishes.
     *
     * Public so the React bindings can seed state from an already-connected
     * client on first render instead of flashing a loading state that is not
     * true — the alternative was reaching into a private field.
     */
    get connection(): Connection | null {
        return this.link;
    }

    /** The last context the host sent. Null until connected. */
    get context(): ViewContext | null {
        return this.link?.context ?? null;
    }

    /** Was this scope actually granted? Feature-detect with it; do not assume. */
    hasScope(scope: Scope): boolean {
        return this.link?.grantedScopes.includes(scope) ?? false;
    }

    /* ---------------------------------------------------------------------- */
    /* Reads                                                                  */
    /* ---------------------------------------------------------------------- */

    async getContext(): Promise<ViewContext> {
        const context = await this.call<ViewContext>("context.get", {});

        if (this.link) this.link.context = context;

        return context;
    }

    async getSettings(): Promise<Record<string, unknown>> {
        return this.call<Record<string, unknown>>("settings.get", {});
    }

    /**
     * Subscribe to a host push. Returns the unsubscribe function — returning it
     * rather than exposing an `off()` means a React effect can hand it straight
     * back as its cleanup and can never mismatch the handler identity.
     */
    listen<T extends EventTopic>(
        topic: T,
        handler: (payload: EventMap[T]) => void
    ): () => void {
        void this.connect();

        const handlers = this.listeners.get(topic) ?? new Set();
        handlers.add(handler as (payload: never) => void);
        this.listeners.set(topic, handlers);

        return () => {
            handlers.delete(handler as (payload: never) => void);
        };
    }

    /* ---------------------------------------------------------------------- */
    /* Writes and host chrome                                                 */
    /* ---------------------------------------------------------------------- */

    /**
     * Ask the host to do something only it can do.
     *
     * An unimplemented command rejects with `command_unsupported` rather than
     * resolving quietly, so a view can adapt instead of believing it showed a
     * toast nobody saw.
     */
    execute<K extends CommandName>(
        command: K,
        params: CommandMap[K]
    ): Promise<CommandResults[K]> {
        return this.call<CommandResults[K]>("command.execute", { command, params });
    }

    /**
     * A raw call against the CRM API, proxied by the host.
     *
     * `path` is API-relative and must be on the allowlist in routes.ts. Prefer
     * the typed helpers on `api` below; this exists so a new endpoint does not
     * need an SDK release to be usable.
     */
    request<T = unknown>(input: ApiRequest): Promise<ApiResponse<T>> {
        return this.call<ApiResponse<T>>("api.request", input);
    }

    /**
     * Typed shortcuts over the same allowlist. Thin on purpose: they build a
     * path and hand back `data`, so there is no second place where our API
     * shapes are described and no cache to go stale.
     */
    readonly api = {
        collections: {
            list: (moduleId: string) =>
                this.data<CxCollection[]>({ method: "GET", path: `/collections/${moduleId}` }),
            create: (moduleId: string, body: { name: string; color?: string }) =>
                this.data<CxCollection>({ method: "POST", path: `/collections/${moduleId}`, body }),
            update: (collectionId: string, body: Partial<CxCollection>) =>
                this.data<CxCollection>({ method: "PUT", path: `/collections/${collectionId}`, body }),
            remove: (collectionId: string) =>
                this.data<unknown>({ method: "DELETE", path: `/collections/${collectionId}` })
        },

        columns: {
            list: (moduleId: string) =>
                this.data<CxColumn[]>({ method: "GET", path: `/columns/${moduleId}` }),
            create: (moduleId: string, body: Partial<CxColumn> & { name: string }) =>
                this.data<CxColumn>({ method: "POST", path: `/columns/${moduleId}`, body }),
            update: (columnId: string, body: Partial<CxColumn>) =>
                this.data<CxColumn>({ method: "PUT", path: `/columns/${columnId}`, body }),
            remove: (columnId: string) =>
                this.data<unknown>({ method: "DELETE", path: `/columns/${columnId}` })
        },

        records: {
            list: (collectionId: string) =>
                this.data<CxRecord[]>({ method: "GET", path: `/records/${collectionId}` }),
            create: (collectionId: string, body: { name: string; position?: number }) =>
                this.data<CxRecord>({ method: "POST", path: `/records/${collectionId}`, body }),
            update: (recordId: string, body: Partial<CxRecord>) =>
                this.data<CxRecord>({ method: "PUT", path: `/records/${recordId}`, body }),
            remove: (recordId: string) =>
                this.data<unknown>({ method: "DELETE", path: `/records/${recordId}` }),
            subRecords: (recordId: string) =>
                this.data<CxRecord[]>({ method: "GET", path: `/records/${recordId}/sub-records` }),
            createSubRecord: (recordId: string, body: { name: string }) =>
                this.data<CxRecord>({ method: "POST", path: `/records/${recordId}/sub-records`, body })
        },

        values: {
            forRecord: (recordId: string) =>
                this.data<CxRecordValue[]>({ method: "GET", path: `/record-values/${recordId}` }),
            set: (body: { record: string; column: string; value: unknown }) =>
                this.data<CxRecordValue>({ method: "POST", path: "/record-values", body }),
            update: (recordValueId: string, body: { value: unknown }) =>
                this.data<CxRecordValue>({ method: "PUT", path: `/record-values/${recordValueId}`, body }),
            clear: (recordValueId: string) =>
                this.data<unknown>({ method: "DELETE", path: `/record-values/${recordValueId}` })
        },

        amendments: {
            list: (recordId: string) =>
                this.data<CxAmendment[]>({ method: "GET", path: `/amendments/${recordId}` }),
            post: (recordId: string, body: { message: string; parentComment?: string }) =>
                this.data<CxAmendment>({ method: "POST", path: `/amendments/${recordId}`, body })
        },

        members: {
            list: (workspaceId: string) =>
                this.data<CxMember[]>({ method: "GET", path: `/workspace-members/${workspaceId}` })
        },

        activity: {
            list: (workspaceId: string, query?: { limit?: number; before?: string; source?: string }) =>
                this.data<unknown>({ method: "GET", path: `/activity/${workspaceId}`, query })
        }
    };

    /**
     * A small key-value store scoped to THIS mount of the view.
     *
     * For view state — a chosen grouping, a collapsed panel — not for customer
     * data. It is served by the host, so what it costs and how long it survives
     * is the host decision, and an app must tolerate a miss.
     */
    readonly storage = {
        get: <T = unknown>(key: string) => this.call<T | null>("storage.get", { key }),
        set: (key: string, value: unknown) => this.call<void>("storage.set", { key, value }),
        delete: (key: string) => this.call<void>("storage.delete", { key }),
        keys: () => this.call<string[]>("storage.keys", {})
    };

    /**
     * Keep the iframe as tall as the content.
     *
     * Opt-in rather than automatic: a view that draws its own scroll area wants
     * a fixed height, and resizing it on every paint would fight that.
     */
    autoResize(element: HTMLElement = document.body): () => void {
        if (typeof ResizeObserver === "undefined") return () => {};

        this.resizeObserver?.disconnect();

        let last = -1;

        this.resizeObserver = new ResizeObserver(() => {
            const height = Math.ceil(element.getBoundingClientRect().height);

            // Only on a real change: an unconditional post per paint is a
            // message per frame, and the host reflows on every one of them.
            if (height === last || height === 0) return;

            last = height;
            void this.execute("resize", { height }).catch(() => {
                // A host that does not implement resize is not an error worth
                // surfacing to the app on every content change.
            });
        });

        this.resizeObserver.observe(element);

        return () => this.resizeObserver?.disconnect();
    }

    /** Drop every listener and reject anything still in flight. */
    destroy(): void {
        this.destroyed = true;

        if (this.onMessage) window.removeEventListener("message", this.onMessage);

        this.resizeObserver?.disconnect();

        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(
                new ConexusError(protocolError("not_connected", "The SDK was destroyed."))
            );
            this.pending.delete(id);
        }

        this.listeners.clear();
        this.link = null;
    }

    /* ---------------------------------------------------------------------- */
    /* Internals                                                              */
    /* ---------------------------------------------------------------------- */

    private async data<T>(input: ApiRequest): Promise<T> {
        const response = await this.request<T>(input);
        return response.data;
    }

    private async call<T>(method: RpcMethod, params: unknown): Promise<T> {
        if (this.destroyed) {
            throw new ConexusError(
                protocolError("not_connected", "The SDK was destroyed.")
            );
        }

        // Every call implies a connection. Making the caller remember to
        // connect() first is a footgun that only fires on a slow host.
        if (!this.link) await this.connect();

        const id = newId("req");
        const timeout = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new ConexusError(
                        protocolError("timeout", `${method} timed out after ${timeout}ms.`)
                    )
                );
            }, timeout);

            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
                timer
            });

            this.post({
                cx: MESSAGE_NAMESPACE,
                v: PROTOCOL_VERSION,
                kind: "request",
                id,
                method,
                params
            });
        });
    }

    private post(message: unknown): void {
        // No origin, no send. Falling back to "*" here would broadcast the
        // customer data in this view to whatever page happened to frame it,
        // which is the one failure mode this whole design exists to prevent.
        if (!this.hostOrigin) return;

        // Always the pinned origin, never "*" — see ConexusOptions.hostOrigin.
        window.parent.postMessage(message, this.hostOrigin);
    }

    private attach(): void {
        if (this.onMessage) return;

        this.onMessage = (event: MessageEvent) => {
            // Three checks before this message is allowed to mean anything:
            // it came from the host origin, from the frame that embeds us, and
            // it is a protocol envelope we can speak.
            if (event.origin !== this.hostOrigin) return;
            if (event.source !== window.parent) return;
            if (!isEnvelope(event.data)) return;

            if (!isSpeakable(event.data)) {
                this.failHandshake(
                    protocolError(
                        "protocol_mismatch",
                        `The host speaks protocol v${event.data.v}; this SDK speaks v${PROTOCOL_VERSION}. Upgrade @conexus-x/sdk.`
                    )
                );
                return;
            }

            const message = event.data as { kind: string } & Record<string, unknown>;

            switch (message.kind) {
                case "welcome":
                    this.settleHandshake(message);
                    return;

                case "response":
                    this.settleResponse(message);
                    return;

                case "event":
                    this.dispatch(message);
                    return;

                default:
                    return;
            }
        };

        window.addEventListener("message", this.onMessage);
    }

    private settleHandshake(message: Record<string, unknown>): void {
        const pending = this.pending.get("handshake");

        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete("handshake");

        const granted = Array.isArray(message.grantedScopes)
            ? message.grantedScopes.filter(isScope)
            : [];

        const connection: Connection = {
            context: message.context as ViewContext,
            settings: (message.settings as Record<string, unknown>) ?? {},
            grantedScopes: granted,
            hostVersion: String(message.hostVersion ?? "unknown")
        };

        this.link = connection;
        pending.resolve(connection);
    }

    private failHandshake(error: ProtocolError): void {
        const pending = this.pending.get("handshake");

        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete("handshake");
        pending.reject(new ConexusError(error));
    }

    private settleResponse(message: Record<string, unknown>): void {
        const id = String(message.id ?? "");
        const pending = this.pending.get(id);

        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete(id);

        if (message.ok === true) {
            pending.resolve(message.result);
            return;
        }

        const error = (message.error as ProtocolError | undefined) ??
            protocolError("host_error", "The host returned an error with no detail.");

        pending.reject(new ConexusError(error));
    }

    private dispatch(message: Record<string, unknown>): void {
        const topic = message.topic as EventTopic;
        const payload = message.payload;

        // The cached context has to move with the push, or `cx.context` and the
        // value handed to the listener disagree for the rest of the session.
        if (topic === "context" && this.link) {
            this.link.context = payload as ViewContext;
        }

        if (topic === "settings" && this.link) {
            this.link.settings = (payload as Record<string, unknown>) ?? {};
        }

        const handlers = this.listeners.get(topic);

        if (!handlers) return;

        for (const handler of handlers) {
            try {
                (handler as (value: unknown) => void)(payload);
            } catch (error) {
                // One app listener throwing must not stop the others from
                // hearing the same event, and must never break the channel.
                console.error("[conexus] listener threw:", error);
            }
        }
    }
}

/**
 * The entry point.
 *
 * A factory rather than a singleton: a view that mounts two independent panels
 * should be able to hold two clients, and a test should be able to build one
 * per case without tearing down module state.
 */
export default function conexus(options?: ConexusOptions): ConexusClient {
    return new ConexusClient(options);
}
