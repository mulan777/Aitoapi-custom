/*
 * Unified quota breaker regression suite.
 * Generated against the local 2026-09-19 live-source snapshot.
 *
 * Run after applying quota-breaker-unified.patch to a copy of the source:
 *   REQUEST_HANDLER_PATH=<copy>/src/core/RequestHandler.js node quota-breaker-unified.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sourcePath = path.resolve(
    process.env.REQUEST_HANDLER_PATH || path.join(__dirname, "../../src/core/RequestHandler.js")
);
const sourceText = fs.readFileSync(sourcePath, "utf8");
const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aitoapi-unified-quota-"));
process.chdir(tempRoot);
delete require.cache[sourcePath];
const RequestHandler = require(sourcePath);

const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} };

function makeHarness(options = {}) {
    const indices = options.indices || [1, 2, 3];
    const connections = new Map(indices.map(index => [index, { readyState: 1, send: () => {} }]));
    const disabled = new Set(options.disabled || []);
    const statusMap = new Map();
    const counters = {
        closeConnection: 0,
        closeContext: 0,
        closeQueues: 0,
        disable: 0,
        enable: 0,
        launches: 0,
        rebalance: 0,
    };

    for (const index of disabled) {
        statusMap.set(index, {
            disabledAt: new Date().toISOString(),
            disabledReason: "quota_exhausted",
            disabledStatus: 429,
        });
    }

    const authSource = {
        availableIndices: [...indices],
        disableAuth: async (index, metadata = {}) => {
            counters.disable += 1;
            // Preserve an async boundary so two observations exercise the
            // RequestHandler single-flight map rather than completing inline.
            await Promise.resolve();
            if (options.disableSucceeds === false) return false;
            disabled.add(index);
            statusMap.set(index, {
                disabledAt: new Date().toISOString(),
                disabledReason: metadata.reason || "manual",
                disabledStatus: metadata.status ?? null,
            });
            return true;
        },
        enableAuth: async index => {
            counters.enable += 1;
            disabled.delete(index);
            statusMap.set(index, { disabledAt: null, disabledReason: null, disabledStatus: null });
            return true;
        },
        getCanonicalIndex: index => index,
        getRotationIndices: () => indices.filter(index => !disabled.has(index)),
        getStatusMetadata: index =>
            statusMap.get(index) || { disabledAt: null, disabledReason: null, disabledStatus: null },
        isDisabled: index => disabled.has(index),
        isExpired: () => false,
        isUnavailable: index => disabled.has(index),
    };

    const connectionRegistry = {
        closeConnectionByAuth: index => {
            counters.closeConnection += 1;
            connections.delete(index);
        },
        closeMessageQueuesForAuth: () => {
            counters.closeQueues += 1;
        },
        getAllConnections: () => connections,
        getAuthIndexForRequest: () => 1,
        getConnectionByAuth: index => connections.get(index) || null,
        getRequestAttemptIdForRequest: () => null,
    };

    const contexts = new Map(
        indices.map(index => [index, { page: { isClosed: () => false } }])
    );
    const browserManager = {
        _checkPageStatusAndErrors: async () => true,
        _withContextPoolMutation: task => task(),
        closeContext: async index => {
            counters.closeContext += 1;
            contexts.delete(index);
        },
        contexts,
        currentAuthIndex: 1,
        launchOrSwitchContext: async () => {
            counters.launches += 1;
            return true;
        },
        probeAccountIsolated: async () => true,
        rebalanceContextPool: async () => {
            counters.rebalance += 1;
        },
    };

    const config = {
        accountCooldownMaxMs: 60000,
        accountCooldownMs: 1000,
        autoDisableStatusCodes: [401, 403, 429],
        failureThreshold: 1,
        immediateSwitchStatusCodes: [429, 503],
        maxContexts: 3,
        maxRetries: 1,
        retryDelay: 0,
        switchOnUses: 0,
    };

    const handler = new RequestHandler(
        {},
        connectionRegistry,
        logger,
        browserManager,
        config,
        authSource
    );
    handler.accountRouteState.clear();
    handler.accountRouteStatePath = path.join(tempRoot, `route-state-${Math.random().toString(36).slice(2)}.json`);

    return {
        authSource,
        browserManager,
        config,
        connectionRegistry,
        connections,
        counters,
        disabled,
        handler,
        statusMap,
    };
}

async function waitForQuotaCleanup(handler, authIndex) {
    const pending = handler.accountDisableCleanup.get(authIndex);
    if (pending) await pending;
    await handler.accountRouteStateWrite;
}

async function testSingleFlightAndReasonPrecedence() {
    const h = makeHarness();
    const startedAt = Date.now();
    const quota = {
        message: "429 RESOURCE_EXHAUSTED",
        retryAfter: 3600,
        status: 429,
    };

    h.handler._markImmediateRateLimitIfNeeded(1, "gemini-quota-model", quota);
    h.handler._markImmediateRateLimitIfNeeded(1, "gemini-quota-model", quota);
    await waitForQuotaCleanup(h.handler, 1);

    const state = h.handler._getAccountRouteState(1);
    assert.strictEqual(h.counters.disable, 1, "duplicate observations must share one disable operation");
    assert.strictEqual(
        h.authSource.getStatusMetadata(1).disabledReason,
        "quota_exhausted",
        "429 must win over a configured generic http_429 auto-disable"
    );
    assert.strictEqual(state.modelRateLimitHits["gemini-quota-model"], 1, "one 429 must record one hit");
    assert.ok(
        state.quotaDisabledUntil >= startedAt + 3599000,
        "quota window must honor Retry-After when it exceeds the fixed minimum"
    );
    assert.ok(h.handler.getNextCooldownMs("another-model") > 3500000, "pool Retry-After must include quota window");
}

async function testFinalFailureUsesUnifiedBreaker() {
    const h = makeHarness();
    const result = await h.handler._handleRequestFailureScoped(
        { message: "final 429", status: 429 },
        "request-final",
        1
    );
    await waitForQuotaCleanup(h.handler, 1);

    assert.strictEqual(h.counters.disable, 1, "final-failure path must trip the breaker");
    assert.strictEqual(h.authSource.getStatusMetadata(1).disabledReason, "quota_exhausted");
    assert.strictEqual(result.switched, true, "the failed request should bind to another ready account");
    assert.strictEqual(result.newIndex, 2);
}

async function testNonStreamRetryExecutorUsesUnifiedBreaker() {
    const h = makeHarness();
    h.handler._forwardRequest = () => {};
    h.handler._cancelCurrentAttemptBeforeRetry = () => {};
    const queue = {
        dequeue: async () => ({
            event_type: "error",
            message: "non-stream 429",
            status: 429,
        }),
    };
    const proxyRequest = {
        is_generative: true,
        path: "/models/gemini-quota-model:generateContent",
        request_attempt_id: "request-nonstream_attempt_1",
        request_id: "request-nonstream",
    };

    const result = await h.handler._executeRequestWithRetries(proxyRequest, queue);
    await waitForQuotaCleanup(h.handler, 1);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.status, 429);
    assert.strictEqual(h.counters.disable, 1, "non-stream retry executor must trip the breaker");
    assert.strictEqual(h.authSource.getStatusMetadata(1).disabledReason, "quota_exhausted");
}

async function testQuotaStateBlocksEveryModelWhenPersistenceFails() {
    const h = makeHarness({ disableSucceeds: false });
    h.handler._markImmediateRateLimitIfNeeded(1, "model-a", {
        message: "quota write failed",
        retryAfter: 1800,
        status: 429,
    });
    await waitForQuotaCleanup(h.handler, 1);

    assert.strictEqual(h.disabled.has(1), false, "fixture must leave auth enabled when disable persistence fails");
    assert.ok(h.handler._getAccountRouteState(1).quotaDisabledUntil > Date.now());
    assert.strictEqual(
        h.handler._selectRequestAuthIndex([], "model-b"),
        2,
        "quotaDisabledUntil must block the whole credential, not only the model that returned 429"
    );
}

async function testAccountDiagnosticUsesUnifiedBreaker() {
    const h = makeHarness();
    h.browserManager._checkPageStatusAndErrors = async () => {
        const error = new Error("diagnostic 429");
        error.status = 429;
        throw error;
    };

    const result = await h.handler.testAccount(1);
    await waitForQuotaCleanup(h.handler, 1);

    assert.strictEqual(result.status, 429);
    assert.strictEqual(result.success, false);
    assert.strictEqual(h.counters.disable, 1, "account diagnostic 429 must trip the same breaker");
    assert.strictEqual(h.authSource.getStatusMetadata(1).disabledReason, "quota_exhausted");
}

async function testSuccessfulQuotaHealIsPersisted() {
    const h = makeHarness({ disabled: [1] });
    const state = h.handler._getAccountRouteState(1);
    state.quotaDisabledUntil = 0;
    state.quotaProbeEpisodes = 4;

    const result = await h.handler._probeAndRestoreAccount(1, "quota_exhausted");
    await h.handler.accountRouteStateWrite;
    const saved = JSON.parse(fs.readFileSync(h.handler.accountRouteStatePath, "utf8"));

    assert.strictEqual(result.restored, true);
    assert.strictEqual(saved.accounts["1"].quotaDisabledUntil, 0);
    assert.strictEqual(saved.accounts["1"].quotaProbeEpisodes, 0);
}

function testNoBypassCallsitesRemain() {
    const count = pattern => (sourceText.match(pattern) || []).length;
    assert.strictEqual(
        count(/_markAccount429ForModel\(/g),
        4,
        "direct 429 marking should remain in its definition, compatibility wrapper, and the two unified-breaker branches"
    );
    assert.strictEqual(
        count(/_quotaExhaustDisableAccount\(/g),
        2,
        "quota shutdown should be called only by the unified breaker"
    );
    assert.strictEqual(
        count(/_autoDisableAccountForStatus\(/g),
        2,
        "generic auto-disable should be called only after the unified breaker declines the status"
    );
    assert.strictEqual(
        count(/_markImmediateRateLimitIfNeeded\(/g),
        8,
        "all four real-stream observers, non-stream retries, final failures, and diagnostics must share one entrypoint"
    );
}

(async () => {
    try {
        testNoBypassCallsitesRemain();
        await testSingleFlightAndReasonPrecedence();
        await testFinalFailureUsesUnifiedBreaker();
        await testNonStreamRetryExecutorUsesUnifiedBreaker();
        await testQuotaStateBlocksEveryModelWhenPersistenceFails();
        await testAccountDiagnosticUsesUnifiedBreaker();
        await testSuccessfulQuotaHealIsPersisted();
        console.log("unified quota breaker tests: PASS");
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempRoot, { force: true, recursive: true });
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
