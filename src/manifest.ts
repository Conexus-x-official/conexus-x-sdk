/**
 * THE MANIFEST — what an app declares about itself.
 *
 * One file, submitted with the build, that says who wrote the app, where it is
 * served from, which surfaces it wants to appear on and what it needs
 * permission to touch. It is the unit the review pipeline works on: the test
 * environment mounts what it describes, the admin dashboard shows a reviewer
 * its scopes in plain words (see explainScope in routes.ts), and approval is a
 * decision about THIS document at THIS version.
 *
 * WHY A VALIDATOR LIVES IN THE SDK rather than only on the server: the author
 * should find out that `entry` must be https while they are still at their
 * desk, not three days later in a review queue. The server will validate again
 * — a check that runs only on the submitter machine is a suggestion, not a
 * rule — but the same code answering both times means the two cannot disagree.
 */

import { SCOPES, isScope, type Scope } from "./protocol.js";
import { explainScope } from "./routes.js";

/** Where in the app a view can be placed. */
export const VIEW_SURFACES = [
    /** A tab on a module module, beside the grid. This is the monday-style custom view. */
    "module",
    /** A panel inside the record view. */
    "record",
    /** A full page at workspace level. */
    "workspace"
] as const;

export type ViewSurface = (typeof VIEW_SURFACES)[number];

/** One field in the settings pane the host renders for an installed view. */
export type SettingField =
    | { key: string; label: string; type: "text"; default?: string; placeholder?: string }
    | { key: string; label: string; type: "number"; default?: number; min?: number; max?: number }
    | { key: string; label: string; type: "boolean"; default?: boolean }
    | { key: string; label: string; type: "select"; options: { label: string; value: string }[]; default?: string }
    /** Lets the person pick a column from the module the view is mounted on. */
    | { key: string; label: string; type: "column"; columnTypes?: string[] };

export interface ViewDefinition {
    /** Stable within the app. Referenced by installs, so renaming it breaks them. */
    id: string;
    name: string;
    surface: ViewSurface;
    /** Icon key from the host catalog, never a URL. */
    icon?: string;
    /** Starting iframe height in px. The view can ask to resize once running. */
    defaultHeight?: number;
    settings?: SettingField[];
}

export interface AppManifest {
    /** Kebab-case, unique across the marketplace, permanent. */
    id: string;
    name: string;
    /** Semver. A new version is a new review. */
    version: string;
    description?: string;
    publisher: {
        name: string;
        email: string;
        website?: string;
    };
    /**
     * Absolute https URL the view is served from. The host pins this origin for
     * postMessage, so it is a security value and not merely a location.
     */
    entry: string;
    views: ViewDefinition[];
    scopes: Scope[];
    /** Shown to the reviewer and to the person installing. Plain sentences. */
    permissionsRationale?: Partial<Record<Scope, string>>;
}

export type ManifestResult =
    | { ok: true; manifest: AppManifest; warnings: string[] }
    | { ok: false; errors: string[]; warnings: string[] };

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParseOptions {
    /**
     * In the test environment an app is still served from the developer laptop,
     * so http://localhost is allowed. It is NEVER allowed for a submission —
     * the whole point of pinning an origin is that customers reach the same
     * code we reviewed.
     */
    allowLocalhostEntry?: boolean;
}

/**
 * Validate a manifest.
 *
 * Collects EVERY problem rather than throwing on the first: an author fixing
 * one error per submission round is the slowest possible way to publish an app,
 * and the reviewer wants to see the whole picture at once too.
 */
