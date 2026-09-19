"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");

const ConnectionRegistry = require("../../src/core/ConnectionRegistry");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "playwright") return { firefox: {} };
    return originalLoad.call(this, request, parent, isMain);
};
const BrowserManager = require("../../src/core/BrowserManager");
Module._load = originalLoad;

const logger = {
    debug() {},
    error() {},
    getLevel: () => "INFO",
    info() {},
    warn() {},
};

class FakeWebSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
    }

    close() {
        this.readyState = 2;
        setImmediate(() => {
            this.readyState = 3;
            this.emit("close");
        });
    }
}

function createRegistry() {
    const browserManager = {
        contexts: new Map([[7, { page: { isClosed: () => false } }]]),
    };
    return new ConnectionRegistry(logger, null, () => 7, browserManager);
}

function addConnection(registry, websocket) {
    registry.addConnection(websocket, { address: "fixture", authIndex: 7 });
}

function waitForImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

test("a delayed close from an explicitly closed socket cannot remove its replacement", async () => {
    const registry = createRegistry();
    const oldConnection = new FakeWebSocket();
    const replacementConnection = new FakeWebSocket();

    addConnection(registry, oldConnection);
    registry.closeConnectionByAuth(7);
    addConnection(registry, replacementConnection);

    await waitForImmediate();

    assert.equal(registry.getConnectionByAuth(7, false), replacementConnection);
    assert.equal(registry.reconnectGraceTimers.has(7), false);
});

test("a stale close callback cannot delete a newer connection for the same account", () => {
    const registry = createRegistry();
    const oldConnection = new FakeWebSocket();
    const replacementConnection = new FakeWebSocket();

    addConnection(registry, oldConnection);
    registry.connectionsByAuth.set(7, replacementConnection);
    registry._removeConnection(oldConnection);

    assert.equal(registry.getConnectionByAuth(7, false), replacementConnection);
    assert.equal(registry.reconnectGraceTimers.has(7), false);
});

test("an identity-guarded close cannot close a newer socket", () => {
    const registry = createRegistry();
    const oldConnection = new FakeWebSocket();
    const replacementConnection = new FakeWebSocket();

    addConnection(registry, replacementConnection);
    registry.closeConnectionByAuth(7, oldConnection);

    assert.equal(registry.getConnectionByAuth(7, false), replacementConnection);
    assert.equal(replacementConnection.readyState, 1);
});

test("the registered socket still follows normal disconnect cleanup", () => {
    const registry = createRegistry();
    const connection = new FakeWebSocket();

    addConnection(registry, connection);
    registry._removeConnection(connection);

    assert.equal(registry.getConnectionByAuth(7, false), undefined);
    assert.equal(registry.reconnectGraceTimers.has(7), true);

    clearTimeout(registry.reconnectGraceTimers.get(7));
    registry.reconnectGraceTimers.delete(7);
});

test("reconnect pending covers grace, reconnect, and lightweight timeout states", () => {
    const registry = createRegistry();

    assert.equal(registry.isReconnectPending(7), false);

    const graceTimer = setTimeout(() => {}, 1000);
    registry.reconnectGraceTimers.set(7, graceTimer);
    assert.equal(registry.isReconnectPending(7), true);
    clearTimeout(graceTimer);
    registry.reconnectGraceTimers.delete(7);

    registry.reconnectingAccounts.set(7, true);
    assert.equal(registry.isReconnectPending(7), true);
    registry.reconnectingAccounts.delete(7);

    const timeoutId = setTimeout(() => {}, 1000);
    registry.lightweightReconnectTimeouts.set(7, { timeoutId, timeoutReject: () => {} });
    assert.equal(registry.isReconnectPending(7), true);
    clearTimeout(timeoutId);
    registry.lightweightReconnectTimeouts.delete(7);

    assert.equal(registry.isReconnectPending(7), false);
    assert.equal(registry.isReconnectPending(-1), false);
});

test("closing a browser context explicitly removes its captured registry socket", async () => {
    const manager = Object.create(BrowserManager.prototype);
    manager.logger = logger;
    manager.pendingContextClosures = new Map();
    manager.initializingContexts = new Set();
    manager.abortedContexts = new Set();
    manager._currentAuthIndex = -1;
    manager.browser = null;
    manager._stopBackgroundWakeup = async () => {};
    manager.contexts = new Map([
        [
            7,
            {
                context: { close: async () => {} },
                healthMonitorInterval: null,
                page: { isClosed: () => false },
            },
        ],
    ]);

    const registry = new ConnectionRegistry(logger, null, () => -1, manager);
    manager.connectionRegistry = registry;
    const connection = new FakeWebSocket();
    addConnection(registry, connection);

    await manager.closeContext(7);

    assert.equal(manager.contexts.has(7), false);
    assert.equal(registry.getConnectionByAuth(7, false), undefined);
    assert.equal(connection.readyState, 2);

    await waitForImmediate();
});
