/**
 * THE ALLOWLIST: every CRM endpoint a custom view may reach, and the scope it
 * costs.
 *
 * This is the security boundary of the whole SDK. The host matches each
 * proxied call against this table and refuses anything that is not in it, so a
 * view cannot reach an endpoint merely because the signed-in user could.
 *
 * WHAT IS DELIBERATELY MISSING, and why — this list is the interesting half:
 *
 *   /api-key/*        Returns the user PERMANENT API key. A view that could read
 *                     it would walk away with credentials that outlive the
 *                     session, the board, and the app being uninstalled.
 *   /auth/*           Sessions, OTPs, preferences, the Google handshake. None of
 *                     it is a view concern and /auth/me leaks the email of
 *                     someone who never installed the app.
 *   /agent/*          Spends the workspace AI credit balance. An app must not be
 *                     able to bill a customer through their own session.
 *   /uploads/*        Multipart, size limits, and a Cloudinary bill attached to
 *                     the workspace. Wanted later, gated on its own scope.
 *   /automations/*    Rules that fire on other people work. Reading them exposes
 *                     the internal shape of a board; writing them is remote code
 *                     execution with extra steps.
 *   /conversations/*  Private messages between colleagues. Never.
 *   /messages/*
 *   /module-access/*  Permission grants. An app that can widen access is an app
 *                     that can grant itself more than it was approved for.
 *   /workspaces       Renaming or deleting the workspace an app is a guest in.
 *
 * Adding a row here is a permission decision, not a convenience one. It belongs
 * in the same review as the manifest scopes it serves.
 */

import type { HttpMethod } from "./types.js";
import type { Scope } from "./protocol.js";

export interface RouteRule {
    method: HttpMethod;
    /** API-relative, with `:param` placeholders. No leading /api — the host owns that. */
    pattern: string;
    scope: Scope;
    /** One line, shown in the review UI when an app asks for the scope. */
    summary: string;
}

/**
 * ORDER MATTERS: the first match wins, so a literal segment must be declared
 * before a parameter that would also swallow it. `/record-values/references/:id`
 * sits above `/record-values/:recordId` for exactly that reason.
 */
export const ROUTES: readonly RouteRule[] = [
    /**
     * Boards.
     *
     * A view mounted at WORKSPACE level has no board behind it — the host hands
     * it a workspaceId and nothing else — so `modules:read` is what makes a
     * workspace-level view useful at all: without it an app cannot show a
     * person anything until they open a board themselves.
     *
     * `modules:write` covers create, rename/recolour and delete under one
     * scope, the same convention as `collections:write` below — a board is a
     * structural object, not a value, and the three operations are reviewed
     * together or not at all. Held to a HIGHER bar than the resource scopes: a
     * deleted board takes every collection, record and cell inside it with it,
     * so an admin approving this is approving the app to remove a whole area of
     * the workspace, not edit a value in one.
     */
    { method: "GET", pattern: "/modules/:workspaceId", scope: "modules:read", summary: "List the boards in a workspace" },
    { method: "POST", pattern: "/modules/:workspaceId", scope: "modules:write", summary: "Create a board" },
    { method: "PUT", pattern: "/modules/:moduleId", scope: "modules:write", summary: "Rename, recolour or change the visibility of a board" },
    { method: "DELETE", pattern: "/modules/:moduleId", scope: "modules:write", summary: "Delete a board and everything inside it" },

    // Collections — the groups a board is split into.
    { method: "GET", pattern: "/collections/:moduleId", scope: "collections:read", summary: "List the collections on a board" },
    { method: "POST", pattern: "/collections/:moduleId", scope: "collections:write", summary: "Create a collection" },
    { method: "PUT", pattern: "/collections/:collectionId", scope: "collections:write", summary: "Rename or recolour a collection" },
    { method: "DELETE", pattern: "/collections/:collectionId", scope: "collections:write", summary: "Delete a collection and its records" },

    // Columns — the shape of the grid.
    { method: "GET", pattern: "/columns/:moduleId", scope: "columns:read", summary: "List the columns on a board" },
    { method: "POST", pattern: "/columns/:moduleId", scope: "columns:write", summary: "Add a column" },
    { method: "PUT", pattern: "/columns/:columnId", scope: "columns:write", summary: "Change a column" },
    { method: "DELETE", pattern: "/columns/:columnId", scope: "columns:write", summary: "Delete a column and every value in it" },

    // Records — rows, and the sub-rows that hang off them.
    { method: "GET", pattern: "/records/:recordId/sub-records", scope: "records:read", summary: "List the sub-records of a record" },
    { method: "POST", pattern: "/records/:recordId/sub-records", scope: "records:write", summary: "Create a sub-record" },
    { method: "GET", pattern: "/records/:collectionId", scope: "records:read", summary: "List the records in a collection" },
    { method: "POST", pattern: "/records/:collectionId", scope: "records:write", summary: "Create a record" },
    { method: "PUT", pattern: "/records/:recordId", scope: "records:write", summary: "Rename, move, complete or archive a record" },
    { method: "DELETE", pattern: "/records/:recordId", scope: "records:write", summary: "Delete a record" },

    // Cell values.
    { method: "GET", pattern: "/record-values/references/:moduleId", scope: "values:read", summary: "Read mirrored values across linked boards" },
    { method: "GET", pattern: "/record-values/:recordId", scope: "values:read", summary: "Read every cell on a record" },
    { method: "POST", pattern: "/record-values", scope: "values:write", summary: "Write a cell" },
    { method: "PUT", pattern: "/record-values/:recordValueId", scope: "values:write", summary: "Change a cell" },
    { method: "DELETE", pattern: "/record-values/:recordValueId", scope: "values:write", summary: "Clear a cell" },

    // Amendments — what the product calls an update on a record.
    { method: "GET", pattern: "/amendments/:recordId", scope: "amendments:read", summary: "Read the amendments on a record" },
    { method: "POST", pattern: "/amendments/:recordId", scope: "amendments:write", summary: "Post an amendment" },
    { method: "PUT", pattern: "/amendments/:amendmentId", scope: "amendments:write", summary: "Edit an amendment the user wrote" },
    { method: "DELETE", pattern: "/amendments/:amendmentId", scope: "amendments:write", summary: "Delete an amendment" },

    // People and history, read-only on purpose.
    { method: "GET", pattern: "/workspace-members/:workspaceId", scope: "members:read", summary: "List workspace members" },
    { method: "GET", pattern: "/activity/:workspaceId", scope: "activity:read", summary: "Read the activity feed" }
] as const;

