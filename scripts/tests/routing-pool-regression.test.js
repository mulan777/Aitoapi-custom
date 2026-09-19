"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const subjectRoot = path.resolve(process.env.SUBJECT_ROOT || path.join(__dirname, "..", ".."));

const RequestHandler = require(path.join(subjectRoot, "src", "core", "RequestHandler.js"));
const { QueueClosedError } = require(path.join(subjectRoot, "src", "utils", "MessageQueue.js"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "playwright") return { firefox: {} };
    return originalLoad.call(this, request, parent, isMain);
};
const BrowserManager = require(path.join(subjectRoot, "src", "core", "BrowserManager.js"));
Module._load = originalLoad;

const logger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
};

function createRequestHandlerHarness(initialAuthIndex = 1) {
    const handler = Object.create(RequestHandler.prototype);
    handler.logger = logger;
    handler.requestAuthBindings = new Map([["request-1", initialAuthIndex]]);
    handler.requestModelBindings = new Map();
    handler.requestFailureCounts = new Map();
    handler.accountRouteState = new Map();
    handler.accountDisableCleanup = new Map();
    handler.pendingUsageRotations = new Set();
    handler.authSource = {
        availableIndices: [1, 2, 3],
        isExpired: () => false,
        isUnavailable: () => false,
    };
    handler.authSwitcher = {
        currentAuthIndex: initialAuthIndex,
        handleRequestFailureAndSwitch: async () => ({ success: true }),
    };
    handler.config = { maxRetries: 2, retryDelay: 0 };
    handler.timeouts = { FAKE_STREAM: 1000 };
    return handler;
}

function readyPage() {
    return { isClosed: () => false };
}

function createBrowserManagerHarness(rotation, contextIndices, readyIndices, reconnectPendingIndices = []) {
    const authSource = {
        availableIndices: [...rotation],
        expiredIndices: [],
        getCanonicalIndex: index => index,
        getDuplicateGroups: () => [],
        getRotationIndices: () => [...rotation],
        isUnavailable: () => false,
    };
    const manager = new BrowserManager(logger, { maxContexts: 3 }, authSource);
    manager._currentAuthIndex = rotation[0] ?? -1;
    manager.contexts = new Map(contextIndices.map(index => [index, { context: {}, page: readyPage() }]));
    manager.connectionRegistry = {
        getConnectionByAuth: index => (readyIndices.includes(index) ? { readyState: 1 } : null),
        hasMessageQueueForAuth: () => false,
        isReconnectPending: index => reconnectPendingIndices.includes(index),
    };
    const closed = [];
    manager._closeContextForPoolIfPossible = async index => {
        closed.push(index);
        manager.contexts.delete(index);
        return true;
    };
    return { closed, manager };
}

test("503 fallback switch rebinds the request to the newly selected account", async () => {
    const handler = createRequestHandlerHarness(1);
    handler._selectRequestAuthIndex = () => -1;
    handler.authSwitcher.handleRequestFailureAndSwitch = async () => {
        handler.authSwitcher.currentAuthIndex = 2;
        return { success: true };
    };
    handler._waitForSystemAndConnectionIfBusy = async () => true;

    const tracker = { attemptedAuthIndices: new Set([1]), modelName: null };
    const switched = await handler._performImmediateSwitchRetry(
        { message: "temporary upstream failure", status: 503 },
        "request-1",
        tracker
    );

    assert.equal(switched, true);
    assert.equal(handler.requestAuthBindings.get("request-1"), 2);
    assert.deepEqual([...tracker.attemptedAuthIndices], [1, 2]);
});

test("context_closed retry creates the replacement queue on the rebound account", async () => {
    const handler = createRequestHandlerHarness(1);
    handler.authSwitcher.currentAuthIndex = 2;
    handler._selectRequestAuthIndex = () => 2;
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    handler._getUsageStatsService = () => null;
    handler._getProxyRequestModel = () => null;
    handler._forwardRequest = () => {};
    handler._markAccountSuccess = () => {};
    handler._advanceProxyRequestAttempt = proxyRequest => {
        proxyRequest.request_attempt_id = "attempt-2";
    };

    const firstQueue = {
        dequeue: async () => {
            throw new QueueClosedError("context closed", "context_closed");
        },
    };
    const replacementQueue = {
        dequeue: async () => ({ event_type: "response", value: "ok" }),
    };
    const createdFor = [];
    handler.connectionRegistry = {
        createMessageQueue: (requestId, authIndex) => {
            createdFor.push({ authIndex, requestId });
            return replacementQueue;
        },
        getAuthIndexForRequest: () => 1,
        getConnectionByAuth: authIndex => (authIndex === 2 ? { readyState: 1 } : null),
    };

    const proxyRequest = { request_attempt_id: "attempt-1", request_id: "request-1" };
    const result = await handler._executeRequestWithRetries(proxyRequest, firstQueue);

    assert.equal(result.success, true);
    assert.deepEqual(createdFor, [{ authIndex: 2, requestId: "request-1" }]);
    assert.equal(handler.requestAuthBindings.get("request-1"), 2);
});

