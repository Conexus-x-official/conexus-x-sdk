/**
 * The shapes a custom view sees.
 *
 * These MIRROR app/store/types.ts in the main repo and must be changed together
 * with it — the same rule the repo already applies to lib/presence.ts and
 * models/User.ts. They are duplicated rather than imported because a third
 * party installs this package from a registry and has no access to the app
 * source; the alternative is shipping the whole frontend as a dependency of
 * every app anyone writes.
 *
 * Only the fields a VIEW can legitimately use are mirrored. Anything internal
 * to the board (cache tags, optimistic-update bookkeeping) is deliberately
 * absent: a field that appears here is a field we owe third parties stability
 * on, so the surface is kept to what is actually needed.
 */

import type { Scope } from "./protocol.js";

/* -------------------------------------------------------------------------- */
/* Entities                                                                   */
/* -------------------------------------------------------------------------- */

export interface CxUser {
    id: string;
    firstName: string;
    lastName?: string;
    email?: string;
    avatar?: string;
}

export interface CxCollection {
    _id: string;
    name: string;
    color?: string;
    position: number;
    isCollapsed?: boolean;
}

export interface CxStatusOption {
    label: string;
    color: string;
}

export interface CxColumn {
    _id: string;
    name: string;
    label?: string;
    type?: string;
    color?: string;
    width?: number;
    position: number;
    isRequired?: boolean;
    isHidden?: boolean;
    options?: string[];
    statusOptions?: CxStatusOption[];
    /** Which grid the column belongs to — the board or the sub-record table. */
    scope?: "record" | "subrecord";
}

export interface CxRecord {
    _id: string;
    name: string;
    position: number;
    collectionName: string;
    /** Set on a sub-record, null on a board row — the only thing separating them. */
    parentRecord?: string | null;
    subRecordCount?: number;
    amendmentCount?: number;
    module?: string;
    workspace?: string;
    isCompleted?: boolean;
    isArchived?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

export interface CxRecordValue {
    _id: string;
    record: string;
    column: CxColumn | string;
    value: unknown;
    createdAt?: string;
    updatedAt?: string;
}

export interface CxAmendment {
    _id: string;
    record: string;
    user: CxUser | null;
    message: string;
    parentComment?: string | null;
    edited?: boolean;
    isDeleted?: boolean;
    createdAt: string;
    updatedAt?: string;
}

export interface CxMember {
    _id: string;
    role: "owner" | "admin" | "member" | "guest";
    status: "active" | "pending" | "inactive";
    user: CxUser;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where the view is mounted and who is looking at it.
 *
 * This is pushed again on every change rather than being read once at startup:
 * a person switching collection or selecting rows does not remount the iframe,
 * and a view that only reads context at boot silently shows the wrong board.
 */
export interface ViewContext {
    /** This mount of this view. Storage and logs are keyed by it. */
    instanceId: string;
    /** Which view of the app is mounted — an app may declare several. */
    viewId: string;
    appId: string;

    workspaceId: string;
    /** Present for every surface except a workspace-level view. */
    moduleId?: string;
    /** The collection currently in view on the board, when there is one. */
    collectionId?: string;
    /** Set when the view is mounted against a single record. */
    recordId?: string;

    /** Rows the user has selected on the board. Empty, never undefined. */
    selectedRecordIds: string[];

    user: CxUser;
    /** The user role in THIS workspace — a view should hide what it cannot do. */
    role: "owner" | "admin" | "member" | "guest";

    theme: "light" | "dark";
    locale: string;

    /**
     * Which side of the review pipeline this mount is on.
     *
     * "test" is a sandbox board owned by the developer; "live" is a real
     * customer workspace after admin approval. Exposed to the app deliberately:
     * an app that seeds demo data or points at a staging API of its own needs to
     * know which one it is in, and guessing from the hostname is exactly the
     * kind of thing that ships to production wrong.
     */
    environment: "test" | "live";
}

/* -------------------------------------------------------------------------- */
/* API calls                                                                  */
/* -------------------------------------------------------------------------- */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One call against the CRM API, as the guest asks for it.
 *
 * `path` is API-relative ("/records/<id>"), never absolute: the guest does not
 * choose which server it talks to. The host resolves it against its own base
 * URL and rejects anything that is not a known route — see routes.ts.
 */
export interface ApiRequest {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
}

export interface ApiResponse<T = unknown> {
    status: number;
    data: T;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Things only the host can do, because they touch chrome the iframe cannot
 * reach: toasts, the record panel, navigation, its own height.
 *
 * A host may implement any subset. An unimplemented command answers
 * `command_unsupported` rather than silently succeeding, so an app can feature
 * detect instead of assuming.
 */
export interface CommandMap {
    /** Toast in the host chrome. */
    notice: {
        message: string;
        type?: "success" | "error" | "info";
        timeoutMs?: number;
    };
    /** Open the record panel the board already has, on the given row. */
    openRecord: { recordId: string };
    /** Native-feeling confirm dialog. Resolves to the answer. */
    confirm: { message: string; confirmLabel?: string; cancelLabel?: string };
    /** Ask the host to resize the iframe. Omit height to fit content. */
    resize: { height?: number };
    /** Move the user somewhere in the app. Paths only — never a foreign origin. */
    navigate: { path: string };
    /** Copy to clipboard through the host, which has the user gesture. */
    copyToClipboard: { text: string };
}

export type CommandName = keyof CommandMap;

export interface CommandResults {
    notice: void;
    openRecord: void;
    confirm: boolean;
    resize: void;
    navigate: void;
    copyToClipboard: void;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/** The CRM realtime envelope, forwarded down already filtered to this module. */
export interface ChangeEvent {
    entity: string;
    action: "created" | "updated" | "deleted" | "moved";
    id?: string;
    workspaceId?: string;
    moduleId?: string;
    collectionId?: string;
    fromCollectionId?: string;
    recordId?: string;
    parentRecordId?: string;
    columnId?: string;
    scope?: string;
    data?: unknown;
    actorId?: string;
    at: string;
}

/** Payload delivered for each topic, so listen() can be typed per topic. */
export interface EventMap {
    context: ViewContext;
    settings: Record<string, unknown>;
    selection: { recordIds: string[] };
    change: ChangeEvent;
    theme: { theme: "light" | "dark" };
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

export interface Connection {
    context: ViewContext;
    settings: Record<string, unknown>;
    grantedScopes: Scope[];
    hostVersion: string;
}
