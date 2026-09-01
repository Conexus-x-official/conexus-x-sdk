/**
 * End-to-end probe of the view bridge.
 *
 * Both halves run for real against two window shims wired to each other, so
 * this exercises the ACTUAL handshake, correlation, scope gate, route
 * allowlist and event fan-out rather than a mock of them. The main repo learned
 * this the hard way on amendments: two halves that each look correct in
 * isolation can cancel out, and only a probe that runs them together notices.
 *
 *     npm run build && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createViewHost, memoryStorage } from "../dist/host.js";
import conexus from "../dist/guest.js";
import { matchRoute } from "../dist/routes.js";
import { parseManifest } from "../dist/manifest.js";

const HOST_ORIGIN = "https://app.conexus-x.test";
const APP_ORIGIN = "https://apps.example.test";

class WindowShim {
    constructor(origin, search = "") {
        this.origin = origin;
        this.location = { origin, search, href: origin };
        this.listeners = new Set();
        this.received = [];
    }

    addEventListener(type, handler) {
        if (type === "message") this.listeners.add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.delete(handler);
    }

    /** Simulates the browser delivering a message event to this window. */
    deliver(data, source, origin) {
        this.received.push(data);

        for (const handler of [...this.listeners]) {
            handler({ data: structuredClone(data), source, origin });
        }
    }
}

/** Wires a host and a guest together and completes the handshake. */
const build = async (options = {}) => {
    const scopes = options.requestScopes ?? "records:read,records:write,storage";

    const hostWindow = new WindowShim(HOST_ORIGIN);
    const guestWindow = new WindowShim(
        APP_ORIGIN,
        `?cxOrigin=${encodeURIComponent(HOST_ORIGIN)}&cxApp=demo-app&cxView=board&cxScopes=${scopes}`
    );

    guestWindow.parent = hostWindow;
    hostWindow.parent = hostWindow;

    // guest -> host
    hostWindow.postMessage = (data) => hostWindow.deliver(data, guestWindow, APP_ORIGIN);
    // host -> guest
    guestWindow.postMessage = (data) => guestWindow.deliver(data, hostWindow, HOST_ORIGIN);

    const context = {
        instanceId: "inst_1",
        viewId: "board",
        appId: "demo-app",
        workspaceId: "w1",
        moduleId: "m1",
        collectionId: "c1",
        selectedRecordIds: [],
        user: { id: "u1", firstName: "Ada" },
        role: "member",
        theme: "light",
        locale: "en",
        environment: "test"
    };

    const calls = [];

    const transport = async (input) => {
        calls.push(input);
        return { status: 200, data: [{ _id: "r1", name: "Row one", position: 0, collectionName: "c1" }] };
    };

    const notices = [];

    globalThis.window = hostWindow;

    const host = createViewHost({
        iframe: { contentWindow: guestWindow },
        appOrigin: APP_ORIGIN,
        grantedScopes: options.grantedScopes ?? ["records:read", "storage", "values:read"],
        getContext: () => context,
        getSettings: () => ({ groupBy: "status" }),
        transport,
        storage: memoryStorage(),
        commands: {
            notice: async (params) => {
                notices.push(params);
            }
        }
    });

    globalThis.window = guestWindow;

    const cx = conexus();
    const connection = await cx.connect();

    return { cx, host, connection, calls, notices, context, hostWindow, guestWindow };
};

test("handshake grants the intersection of asked-for and approved scopes", async () => {
    const { connection, cx } = await build();

    // Asked for records:read, records:write, storage. Approved: records:read,
    // storage, values:read. records:write must not survive, values:read was
    // never asked for and must not be handed over unrequested.
    assert.deepEqual(connection.grantedScopes.sort(), ["records:read", "storage"]);
    assert.equal(cx.hasScope("records:read"), true);
    assert.equal(cx.hasScope("records:write"), false);
    assert.equal(connection.context.moduleId, "m1");
    assert.equal(connection.settings.groupBy, "status");
});

test("an allowed read reaches the transport with the matched route", async () => {
    const { cx, calls } = await build();

    const records = await cx.api.records.list("c1");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { method: "GET", path: "/records/c1" });
    assert.equal(records[0]._id, "r1");
});

