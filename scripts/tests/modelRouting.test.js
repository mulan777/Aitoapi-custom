const assert = require("assert");
const RequestHandler = require("../../src/core/RequestHandler");

function makeHandler(config = {}) {
    const connections = new Map(
        [0, 1, 2].map(index => [
            index,
            {
                readyState: 1,
                send() {},
            },
        ])
    );
    const handler = Object.create(RequestHandler.prototype);
    handler.connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: index => connections.get(index),
    };
    handler.browserManager = {
        contexts: new Map([0, 1, 2].map(index => [index, { page: { isClosed: () => false } }])),
    };
    handler.authSource = {
        availableIndices: [0, 1, 2],
        getModelGroups: index => (index === 0 ? ["pro"] : index === 1 ? ["flash"] : []),
        isUnavailable: () => false,
        isExpired: () => false,
    };
    handler.logger = { debug() {}, info() {}, warn() {}, error() {} };
    handler.requestRouteCursor = 0;
    handler.accountRouteState = new Map();
    handler.requestAuthBindings = new Map();
    handler.requestModelBindings = new Map();
    handler.requestFailureCounts = new Map();
    handler.pendingUsageRotations = new Set();
    handler.accountDisableCleanup = new Map();
    handler.config = {
        accountCooldownMs: 1000,
        accountCooldownMaxMs: 30000,
        autoDisableStatusCodes: [401, 403],
        immediateSwitchStatusCodes: [429, 503],
        ...config,
    };
    handler.authSwitcher = { failureCount: 0, currentAuthIndex: 0 };
    return handler;
}

function testNamedGroupRouting() {
    const handler = makeHandler({
        modelRouting: {
            enabled: true,
            strict: true,
            groups: [
                { id: "pro", patterns: ["gemini-3.1-pro"], authIndices: [0] },
                { id: "flash", patterns: ["gemini-3.7-flash", "gemini-3.8-flash"], authIndices: [1] },
            ],
        },
    });
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.1-pro"), 0);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.7-flash"), 1);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.8-flash"), 1);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-2.5-pro"), -1);
}

function testAllowlistWildcards() {
    const handler = makeHandler({
        modelPoolMode: "allowlist",
        modelPoolAllowlist: ["gemini-3.7-*"],
    });
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.7-flash"), 0);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.8-flash"), -1);
    assert.strictEqual(handler._getModelRoutingConfig().strict, true);
}

async function test429DoesNotDisableCredentialInPartitionedPool() {
    const handler = makeHandler({
        modelRouting: {
            enabled: true,
            strict: true,
            groups: [
                { id: "flash", patterns: ["gemini-3.7-*"], authIndices: [0, 1] },
                { id: "pro", patterns: ["gemini-3.1-pro"], authIndices: [0] },
            ],
        },
    });
    let disableCalls = 0;
    handler.authSource.disableAuth = async () => {
        disableCalls += 1;
        return true;
    };
    handler.authSource.isDisabled = () => false;
    handler._markImmediateRateLimitIfNeeded(0, "gemini-3.7-flash", { status: 429, message: "quota" });
    assert.strictEqual(disableCalls, 0, "model quota must not persistently disable the credential");
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.7-flash"), -1);
    // The same credential remains eligible for another configured group.
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-3.1-pro"), 0);
}

function testCompactAllModeRemainsUnrestricted() {
    const handler = makeHandler({
        modelPoolMode: "all",
        modelPoolAllowlist: ["gemini-3.7-flash"],
        modelRouting: { mode: "all", allowlist: ["gemini-3.7-flash"] },
    });
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-2.5-pro"), 0);
}

(async () => {
    testNamedGroupRouting();
    testAllowlistWildcards();
    await test429DoesNotDisableCredentialInPartitionedPool();
    testCompactAllModeRemainsUnrestricted();
    console.log("model routing tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
