"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const StatusRoutes = require("../../src/routes/StatusRoutes");

const OPEN = 1;

function createStatus(options = {}) {
    const indices = options.indices || [0, 1, 2, 3];
    const contexts = new Map();
    for (const index of options.contextIndices || []) {
        contexts.set(index, {
            page: {
                isClosed: () => (options.closedPageIndices || []).includes(index),
            },
        });
    }

    const connections = new Map();
    for (const [index, readyState] of Object.entries(options.connectionStates || {})) {
        connections.set(Number(index), { readyState });
    }

    const unavailable = new Set(options.unavailableIndices || []);
    const accountNameMap = new Map(indices.map(index => [index, `account-${index}`]));
    const authSource = {
        accountNameMap,
        availableIndices: [...indices],
        disabledIndices: [],
        duplicateIndices: [],
        expiredIndices: [],
        getCanonicalIndex: index => index,
        getRotationIndices: () => [...indices],
        getStatusMetadata: () => null,
        initialIndices: [...indices],
        isUnavailable: index => unavailable.has(index),
    };
    const browserManager = {
        _isContextSchedulable: index => !unavailable.has(index),
        contexts,
    };
    const connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: index => connections.get(index),
    };
    const requestHandler = {
        currentAuthIndex: options.currentAuthIndex ?? indices[0] ?? -1,
        failureCount: 0,
        getAccountRouteStatus: () => ({}),
        isSystemBusy: false,
        usageCount: 0,
    };
    const config = {
        accountCooldownMaxMs: 0,
        accountCooldownMs: 0,
        apiKeySource: "fixture",
        autoDisableStatusCodes: [401, 403],
        autoHealProbeIntervalMs: 0,
        autoHealProbeTimeoutMs: 0,
        checkUpdate: false,
        enableAuthUpdate: false,
        failureThreshold: 0,
        forceCodeExecution: false,
        forceThinking: false,
        forceUrlContext: false,
        forceWebSearch: false,
        immediateSwitchStatusCodes: [429, 503],
        maxContexts: options.maxContexts ?? 3,
        maxRetries: 0,
        modelPoolAllowlist: [],
        modelPoolMode: "all",
        retryDelay: 0,
        routingPoolSize: options.routingPoolSize ?? options.maxContexts ?? 3,
        safetySettingsThreshold: "OFF",
        streamingMode: true,
        switchOnUses: 0,
        warmStandbyContexts: options.warmStandbyContexts ?? 0,
    };
    const logger = {
        displayLimit: 100,
        logBuffer: [],
        warn() {},
    };
    const routes = Object.create(StatusRoutes.prototype);
    routes.logger = logger;
    routes.serverSystem = {
        authSource,
        browserManager,
        config,
        connectionRegistry,
        logger,
        requestHandler,
        usageStatsService: null,
    };

    return routes._getStatusData().status;
}

function account(status, index) {
    return status.accountDetails.find(item => item.index === index);
}

test("registry-only warm-up is diagnostic, not a managed READY context", () => {
    const status = createStatus({
        connectionStates: { 0: OPEN },
        contextIndices: [],
        currentAuthIndex: 0,
        indices: [0],
    });

    assert.equal(status.registryReadyWebSocketCount, 1);
    assert.equal(status.managedReadyWebSocketCount, 0);
    assert.equal(status.readyWebSocketCount, 0);
    assert.equal(account(status, 0).wsConnected, false);
    assert.equal(status.browserConnected, true);
});

test("finite pool caps the panel count during atomic context overflow", () => {
    const status = createStatus({
        connectionStates: { 0: OPEN, 1: OPEN, 2: OPEN, 3: OPEN },
        contextIndices: [0, 1, 2, 3],
        maxContexts: 3,
    });

    assert.equal(status.registryReadyWebSocketCount, 4);
    assert.equal(status.managedReadyWebSocketCount, 4);
    assert.equal(status.readyWebSocketCount, 3);
});

test("READY panel count follows the independent routing pool cap", () => {
    const status = createStatus({
        connectionStates: { 0: OPEN, 1: OPEN, 2: OPEN, 3: OPEN },
        contextIndices: [0, 1, 2, 3],
        maxContexts: 5,
        routingPoolSize: 3,
        warmStandbyContexts: 2,
    });

    assert.equal(status.activeContextsCount, 4);
    assert.equal(status.maxContexts, 5);
    assert.equal(status.routingPoolSize, 3);
    assert.equal(status.warmStandbyContexts, 2);
    assert.equal(status.readyWebSocketCount, 3);
    assert.equal(status.routingReadyWebSocketCount, 3);
    assert.equal(status.warmStandbyReadyWebSocketCount, 1);
});

test("only OPEN sockets count as READY and drive browserConnected", () => {
    const status = createStatus({
        connectionStates: { 0: 0, 1: OPEN, 2: 3 },
        contextIndices: [0, 1, 2],
        currentAuthIndex: 0,
        indices: [0, 1, 2],
    });

    assert.equal(status.registryReadyWebSocketCount, 1);
    assert.equal(status.managedReadyWebSocketCount, 1);
    assert.equal(status.readyWebSocketCount, 1);
    assert.equal(status.browserConnected, false);
    assert.equal(account(status, 0).wsConnected, false);
    assert.equal(account(status, 1).wsConnected, true);
});

test("an OPEN socket on a closed page is not managed READY", () => {
    const status = createStatus({
        closedPageIndices: [0],
        connectionStates: { 0: OPEN },
        contextIndices: [0],
        currentAuthIndex: 0,
        indices: [0],
    });

    assert.equal(status.registryReadyWebSocketCount, 1);
    assert.equal(status.managedReadyWebSocketCount, 0);
    assert.equal(status.readyWebSocketCount, 0);
    assert.equal(account(status, 0).wsConnected, false);
    assert.equal(status.browserConnected, true);
});

test("an unschedulable context is excluded from managed and account READY state", () => {
    const status = createStatus({
        connectionStates: { 0: OPEN },
        contextIndices: [0],
        indices: [0],
        unavailableIndices: [0],
    });

    assert.equal(status.registryReadyWebSocketCount, 1);
    assert.equal(status.managedReadyWebSocketCount, 0);
    assert.equal(status.readyWebSocketCount, 0);
    assert.equal(account(status, 0).wsConnected, false);
});

test("unlimited pools expose every managed READY context", () => {
    const status = createStatus({
        connectionStates: { 0: OPEN, 1: OPEN, 2: OPEN, 3: OPEN },
        contextIndices: [0, 1, 2, 3],
        maxContexts: 0,
    });

    assert.equal(status.registryReadyWebSocketCount, 4);
    assert.equal(status.managedReadyWebSocketCount, 4);
    assert.equal(status.readyWebSocketCount, 4);
});