test("a write is refused when the scope was not granted, and never reaches the API", async () => {
    const { cx, calls } = await build();

    await assert.rejects(
        () => cx.api.records.create("c1", { name: "New" }),
        (error) => {
            assert.equal(error.name, "ConexusError");
            assert.equal(error.code, "scope_denied");
            return true;
        }
    );

    assert.equal(calls.length, 0, "a denied call must not be proxied");
});

test("an endpoint off the allowlist is refused even with every scope granted", async () => {
    const { cx, calls } = await build({
        grantedScopes: [
            "records:read", "records:write", "collections:read", "collections:write",
            "columns:read", "columns:write", "values:read", "values:write",
            "amendments:read", "amendments:write", "members:read", "activity:read", "storage"
        ],
        requestScopes: "records:read,records:write,storage"
    });

    // The user API key would outlive the session, the board and the install.
    await assert.rejects(
        () => cx.request({ method: "GET", path: "/api-key" }),
        (error) => error.code === "route_denied"
    );

    // Reaching a forbidden endpoint by walking out of an allowed one.
    await assert.rejects(
        () => cx.request({ method: "GET", path: "/records/../api-key" }),
        (error) => error.code === "route_denied"
    );

    // Naming a whole other server rather than an endpoint.
    await assert.rejects(
        () => cx.request({ method: "GET", path: "//evil.test/steal" }),
        (error) => error.code === "route_denied"
    );

    assert.equal(calls.length, 0);
});

test("commands run on the host, and an unimplemented one says so", async () => {
    const { cx, notices } = await build();

    await cx.execute("notice", { message: "Saved", type: "success" });
    assert.deepEqual(notices, [{ message: "Saved", type: "success" }]);

    await assert.rejects(
        () => cx.execute("openRecord", { recordId: "r1" }),
        (error) => error.code === "command_unsupported"
    );
});

test("storage is namespaced per instance and survives a round trip", async () => {
    const { cx } = await build();

    assert.equal(await cx.storage.get("grouping"), null);

    await cx.storage.set("grouping", { by: "owner" });

    assert.deepEqual(await cx.storage.get("grouping"), { by: "owner" });
    assert.deepEqual(await cx.storage.keys(), ["grouping"]);

    await cx.storage.delete("grouping");
    assert.equal(await cx.storage.get("grouping"), null);
});

test("realtime changes are forwarded for this board and dropped for any other", async () => {
    const { cx, host } = await build();

    const seen = [];
    cx.listen("change", (event) => seen.push(event));

    host.forwardChange({ entity: "record", action: "created", moduleId: "m1", workspaceId: "w1", at: "now" });
    host.forwardChange({ entity: "record", action: "created", moduleId: "OTHER", workspaceId: "w1", at: "now" });
    host.forwardChange({ entity: "record", action: "created", workspaceId: "OTHER-WS", at: "now" });

    assert.equal(seen.length, 1, "only the event for the mounted board may be delivered");
    assert.equal(seen[0].moduleId, "m1");
});

test("a context push updates both the listener and the cached context", async () => {
    const { cx, host, context } = await build();

    const seen = [];
    cx.listen("context", (next) => seen.push(next));

    context.collectionId = "c2";
    context.selectedRecordIds = ["r1", "r2"];
    host.pushContext();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].collectionId, "c2");
    assert.equal(cx.context.collectionId, "c2", "the cached context must move with the push");
    assert.deepEqual(cx.context.selectedRecordIds, ["r1", "r2"]);
});

