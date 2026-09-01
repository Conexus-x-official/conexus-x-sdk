/**
 * REACT BINDINGS for the host half — what the Conexus X app itself uses to
 * mount a custom view.
 *
 *     const { iframeProps, connected, forwardChange } = useViewHost({ ... });
 *     return <iframe {...iframeProps} className="h-full w-full border-0" />;
 *
 * A HOOK RATHER THAN A <ConexusView /> COMPONENT, deliberately: the board owns
 * how the frame is sized, bordered, suspended and laid out, and a component
 * would have to grow a prop for each of those until it was a worse `<iframe>`.
 * The hook returns props to spread and gets out of the way.
 *
 * No JSX in this file, so the package needs no JSX runtime configuration and
 * stays consumable from a plain .ts file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    VIEW_SANDBOX,
    buildViewUrl,
    createViewHost,
    memoryStorage,
    type CommandHandlers,
    type HostStorage,
    type HostTransport,
    type ViewHost
} from "./host.js";

import type { ProtocolError, Scope } from "./protocol.js";
import type { ChangeEvent, ViewContext } from "./types.js";

export interface UseViewHostOptions {
    /** The manifest entry URL. Its origin is what the bridge pins. */
    entry: string;
    appId: string;
    viewId: string;
    /** What this installation was actually approved for. */
    grantedScopes: Scope[];

    /**
     * The live context. Pass a new object whenever the board moves — the hook
     * diffs it and pushes only on a real change, so re-rendering the parent for
     * an unrelated reason costs nothing.
     */
    context: ViewContext;
    settings?: Record<string, unknown>;

    transport: HostTransport;
    storage?: HostStorage;
    commands?: CommandHandlers;

    onError?: (error: ProtocolError, detail?: unknown) => void;
    /** Accessible name for the frame. Defaults to the view id. */
    title?: string;
}

export interface UseViewHostResult {
    /** Spread onto your own <iframe>. */
    iframeProps: {
        ref: (node: HTMLIFrameElement | null) => void;
        src: string;
        sandbox: string;
        title: string;
    };
    /** True once the guest has completed the handshake. */
    connected: boolean;
    /** The bridge, for anything the hook does not wrap. Null before mount. */
    host: ViewHost | null;
    /** Forward one crm:change envelope. Filtered to this board by the bridge. */
    forwardChange: (event: ChangeEvent) => void;
}

export const useViewHost = (options: UseViewHostOptions): UseViewHostResult => {
    const {
        entry,
        appId,
        viewId,
        grantedScopes,
        context,
        settings,
        transport,
        storage,
        commands,
        onError,
        title
    } = options;

    const [connected, setConnected] = useState(false);
    const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);

    const hostRef = useRef<ViewHost | null>(null);

    // Read through refs inside the bridge callbacks so a re-render never has to
    // tear the channel down to deliver fresh values.
    const contextRef = useRef(context);
    const settingsRef = useRef(settings ?? {});
    const transportRef = useRef(transport);
    const commandsRef = useRef(commands);
    const onErrorRef = useRef(onError);

    contextRef.current = context;
    settingsRef.current = settings ?? {};
    transportRef.current = transport;
    commandsRef.current = commands;
    onErrorRef.current = onError;

    const scopeKey = grantedScopes.join(",");

    /**
     * The frame URL.
     *
     * Memoised on the values that actually identify this mount, because a new
     * `src` RELOADS the iframe — regenerating it on every render would restart
     * the third-party app continuously. The instance id comes from the context
     * rather than being generated here for the same reason.
     */
    const src = useMemo(
        () =>
            buildViewUrl({
                entry,
                appId,
                viewId,
                instanceId: context.instanceId,
                scopes: scopeKey.length > 0 ? (scopeKey.split(",") as Scope[]) : []
            }),
        [entry, appId, viewId, context.instanceId, scopeKey]
    );

    const appOrigin = useMemo(() => {
        try {
            return new URL(entry).origin;
        } catch {
            return "";
        }
    }, [entry]);

    /**
     * Build the bridge once the frame element exists.
     *
     * A plain effect is enough despite the iframe starting to load during the
     * same commit: the guest cannot say hello until its document has been
     * fetched and its script has run, which is at least a task later, while
     * this effect runs synchronously after the DOM is committed.
     */
    useEffect(() => {
        if (!iframe || !appOrigin) return;

        setConnected(false);

        const host = createViewHost({
            iframe,
            appOrigin,
            grantedScopes: scopeKey.length > 0 ? (scopeKey.split(",") as Scope[]) : [],
            getContext: () => contextRef.current,
            getSettings: () => settingsRef.current,
            transport: (input) => transportRef.current(input),
            storage: storage ?? memoryStorage(),
            commands: new Proxy({} as CommandHandlers, {
                // Resolved per call so a command added after mount works without
                // rebuilding the channel, and an unimplemented one still answers
                // command_unsupported rather than silently succeeding.
                get: (_target, name: string) =>
                    (commandsRef.current as Record<string, unknown> | undefined)?.[name],
                has: (_target, name: string) =>
                    Boolean((commandsRef.current as Record<string, unknown> | undefined)?.[name])
            }),
            onError: (error, detail) => onErrorRef.current?.(error, detail),
            onConnect: () => setConnected(true)
        });

        hostRef.current = host;

        return () => {
            host.destroy();
            hostRef.current = null;
            setConnected(false);
        };
    }, [iframe, appOrigin, scopeKey, src, storage]);

    /**
     * Push context on a REAL change.
     *
     * Compared by value: the parent board re-renders constantly and almost none
     * of those renders move anything this view can see. A push per render would
     * be a message per keystroke somewhere else on the page.
     */
    const contextSignature = JSON.stringify(context);

    useEffect(() => {
        hostRef.current?.pushContext();
    }, [contextSignature]);

    const settingsSignature = JSON.stringify(settings ?? {});

    useEffect(() => {
        hostRef.current?.push("settings", settingsRef.current);
    }, [settingsSignature]);

    const forwardChange = useCallback((event: ChangeEvent) => {
        hostRef.current?.forwardChange(event);
    }, []);

    return {
        iframeProps: {
            ref: setIframe,
            src,
            sandbox: VIEW_SANDBOX,
            title: title ?? viewId
        },
        connected,
        host: hostRef.current,
        forwardChange
    };
};

export {
    VIEW_SANDBOX,
    buildViewUrl,
    createViewHost,
    fetchTransport,
    memoryStorage
} from "./host.js";

export type {
    CommandHandlers,
    HostStorage,
    HostTransport,
    ViewHost,
    ViewHostOptions
} from "./host.js";