/**
 * A path segment standing in for an id.
 *
 * Slightly wider than the 24-hex Mongo ids in use today, so a future id format
 * does not silently break every installed app, but narrow enough that `..`, an
 * empty segment, a query string or an encoded slash can never match.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface RouteMatch {
    rule: RouteRule;
    params: Record<string, string>;
}

/**
 * Resolve a concrete request against the table.
 *
 * Returns null for anything not on the list — the caller turns that into a
 * `route_denied`, which is deliberately the same answer an unknown path and a
 * forbidden one both get. Telling an app which internal endpoints exist is free
 * reconnaissance for the one app that turns out to be hostile.
 */
export const matchRoute = (
    method: string,
    path: string
): RouteMatch | null => {
    const upper = method.toUpperCase();

    // Absolute URLs, protocol-relative URLs and query strings are all rejected
    // before matching: the guest names an endpoint, it does not name a server.
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
        return null;
    }

    const segments = path.split("/").filter((part) => part.length > 0);

    if (segments.length === 0) return null;

    for (const rule of ROUTES) {
        if (rule.method !== upper) continue;

        const patternSegments = rule.pattern.split("/").filter((part) => part.length > 0);

        if (patternSegments.length !== segments.length) continue;

        const params: Record<string, string> = {};
        let matched = true;

        for (let i = 0; i < patternSegments.length; i += 1) {
            const expected = patternSegments[i] as string;
            const actual = segments[i] as string;

            if (expected.startsWith(":")) {
                if (!SAFE_SEGMENT.test(actual)) {
                    matched = false;
                    break;
                }

                params[expected.slice(1)] = actual;
                continue;
            }

            if (expected !== actual) {
                matched = false;
                break;
            }
        }

        if (matched) return { rule, params };
    }

    return null;
};

/** Every scope a manifest would need to use the listed routes. Used by the review UI. */
export const scopesForRoutes = (rules: readonly RouteRule[]): Scope[] =>
    [...new Set(rules.map((rule) => rule.scope))];

/** What one scope actually permits, in words a reviewer can read. */
export const explainScope = (scope: Scope): string[] =>
    ROUTES.filter((rule) => rule.scope === scope).map((rule) => rule.summary);
