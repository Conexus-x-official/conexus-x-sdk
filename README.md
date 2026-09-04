# @conexus-x/sdk

Build **custom views** that run inside a Conexus X module module — the way a monday.com module view works. An app is a web page you host; Conexus X frames it inside the module and talks to it over a single postMessage channel.

Zero runtime dependencies in the core, React bindings on the side. TypeScript-first. Ships both halves of the bridge so they cannot drift apart.

```
guest  (the app, in an iframe)          host  (the Conexus X module)
  @conexus-x/sdk                          @conexus-x/sdk/host
  @conexus-x/sdk/react     <------->      @conexus-x/sdk/react-host
                        one protocol
                       src/protocol.ts
```

| Entry point | For | Needs React |
| --- | --- | --- |
| `@conexus-x/sdk` | The view, any framework or none | no |
| `@conexus-x/sdk/react` | The view, with hooks | yes |
| `@conexus-x/sdk/host` | The Conexus X app, framework-free | no |
| `@conexus-x/sdk/react-host` | The Conexus X app, as a hook | yes |
| `@conexus-x/sdk/manifest` | The review pipeline — validate a submission | no |

**Why the core is not React.** An app author may write a view in React, Svelte, Vue or plain JS, and the host is itself a React app that must not ship a second copy of React inside an SDK. So the client stays framework-free and React is an *optional peer dependency of two entry points*. Nobody pays for it who is not using it; nobody is locked out who is.

**Why React bindings exist anyway.** A view is a subscription problem — the module moves under it as the person switches collection, a colleague edits a cell, the theme flips — and hand-rolled `listen`/unsubscribe inside `useEffect` is where the leaks live.

---

## Why an iframe

A custom view is code we did not write. Rendered into the module DOM it would share globals, styles, and the signed-in user JWT. On its own origin it can read none of that, and **every piece of data it gets, it gets because the host handed it over**.

Two independent gates stand between an app and customer data:

1. **Scopes** — the app declares what it needs; an admin approves a subset; the host serves only the intersection.
2. **The route allowlist** ([`src/routes.ts`](src/routes.ts)) — a fixed table of endpoints an app may reach. `/api-key`, `/auth/*`, `/agent/*`, `/conversations/*` and friends are not on it and cannot be reached, whatever an app was granted.

Underneath both, the host proxies every call with the **signed-in user own credentials**, so the API re-checks workspace membership and module access as usual. A scope narrows what the user can do; it never widens it.

---

## Quick start (React)

```bash
npm install @conexus-x/sdk
```

```tsx
import {
    useConnection, useViewContext, useSettings,
    useRecords, useScope, useCommands, useAutoResize
} from "@conexus-x/sdk/react";

export default function View() {
    const { status, error } = useConnection();
    const context = useViewContext();          // re-renders as the person moves
    const canWrite = useScope("records:write");
    const commands = useCommands();

    // Refetches on its own when the module changes — no socket, no polling
    const { data: records, loading } = useRecords(context?.collectionId);

    useAutoResize();

    if (status !== "ready") return <Spinner />;

    return records?.map((record) => (
        <Row key={record._id} record={record} canWrite={canWrite}
             onOpen={() => commands.openRecord(record._id)} />
    ));
}
```

Two complete starters ship separately: `@conexus-x/next-view` (Next.js) and `@conexus-x/react-view` (React + Vite). Scaffold from one rather than starting empty.

**Hooks:** `useConexus` · `useConnection` · `useViewContext` · `useSettings` · `useSelection` · `useScope` · `useConexusEvent` · `useConexusQuery` · `useRecords` · `useCollections` · `useColumns` · `useCommands` · `useAutoResize`

## Quick start (no framework)

```js
import conexus from "@conexus-x/sdk";

const cx = conexus();

const { context, settings, grantedScopes } = await cx.connect();

// What the person is looking at
console.log(context.workspaceId, context.moduleId, context.collectionId);

// Read the module
const records = await cx.api.records.list(context.collectionId);

// Write to it, if you were granted the scope
if (cx.hasScope("records:write")) {
    await cx.api.records.update(records[0]._id, { isCompleted: true });
}

// Stay live: another person edit arrives here too
cx.listen("change", (event) => {
    if (event.entity === "record") refresh();
});

// Follow the person around the module
cx.listen("context", (next) => render(next));

cx.autoResize();
```

The same view, written with hooks instead, is what both starters ship.

---

## Guest API

| Call | What it does |
| --- | --- |
| `cx.connect()` | Handshake. Resolves `{ context, settings, grantedScopes, hostVersion }`. Safe to call from ten components — one handshake happens. |
| `cx.context` | The last context the host sent, kept current by pushes. `null` before connect. |
| `cx.hasScope(scope)` | Feature-detect. Never assume a scope was granted. |
| `cx.getContext()` / `cx.getSettings()` | Fetch fresh, rather than reading the cache. |
| `cx.listen(topic, fn)` | `context`, `settings`, `selection`, `change`, `theme`. Returns the unsubscribe function, so a React effect hands it straight back. |
| `cx.api.*` | Typed helpers over the allowlist — `records`, `collections`, `columns`, `values`, `amendments`, `members`, `activity`. |
| `cx.request({ method, path, query, body })` | The raw call, for an endpoint the helpers do not cover yet. |
| `cx.execute(command, params)` | Ask the host to do something only it can: `notice`, `openRecord`, `confirm`, `resize`, `navigate`, `copyToClipboard`. |
| `cx.storage.*` | Small key-value store scoped to **this mount** of the view. For view state, not customer data. |
| `cx.autoResize(el?)` | Keep the iframe as tall as the content. Opt-in — a view with its own scroll area does not want it. |
| `cx.destroy()` | Drop listeners, reject anything in flight. |