export const parseManifest = (
    input: unknown,
    options: ParseOptions = {}
): ManifestResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof input !== "object" || input === null) {
        return { ok: false, errors: ["The manifest must be a JSON object."], warnings };
    }

    const raw = input as Partial<AppManifest> & Record<string, unknown>;

    /* ---- identity ------------------------------------------------------- */

    if (typeof raw.id !== "string" || !KEBAB.test(raw.id)) {
        errors.push('"id" must be kebab-case, e.g. "revenue-timeline".');
    }

    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
        errors.push('"name" is required.');
    } else if (raw.name.length > 60) {
        errors.push('"name" must be 60 characters or fewer.');
    }

    if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
        errors.push('"version" must be semver, e.g. "1.0.0".');
    }

    if (raw.description !== undefined && typeof raw.description !== "string") {
        errors.push('"description" must be a string.');
    }

    if (!raw.description) {
        warnings.push('No "description" — the install dialog will look empty.');
    }

    /* ---- publisher ------------------------------------------------------ */

    const publisher = raw.publisher as AppManifest["publisher"] | undefined;

    if (!publisher || typeof publisher !== "object") {
        errors.push('"publisher" is required, with a name and a contact email.');
    } else {
        if (typeof publisher.name !== "string" || publisher.name.trim().length === 0) {
            errors.push('"publisher.name" is required.');
        }

        if (typeof publisher.email !== "string" || !EMAIL.test(publisher.email)) {
            errors.push('"publisher.email" must be a contactable email address.');
        }
    }

    /* ---- entry ---------------------------------------------------------- */

    if (typeof raw.entry !== "string") {
        errors.push('"entry" is required — the absolute URL your view is served from.');
    } else {
        try {
            const url = new URL(raw.entry);
            const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";

            if (url.protocol !== "https:" && !(options.allowLocalhostEntry && isLocal)) {
                errors.push('"entry" must be an https URL.');
            }

            if (url.hash) {
                errors.push('"entry" must not carry a fragment.');
            }

            if (url.search) {
                warnings.push(
                    '"entry" carries a query string. The host appends its own cx* parameters; keep yours from colliding.'
                );
            }
        } catch {
            errors.push('"entry" is not a valid URL.');
        }
    }

    /* ---- views ---------------------------------------------------------- */

    const views = raw.views;

    if (!Array.isArray(views) || views.length === 0) {
        errors.push('"views" must list at least one view.');
    } else {
        const seen = new Set<string>();

        views.forEach((view, index) => {
            const where = `views[${index}]`;

            if (typeof view?.id !== "string" || !KEBAB.test(view.id)) {
                errors.push(`${where}.id must be kebab-case.`);
            } else if (seen.has(view.id)) {
                errors.push(`${where}.id "${view.id}" is used twice — view ids identify installs.`);
            } else {
                seen.add(view.id);
            }

            if (typeof view?.name !== "string" || view.name.trim().length === 0) {
                errors.push(`${where}.name is required.`);
            }

            if (!(VIEW_SURFACES as readonly string[]).includes(view?.surface)) {
                errors.push(
                    `${where}.surface must be one of: ${VIEW_SURFACES.join(", ")}.`
                );
            }

            if (view?.defaultHeight !== undefined) {
                const height = view.defaultHeight;

                if (typeof height !== "number" || height < 120 || height > 2000) {
                    errors.push(`${where}.defaultHeight must be a number between 120 and 2000.`);
                }
            }

            if (view?.settings !== undefined) {
                if (!Array.isArray(view.settings)) {
                    errors.push(`${where}.settings must be an array.`);
                } else {
                    const keys = new Set<string>();

                    view.settings.forEach((field, fieldIndex) => {
                        const fieldWhere = `${where}.settings[${fieldIndex}]`;

                        if (typeof field?.key !== "string" || field.key.length === 0) {
                            errors.push(`${fieldWhere}.key is required.`);
                        } else if (keys.has(field.key)) {
                            errors.push(`${fieldWhere}.key "${field.key}" is duplicated.`);
                        } else {
                            keys.add(field.key);
                        }

                        if (typeof field?.label !== "string" || field.label.length === 0) {
                            errors.push(`${fieldWhere}.label is required.`);
                        }

                        if (field?.type === "select" && !Array.isArray(field.options)) {
                            errors.push(`${fieldWhere}.options is required for a select field.`);
                        }
                    });
                }
            }
        });
    }

    /* ---- scopes --------------------------------------------------------- */

    const scopes = raw.scopes;

    if (!Array.isArray(scopes)) {
        errors.push('"scopes" must be an array (use [] if the app needs no data access).');
    } else {
        const unknown = scopes.filter((scope) => !isScope(scope));

        if (unknown.length > 0) {
            errors.push(
                `Unknown scopes: ${unknown.join(", ")}. Valid scopes are: ${SCOPES.join(", ")}.`
            );
        }

        if (new Set(scopes).size !== scopes.length) {
            warnings.push('"scopes" contains duplicates.');
        }

        // A write scope without its read counterpart is almost always an
        // oversight — an app that can change a record but not read one back
        // cannot show the person what it just did.
        for (const scope of scopes) {
            if (typeof scope !== "string" || !scope.endsWith(":write")) continue;

            const read = scope.replace(":write", ":read");

            if (isScope(read) && !scopes.includes(read)) {
                warnings.push(`"${scope}" without "${read}" — the app can write but not read back.`);
            }
        }
    }

    if (errors.length > 0) return { ok: false, errors, warnings };

    return { ok: true, manifest: raw as AppManifest, warnings };
};

/**
 * The scopes a reviewer has to sign off, with what each one actually permits.
 * Feeds the approval screen on the admin dashboard.
 */
export const reviewSummary = (
    manifest: AppManifest
): { scope: Scope; rationale?: string; permits: string[] }[] =>
    manifest.scopes.map((scope) => ({
        scope,
        ...(manifest.permissionsRationale?.[scope] === undefined
            ? {}
            : { rationale: manifest.permissionsRationale[scope] }),
        // The endpoints that scope actually unlocks, in words — so a reviewer
        // approves a list of capabilities rather than a string like
        // "records:write" whose reach they have to take on trust.
        permits: explainScope(scope)
    }));
