/**
 * REACT BINDINGS for the guest half.
 *
 *     import { useConexus, useViewContext, useRecords } from "@conexus-x/sdk/react";
 *
 * WHY THE CORE IS NOT REACT, and this file is separate: an app author may
 * reasonably write a view in React, Svelte, Vue or none of the above, and the
 * HOST is a React app that must not ship a second copy of React inside an SDK.
 * So the client in guest.ts stays framework-free and zero-dependency, and React
 * is a peer dependency of this entry point only. Nobody pays for it who is not
 * using it, and nobody is locked out who is not using React.
 *
 * What React buys, and why it is worth a whole entry point: a view is a
 * subscription problem. The board moves under it — the person switches
 * collection, a colleague edits a cell, the theme flips — and every one of
 * those is a re-render with a cleanup. Hooks are the right shape for that;
 * hand-rolled listen/unsubscribe in useEffect is where the leaks live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import conexus, { ConexusClient, type ConexusOptions } from "./guest.js";
import { ConexusError, type EventTopic, type Scope } from "./protocol.js";

import type {
    Connection,
    CxCollection,
    CxColumn,
    CxRecord,
    EventMap,
    ViewContext
} from "./types.js";

/**
 * One client per page, memoised at module scope.
 *
 * A view iframe has exactly one parent host, so a provider would be ceremony
 * around a value that can never legitimately differ between two subtrees. Pass
 * an explicit client to any hook below if you genuinely need a second one.
 */
let singleton: ConexusClient | null = null;

export const getConexusClient = (options?: ConexusOptions): ConexusClient => {
    /**
     * NEVER cache on the server.
     *
     * Module scope in a server render is shared by every request the process
     * handles, so a cached client would be one object shared across users. It
     * holds nothing sensitive before `connect()` — which cannot run without a
     * window — but a per-request throwaway removes the question entirely rather
     * than relying on that staying true.
     */
    if (typeof window === "undefined") return conexus(options);

    if (!singleton) singleton = conexus(options);
    return singleton;
};

/** Test seam — resets the module singleton between cases. */
export const resetConexusClient = (): void => {
    singleton?.destroy();
    singleton = null;
};

export const useConexus = (options?: ConexusOptions): ConexusClient =>
    useMemo(() => getConexusClient(options), [options]);

/**
 * Resolve the client every hook below works against.
 *
 * `client ?? useConexus()` reads better and is WRONG — it calls a hook
 * conditionally, so a component that passes a client on one render and not the
 * next corrupts the hook order. This always runs exactly one hook and only
 * touches the singleton when no client was supplied, which also means passing
 * your own client never constructs one you did not ask for.
 */
const useClient = (client?: ConexusClient): ConexusClient => {
    const fallback = useMemo(
        () => (client ? null : getConexusClient()),
        [client]
    );

    return client ?? (fallback as ConexusClient);
};

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

export type ConnectionStatus = "connecting" | "ready" | "error";

export interface ConnectionState {
    status: ConnectionStatus;
    connection: Connection | null;
    error: ConexusError | null;
}

/**
 * Connect once and report where we are.
 *
 * Every other hook awaits this implicitly through the client, so a view that
 * only wants data never has to render a connecting state — but one that wants
 * to show a spinner or a real error message can.
 */
export const useConnection = (client?: ConexusClient): ConnectionState => {
    const cx = useClient(client);

    const [state, setState] = useState<ConnectionState>(() => ({
        // Seeded from the client rather than starting at "connecting"
        // unconditionally: a second component mounting against an already-open
        // channel must not flash a loading state that is not true.
        status: cx.isConnected ? "ready" : "connecting",
        connection: cx.connection,
        error: null
    }));

    useEffect(() => {
        let alive = true;

        cx.connect()
            .then((connection) => {
                if (alive) setState({ status: "ready", connection, error: null });
            })
            .catch((error: unknown) => {
                if (!alive) return;

                setState({
                    status: "error",
                    connection: null,
                    error:
                        error instanceof ConexusError
                            ? error
                            : new ConexusError({
                                  code: "host_error",
                                  message: error instanceof Error ? error.message : String(error)
                              })
                });
            });

        return () => {
            alive = false;
        };
    }, [cx]);

    return state;
};

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe to a host push for the life of the component.
 *
 * The handler is held in a ref so a caller passing an inline arrow does not
 * resubscribe on every render — the single most common way a listener-based
 * hook quietly turns into a leak.
 */
