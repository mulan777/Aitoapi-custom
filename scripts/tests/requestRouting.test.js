const assert = require("assert");
const RequestHandler = require("../../src/core/RequestHandler");

const makeHandler = () => {
    const connections = new Map([
        [
            0,
            {
                readyState: 1,
                send(payload) {
                    this.sent.push(payload);
                },
                sent: [],
            },
        ],
        [
            1,
            {
                readyState: 1,
                send(payload) {
                    this.sent.push(payload);
                },
                sent: [],
            },
        ],
    ]);

    const handler = Object.create(RequestHandler.prototype);
    handler.connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: authIndex => connections.get(authIndex),
    };
    handler.logger = { debug() {}, info() {}, warn() {} };
    handler.requestAuthBindings = new Map();
    handler.requestModelBindings = new Map();
    handler.requestRouteCursor = 0;
    handler.requestFailureCounts = new Map();
    handler.accountRouteState = new Map();
    handler.pendingUsageRotations = new Set();
    handler.usageRotationPromise = null;
    handler.config = {
        accountCooldownMaxMs: 30000,
        accountCooldownMs: 1000,
        failureThreshold: 1,
        immediateSwitchStatusCodes: [429, 503],
    };
    handler.authSwitcher = {
        called: false,
        currentAuthIndex: 0,
        handleRequestFailureAndSwitch() {
            this.called = true;
            return { success: false };
        },
    };
    return { connections, handler };
};

const testRoundRobinAndBinding = () => {
    const { handler } = makeHandler();
    assert.deepStrictEqual([handler._selectRequestAuthIndex(), handler._selectRequestAuthIndex()], [0, 1]);

    handler._bindRequestAuthIndex("request-1", 0);
    handler.authSwitcher.currentAuthIndex = 1;
    assert.strictEqual(handler._getRequestAuthIndex("request-1"), 0);
    handler._releaseRequestAuthIndex("request-1");
    assert.strictEqual(handler._getRequestAuthIndex("request-1"), 1);
};

const testFailureDoesNotGloballySwitch = async () => {
    const { handler } = makeHandler();
    handler._bindRequestAuthIndex("request-2", 0);
    const result = await handler._handleRequestFailureScoped({ message: "busy", status: 429 }, "request-2");

    assert.strictEqual(result.success, true);
    assert.strictEqual(handler._getRequestAuthIndex("request-2"), 1);
    assert.strictEqual(handler.authSwitcher.called, false);
    assert.ok(handler.getAccountRouteStatus(0).cooldownUntil);
    assert.strictEqual(handler._selectRequestAuthIndex(), 1);
};

const testLeastLoadedTieBreak = () => {
    const { handler } = makeHandler();
    handler._bindRequestAuthIndex("long-stream", 0);
    assert.strictEqual(handler._selectRequestAuthIndex(), 1);
};

const test429QuarantinesAccount = () => {
    const { handler } = makeHandler();
    handler._markAccount429(0, { message: "rate limited", status: 429 });
    handler._markAccount429(1, { message: "rate limited", status: 429 });
    assert.strictEqual(handler._selectRequestAuthIndex(), -1);
    assert.ok(handler.getNextCooldownMs() > 0);
    return handler._handleRequestFailureScoped({ message: "rate limited", status: 429 }, "request-4").then(result => {
        assert.strictEqual(result.rateLimited, true);
        assert.strictEqual(handler.authSwitcher.called, false);
    });
};

const test429IsScopedToModel = () => {
    const { handler } = makeHandler();
    handler._markAccount429ForModel(0, "gemini-3.8-flash", { message: "flash quota", status: 429 });

    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.8-flash"), -1);
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.7-flash"), 0);
    assert.ok(handler.getAccountRouteStatus(0).modelCooldowns["gemini-3.8-flash"]);
    assert.strictEqual(handler.getAccountRouteStatus(0).modelCooldowns["gemini-3.7-flash"], undefined);
};

const testModelNormalization = () => {
    const { handler } = makeHandler();
    assert.strictEqual(handler._normalizeRouteModel("models/gemini-3.8-flash-minimal-fake-search"), "gemini-3.8-flash");
    assert.strictEqual(handler._normalizeRouteModel("/gemini-3.7-flash(high)"), "gemini-3.7-flash");
};

const testModel429HelperQuarantinesOnlyModel = () => {
    const { handler } = makeHandler();
    handler._markImmediateRateLimitIfNeeded(0, "gemini-3.8-flash", { message: "quota", status: 429 });
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.8-flash"), -1);
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.7-flash"), 0);
};

const testSuccessResetsTransientFailureState = () => {
    const { handler } = makeHandler();
    handler.requestFailureCounts.set(0, 2);
    handler.authSwitcher.failureCount = 2;
    handler._markAccountSuccess(0, "gemini-3.8-flash");
    assert.strictEqual(handler.requestFailureCounts.has(0), false);
    assert.strictEqual(handler.authSwitcher.failureCount, 0);
};