test("the host ignores messages from another origin or another frame", async () => {
    const { host, hostWindow, guestWindow, calls } = await build();

    const before = guestWindow.received.length;

    const forged = {
        cx: "conexus-x",
        v: 1,
        kind: "request",
        id: "forged",
        method: "api.request",
        params: { method: "GET", path: "/records/c1" }
    };

    // Right shape, wrong origin.
    for (const handler of [...hostWindow.listeners]) {
        handler({ data: forged, source: guestWindow, origin: "https://evil.test" });
    }

    // Right origin, wrong frame.
    for (const handler of [...hostWindow.listeners]) {
        handler({ data: forged, source: { not: "the iframe" }, origin: APP_ORIGIN });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(calls.length, 0, "a forged message must not reach the API");
    assert.equal(guestWindow.received.length, before, "and must not be answered");

    host.destroy();
});

test("constructing a client is side-effect free and safe on a server", async () => {
    // REGRESSION: the constructor used to read the URL and throw when cxOrigin
    // was missing. A "use client" component still renders once on the server,
    // where there is no window, so merely constructing a client took the whole
    // Next.js prerender down. Building the starter is what found it.
    const saved = globalThis.window;

    delete globalThis.window;

    assert.doesNotThrow(() => conexus(), "constructing must not touch window");

    const cx = conexus();

    await assert.rejects(
        () => cx.connect(),
        (error) => {
            assert.equal(error.code, "not_connected");
            return true;
        },
        "connecting without a window is a connection failure, not a crash"
    );

    globalThis.window = saved;
});

test("a missing host origin fails the connection rather than the render", async () => {
    const saved = globalThis.window;

    // A browser, in a frame, but the host never passed ?cxOrigin=.
    const guestWindow = new WindowShim(APP_ORIGIN, "?cxApp=demo-app");
    guestWindow.parent = new WindowShim(HOST_ORIGIN);

    globalThis.window = guestWindow;

    const cx = conexus();

    await assert.rejects(
        () => cx.connect(),
        (error) => {
            assert.equal(error.code, "not_connected");
            assert.match(error.message, /cxOrigin/);
            return true;
        }
    );

    // And nothing was broadcast while trying: a "*" fallback here would hand
    // this view content to whatever page framed it.
    assert.equal(guestWindow.parent.received.length, 0);

    globalThis.window = saved;
});

test("the route table matches what it should and nothing else", () => {
    assert.equal(matchRoute("GET", "/records/abc123").rule.scope, "records:read");
    assert.equal(matchRoute("GET", "/records/abc123/sub-records").rule.scope, "records:read");
    assert.equal(matchRoute("POST", "/record-values").rule.scope, "values:write");

    // The literal route has to win over the parameter that would also swallow it.
    assert.equal(
        matchRoute("GET", "/record-values/references/m1").rule.summary,
        "Read mirrored values across linked boards"
    );

    assert.equal(matchRoute("GET", "/auth/me"), null);
    assert.equal(matchRoute("POST", "/agent/chat"), null);
    assert.equal(matchRoute("GET", "/conversations"), null);
    assert.equal(matchRoute("GET", "/records/abc?x=1"), null);
    assert.equal(matchRoute("GET", "records/abc"), null);
});

test("the manifest validator collects every problem at once", () => {
    const bad = parseManifest({
        id: "Not Kebab",
        name: "",
        version: "1.0",
        entry: "http://apps.example.test/view",
        publisher: { name: "Someone", email: "not-an-email" },
        views: [{ id: "a", name: "A", surface: "nowhere" }],
        scopes: ["records:write", "made:up"]
    });

    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 6, `expected several errors, got ${bad.errors.length}`);
    assert.ok(bad.errors.some((line) => line.includes('"id"')));
    assert.ok(bad.errors.some((line) => line.includes("https")));
    assert.ok(bad.errors.some((line) => line.includes("made:up")));

    // A write with no matching read is a warning, not a rejection.
    assert.ok(bad.warnings.some((line) => line.includes("records:read")));

    const good = parseManifest({
        id: "revenue-timeline",
        name: "Revenue Timeline",
        version: "1.0.0",
        description: "A timeline of closed deals.",
        entry: "https://apps.example.test/view",
        publisher: { name: "Someone", email: "dev@example.test" },
        views: [{ id: "timeline", name: "Timeline", surface: "module", defaultHeight: 600 }],
        scopes: ["records:read", "values:read"]
    });

    assert.equal(good.ok, true);
    assert.equal(good.manifest.id, "revenue-timeline");

    // localhost is allowed only where it is explicitly permitted.
    const local = { ...good.manifest, entry: "http://localhost:5173" };
    assert.equal(parseManifest(local).ok, false);
    assert.equal(parseManifest(local, { allowLocalhostEntry: true }).ok, true);
});