export const useConexusEvent = <T extends EventTopic>(
    topic: T,
    handler: (payload: EventMap[T]) => void,
    client?: ConexusClient
): void => {
    const cx = useClient(client);
    const ref = useRef(handler);

    ref.current = handler;

    useEffect(
        () => cx.listen(topic, (payload) => ref.current(payload)),
        [cx, topic]
    );
};

/** The live board context — re-renders when the person moves around it. */
export const useViewContext = (client?: ConexusClient): ViewContext | null => {
    const cx = useClient(client);
    const { connection } = useConnection(cx);
    const [pushed, setPushed] = useState<ViewContext | null>(null);

    useConexusEvent("context", setPushed, cx);

    return pushed ?? connection?.context ?? null;
};

/**
 * The settings the person configured for this view instance.
 *
 * Constrained to `object` rather than `Record<string, unknown>`: a plain
 * `interface ViewSettings { title?: string }` has no implicit index signature,
 * so the tighter constraint rejected the most natural way for an app author to
 * describe their own settings. Caught by typechecking the starter against the
 * built types rather than by reading.
 */
export const useSettings = <T extends object = Record<string, unknown>>(
    client?: ConexusClient
): T => {
    const cx = useClient(client);
    const { connection } = useConnection(cx);
    const [pushed, setPushed] = useState<Record<string, unknown> | null>(null);

    useConexusEvent("settings", setPushed, cx);

    return (pushed ?? connection?.settings ?? {}) as T;
};

/** Rows the person has selected on the board. */
export const useSelection = (client?: ConexusClient): string[] => {
    const context = useViewContext(client);
    const [selection, setSelection] = useState<string[]>([]);

    useConexusEvent("selection", (payload) => setSelection(payload.recordIds), client);

    return selection.length > 0 ? selection : context?.selectedRecordIds ?? [];
};

/** Was this scope granted? Renders false until connected, never throws. */
export const useScope = (scope: Scope, client?: ConexusClient): boolean => {
    const cx = useClient(client);
    const { connection } = useConnection(cx);

    return connection?.grantedScopes.includes(scope) ?? false;
};

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

export interface QueryState<T> {
    data: T | null;
    loading: boolean;
    error: ConexusError | null;
    refresh: () => void;
}

/**
 * The general shape: fetch, then refetch when the board says something changed.
 *
 * `shouldRefetch` is what keeps this cheap — a view listing records does not
 * want to re-query because somebody renamed a column, and the board is a busy
 * channel. Callers get the raw change envelope and decide.
 */
export const useConexusQuery = <T>(
    fetcher: (cx: ConexusClient) => Promise<T>,
    options: {
        /** Re-run when these change. Same contract as a dependency array. */
        deps?: unknown[];
        /** Skip entirely — for a query that needs an id it does not have yet. */
        enabled?: boolean;
        shouldRefetch?: (event: EventMap["change"]) => boolean;
        client?: ConexusClient;
    } = {}
): QueryState<T> => {
    const cx = useClient(options.client);
    const enabled = options.enabled ?? true;

    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<ConexusError | null>(null);
    const [nonce, setNonce] = useState(0);

    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    const refresh = useCallback(() => setNonce((value) => value + 1), []);

    useEffect(() => {
        if (!enabled) {
            setLoading(false);
            return;
        }

        let alive = true;

        setLoading(true);

        fetcherRef
            .current(cx)
            .then((result) => {
                if (!alive) return;

                setData(result);
                setError(null);
            })
            .catch((caught: unknown) => {
                if (!alive) return;

                setError(
                    caught instanceof ConexusError
                        ? caught
                        : new ConexusError({
                              code: "host_error",
                              message: caught instanceof Error ? caught.message : String(caught)
                          })
                );
            })
            .finally(() => {
                if (alive) setLoading(false);
            });

        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cx, enabled, nonce, ...(options.deps ?? [])]);

    useConexusEvent(
        "change",
        (event) => {
            if (!enabled) return;
            if (options.shouldRefetch && !options.shouldRefetch(event)) return;

            refresh();
        },
        cx
    );

    return { data, loading, error, refresh };
};