const testExpiredAndRemovedAccountsAreNotRouted = () => {
    const { handler } = makeHandler();
    handler.authSource = {
        availableIndices: [0, 1],
        isExpired: index => index === 1,
    };
    assert.strictEqual(handler._selectRequestAuthIndex(), 0);
    handler.authSource.availableIndices = [1];
    assert.strictEqual(handler._selectRequestAuthIndex(), -1);
};

const testForwardUsesSelectedAccount = () => {
    const { handler, connections } = makeHandler();
    handler._forwardRequest({ request_attempt_id: "attempt-1", request_id: "request-3" }, 1);
    assert.strictEqual(connections.get(0).sent.length, 0);
    assert.strictEqual(connections.get(1).sent.length, 1);
    assert.strictEqual(JSON.parse(connections.get(1).sent[0]).request_id, "request-3");
};

const testAccountTestPreservesActiveCooldown = async () => {
    const { handler } = makeHandler();
    const page = {
        isClosed: () => false,
    };
    handler.authSource = { availableIndices: [0] };
    handler.browserManager = {
        async _checkPageStatusAndErrors() {},
        contexts: new Map([[0, { page }]]),
        launchCalls: 0,
        async launchOrSwitchContext() {
            this.launchCalls += 1;
        },
    };
    handler._markAccount429(0, { message: "rate limited", status: 429 });
    const before = handler.getAccountRouteStatus(0);

    const result = await handler.testAccount(0);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cooldownPreserved, true);
    assert.strictEqual(handler.browserManager.launchCalls, 0);
    assert.strictEqual(handler.getAccountRouteStatus(0).cooldownUntil, before.cooldownUntil);
};

const testReadyCheckMovesQueuedRequestOffCooldownAccount = async () => {
    const { handler } = makeHandler();
    handler.browserManager = { notifyUserActivity() {} };
    handler._markTrackedEarlyExitIfNeeded = () => {};
    handler._sendErrorResponse = () => {
        throw new Error("unexpected error response");
    };
    handler._bindRequestAuthIndex("request-5", 0);
    handler._markAccount429(0, { message: "rate limited", status: 429 });

    const response = {
        setHeader() {},
    };
    const ready = await handler._ensureBrowserBackedRequestReady(response, {
        authIndex: 0,
        requestId: "request-5",
    });

    assert.strictEqual(ready, true);
    assert.strictEqual(handler._getRequestAuthIndex("request-5"), 1);
};

const testPerAccountUsageRotation = async () => {
    const { handler, connections } = makeHandler();
    handler.config.maxContexts = 5;
    handler.config.switchOnUses = 2;
    handler.authSource = {
        availableIndices: [0, 1, 2, 3, 4, 5],
        getRotationIndices: () => [0, 1, 2, 3, 4, 5],
        isExpired: () => false,
    };
    handler.browserManager = {
        async closeContext(authIndex) {
            this.contexts.delete(authIndex);
            connections.delete(authIndex);
        },
        contexts: new Map([
            [0, {}],
            [1, {}],
            [2, {}],
            [3, {}],
            [4, {}],
        ]),
        async ensureContextForAuth(authIndex) {
            this.contexts.set(authIndex, {});
            connections.set(authIndex, {
                readyState: 1,
                send() {},
            });
            return true;
        },
    };

    handler._bindRequestAuthIndex("pool-request", 0);
    handler._incrementGenerationUsage("pool-request", 0, "test generation");
    const beforeThreshold = handler.getAccountRouteStatus(0);
    assert.strictEqual(beforeThreshold.usageCount, 1);
    assert.strictEqual(beforeThreshold.usageExhausted, false);

    handler._incrementGenerationUsage("pool-request", 0, "test generation");
    assert.strictEqual(handler.getAccountRouteStatus(0).usageExhausted, true);
    handler._releaseRequestAuthIndex("pool-request");
    await handler.usageRotationPromise;

    assert.strictEqual(handler.browserManager.contexts.has(0), false);
    assert.strictEqual(handler.browserManager.contexts.has(5), true);
    assert.strictEqual(handler._selectRequestAuthIndex([], null), 1);
};

(async () => {
    testRoundRobinAndBinding();
    await testFailureDoesNotGloballySwitch();
    testLeastLoadedTieBreak();
    await test429QuarantinesAccount();
    test429IsScopedToModel();
    testModel429HelperQuarantinesOnlyModel();
    testSuccessResetsTransientFailureState();
    testExpiredAndRemovedAccountsAreNotRouted();
    testModelNormalization();
    testForwardUsesSelectedAccount();
    await testAccountTestPreservesActiveCooldown();
    await testReadyCheckMovesQueuedRequestOffCooldownAccount();
    await testPerAccountUsageRotation();
    console.log("request routing tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