Every failure rejects with a `ConexusError` carrying a `code`: `scope_denied`, `route_denied`, `timeout`, `command_unsupported`, `api_error`, `not_connected`, `protocol_mismatch`, `bad_request`, `storage_unavailable`, `host_error`. Branch on the code — the message is for your console and may be reworded.

---

## Scopes

Declared in the manifest, approved by an admin, enforced by the host.

| Scope | Unlocks |
| --- | --- |
| `records:read` / `records:write` | Rows and sub-rows |
| `collections:read` / `collections:write` | The groups a module is split into |
| `columns:read` / `columns:write` | The shape of the grid |
| `values:read` / `values:write` | Cell values, including mirrored ones |
| `amendments:read` / `amendments:write` | Updates posted on a record |
| `members:read` | Who is in the workspace |
| `activity:read` | The activity feed |
| `storage` | The per-instance key-value store |

`explainScope(scope)` turns any of them into the plain-English list of things it permits — that is what the approval screen shows a reviewer, so nobody signs off on a string like `records:write` without seeing its reach.

---

## Manifest

One JSON file per app; the unit the review pipeline works on.

```json
{
    "id": "revenue-timeline",
    "name": "Revenue Timeline",
    "version": "1.0.0",
    "description": "A timeline of closed deals.",
    "publisher": { "name": "Acme", "email": "dev@acme.example" },
    "entry": "https://apps.acme.example/timeline/index.html",
    "views": [
        { "id": "timeline", "name": "Timeline", "surface": "module", "defaultHeight": 600 }
    ],
    "scopes": ["records:read", "values:read"],
    "permissionsRationale": {
        "records:read": "To place each deal on the timeline."
    }
}
```

```js
import { parseManifest, reviewSummary } from "@conexus-x/sdk/manifest";

const result = parseManifest(json);              // https entry required
const local  = parseManifest(json, { allowLocalhostEntry: true });  // test env only

if (!result.ok) console.error(result.errors);    // every problem at once, not the first
```

`surface` is `module` (a tab on the module — the monday-style custom view), `record` (a panel in the record view), or `workspace` (a full page).

---

## Hosting a view (Conexus X app side)

In the Next app, one hook:

```tsx
"use client";

import { useViewHost, fetchTransport } from "@conexus-x/sdk/react-host";

export function CustomView({ install, context }: Props) {
    const { iframeProps, connected, forwardChange } = useViewHost({
        entry: install.manifest.entry,
        appId: install.manifest.id,
        viewId: install.viewId,
        grantedScopes: install.grantedScopes,

        // Pass a new object when the module moves; the hook diffs and pushes
        // only on a real change, so unrelated re-renders cost nothing.
        context,
        settings: install.settings,

        transport: fetchTransport({ baseUrl: API_URL, token: () => getToken() }),
        commands: {
            notice: ({ message, type }) => toast[type ?? "info"](message),
            openRecord: ({ recordId }) => router.push(recordPath(recordId)),
            confirm: ({ message }) => confirmDialog(message)
        },
        onError: (error, detail) => console.warn("[view]", error.code, error.message, detail)
    });

    // Feed it the socket you already have
    useRealtime((event) => forwardChange(event));

    return <iframe {...iframeProps} className="h-full w-full border-0" />;
}
```

`useViewHost` returns props to spread rather than a `<ConexusView />` component on purpose: the module owns how the frame is sized, bordered and laid out, and a component would grow a prop for each of those until it was a worse `<iframe>`.

The framework-free `createViewHost` is still there under `@conexus-x/sdk/host` if you need it — the hook is a wrapper, not a reimplementation.

`forwardChange` drops anything that is not this module — a view must never learn that a record moved on a module its user cannot open, and only the host knows which module that is.

---

## Testing

```bash
npm run build
npm test
```

`test/bridge.test.mjs` runs **both halves for real** against two wired window shims: handshake and scope intersection, an allowed read reaching the transport, a denied write never reaching it, `/api-key` and path traversal refused, commands and unsupported commands, storage round trip, change filtering, context pushes, and forged messages from another origin or another frame being ignored. Eleven cases, no mocks of the thing under test.

---

## Where this sits in the bigger plan

The pipeline you are heading for is: **build → test environment → submit → automated test cases → admin approval → live on the CRM.** This package is the foundation layer that every one of those stages needs — the runtime contract an app is written against, and the manifest they all read.

Built here:

- the protocol, guest client, and host bridge
- React bindings for both halves — hooks for the view, `useViewHost` for the app
- the scope model and the route allowlist that enforce it
- the manifest format, its validator, and `reviewSummary()` for the approval screen
- `ViewContext.environment` (`"test"` | `"live"`), so an app knows which side of the pipeline it is running on
- two starters an app author can copy and ship — `conexus-x-np` (Next.js) and `conexus-x-rp` (React + Vite)

Not built yet, and each is its own piece of work:

- backend models and routes for apps, versions, installs and grants
- the sandbox workspace that serves the `test` environment
- the automated test-case runner that gates submission
- the admin dashboard approval queue
- mounting a view inside `app/workspace/[id]/module/[moduleId]` — today that route is one module with no view switcher
- a marketplace, billing, and versioned rollout

---

## Protocol stability

`PROTOCOL_VERSION` is `1`. A host refuses a guest whose major version it does not know rather than half-speaking to it — a view rendering with three of five fields missing looks like our bug and reads like data loss to the customer. Anything exported from the package root is a promise to third parties; treat a change to it as a breaking release.