/**
 * The records in a collection, kept live.
 *
 * Defaults to refetching on any record or cell-value change, which is what a
 * list on screen actually depends on — a column rename or someone joining the
 * workspace does not move these rows.
 */
export const useRecords = (
    collectionId: string | undefined,
    client?: ConexusClient
): QueryState<CxRecord[]> =>
    useConexusQuery<CxRecord[]>(
        (cx) => cx.api.records.list(collectionId as string),
        {
            deps: [collectionId],
            enabled: Boolean(collectionId),
            shouldRefetch: (event) =>
                event.entity === "record" || event.entity === "recordValue",
            ...(client ? { client } : {})
        }
    );

/** The collections on the mounted board. */
export const useCollections = (
    moduleId: string | undefined,
    client?: ConexusClient
): QueryState<CxCollection[]> =>
    useConexusQuery<CxCollection[]>(
        (cx) => cx.api.collections.list(moduleId as string),
        {
            deps: [moduleId],
            enabled: Boolean(moduleId),
            shouldRefetch: (event) => event.entity === "collection",
            ...(client ? { client } : {})
        }
    );

/** The columns on the mounted board. */
export const useColumns = (
    moduleId: string | undefined,
    client?: ConexusClient
): QueryState<CxColumn[]> =>
    useConexusQuery<CxColumn[]>(
        (cx) => cx.api.columns.list(moduleId as string),
        {
            deps: [moduleId],
            enabled: Boolean(moduleId),
            shouldRefetch: (event) => event.entity === "column",
            ...(client ? { client } : {})
        }
    );

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keep the iframe as tall as the content.
 *
 * Opt-in, like the underlying call: a view that draws its own scroll area wants
 * a fixed height and would fight this.
 */
export const useAutoResize = (
    ref?: { current: HTMLElement | null },
    client?: ConexusClient
): void => {
    const cx = useClient(client);

    useEffect(() => {
        const element = ref?.current ?? (typeof document === "undefined" ? null : document.body);

        if (!element) return;

        return cx.autoResize(element);
    }, [cx, ref]);
};

/**
 * The host commands, bound and stable.
 *
 * Returned as one object so a component can destructure the two it uses without
 * every call site repeating the client argument.
 */
export const useCommands = (client?: ConexusClient) => {
    const cx = useClient(client);

    return useMemo(
        () => ({
            notice: (message: string, type: "success" | "error" | "info" = "info") =>
                cx.execute("notice", { message, type }),
            openRecord: (recordId: string) => cx.execute("openRecord", { recordId }),
            confirm: (message: string) => cx.execute("confirm", { message }),
            navigate: (path: string) => cx.execute("navigate", { path }),
            copyToClipboard: (text: string) => cx.execute("copyToClipboard", { text })
        }),
        [cx]
    );
};

export type { ConexusOptions } from "./guest.js";
export { ConexusClient } from "./guest.js";
export { ConexusError } from "./protocol.js";

/**
 * Re-exported so a React view needs exactly one import path.
 *
 * Reaching into the root entry for a type while calling hooks from `/react`
 * is the kind of split that has every file in a starter importing from two
 * places for no reason a reader can name.
 */
export type { ErrorCode, EventTopic, Scope } from "./protocol.js";

export type {
    ApiRequest,
    ApiResponse,
    ChangeEvent,
    CommandMap,
    CommandName,
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
    ViewContext
} from "./types.js";