test("pool targets exclude unschedulable rotation entries and retain the READY replacement", async () => {
    const { closed, manager } = createBrowserManagerHarness([60, 61, 63, 65], [60, 61, 65], [60, 61, 65]);
    if (typeof manager.setContextSchedulableProvider === "function") {
        manager.setContextSchedulableProvider(index => index !== 63);
    } else {
        manager._contextSchedulableProvider = index => index !== 63;
    }

    const result = await manager._rebalanceContextPoolOnce();

    assert.deepEqual(closed, []);
    assert.equal(manager.contexts.has(65), true);
    assert.deepEqual(result.candidates, []);
});

test("READY contexts are preferred over earlier cold rotation entries", async () => {
    const { closed, manager } = createBrowserManagerHarness([60, 61, 63, 65], [60, 61, 65], [60, 61, 65]);
    if (typeof manager.setContextSchedulableProvider === "function") {
        manager.setContextSchedulableProvider(() => true);
    }

    await manager._rebalanceContextPoolOnce();

    assert.deepEqual(closed, []);
    assert.equal(manager.contexts.has(65), true);
});

test("a dead context does not consume a READY pool slot", async () => {
    const { manager } = createBrowserManagerHarness([60, 61, 63, 65], [60, 61, 63], [60, 61]);
    if (typeof manager.setContextSchedulableProvider === "function") {
        manager.setContextSchedulableProvider(() => true);
    }

    const result = await manager._rebalanceContextPoolOnce();

    assert.deepEqual(result.candidates, [65]);
});

test("a live context in reconnect grace keeps its pool slot reserved", async () => {
    const { manager } = createBrowserManagerHarness([60, 61, 62, 63], [60, 61, 62], [61, 62], [60]);
    if (typeof manager.setContextSchedulableProvider === "function") {
        manager.setContextSchedulableProvider(() => true);
    }

    assert.equal(manager._getEffectivePoolOccupancy(), 3);
    const result = await manager._rebalanceContextPoolOnce();

    assert.deepEqual(result.candidates, []);
    assert.equal(manager.contexts.has(63), false);
    assert.equal(manager.contexts.size, 3);
});

test("a pending reconnect context is retained ahead of a cold rotation candidate", async () => {
    const { closed, manager } = createBrowserManagerHarness([60, 61, 62, 63], [60, 61, 63], [60, 61], [63]);
    if (typeof manager.setContextSchedulableProvider === "function") {
        manager.setContextSchedulableProvider(() => true);
    }

    const result = await manager._rebalanceContextPoolOnce();

    assert.deepEqual(closed, []);
    assert.equal(manager.contexts.has(63), true);
    assert.equal(manager.contexts.size, 3);
    assert.deepEqual(result.candidates, []);
});

test("routing pool selects only configured READY slots and promotes a warm standby on failure", () => {
    const contexts = new Map([0, 1, 2, 3, 4].map(index => [index, { page: { isClosed: () => false } }]));
    const connections = new Map([0, 1, 2, 3, 4].map(index => [index, { readyState: 1 }]));
    const handler = Object.create(RequestHandler.prototype);
    handler.browserManager = {
        contexts,
        getRoutingAuthIndices: () => [0, 1, 2],
        getRoutingPoolSize: () => 3,
    };
    handler.connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: index => connections.get(index),
    };
    handler.authSource = {
        availableIndices: [0, 1, 2, 3, 4],
        isUnavailable: () => false,
    };
    handler.accountRouteState = new Map();
    handler.requestRouteCursor = 0;
    handler.authSwitcher = { currentAuthIndex: 0 };
    handler._isAuthUnavailable = () => false;
    handler._isInWsCrashLoop = () => false;
    handler._isPerAccountUsageRoutingEnabled = () => false;
    handler.logger = logger;

    const selected = new Set();
    for (let i = 0; i < 6; i++) selected.add(handler._selectRequestAuthIndex([], "gemini-3.1-pro"));
    assert.deepEqual(
        [...selected].sort((a, b) => a - b),
        [0, 1, 2]
    );

    // A cooldown on one preferred slot promotes standby #3, without creating
    // another Context or routing all five accounts at once.
    handler.accountRouteState.set(0, { cooldownUntil: Date.now() + 60_000, inFlight: 0 });
    const promoted = handler._selectRequestAuthIndex([], "gemini-3.1-pro");
    assert.ok([1, 2, 3].includes(promoted));
    assert.notEqual(promoted, 0);
});

test("split capacity keeps READY and warm standby slots separate", () => {
    const authSource = {
        availableIndices: [0, 1, 2, 3, 4],
        getRotationIndices: () => [0, 1, 2, 3, 4],
        isUnavailable: () => false,
    };
    const manager = new BrowserManager(
        logger,
        {
            maxContexts: 5,
            routingPoolSize: 3,
            warmStandbyContexts: 2,
        },
        authSource
    );
    assert.equal(manager.getMaxManagedContexts(), 5);
    assert.equal(manager.getRoutingPoolSize(), 3);
    assert.equal(manager.getWarmStandbyContexts(), 2);
    assert.equal(manager.getDesiredPoolSize(), 5);

    manager.config.maxContexts = 10;
    assert.equal(manager.getDesiredPoolSize(), 5);

    // Legacy deployments with no split settings continue to preheat the
    // configured MAX_CONTEXTS pool.
    manager.config.routingPoolSize = undefined;
    manager.config.warmStandbyContexts = 0;
    assert.equal(manager.getRoutingPoolSize(), 10);
    assert.equal(manager.getDesiredPoolSize(), 10);
});
