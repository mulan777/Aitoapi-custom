// Regression test: browser WebSocket crash-loop quarantine excludes the bad account
// from routing selection, recovery fallback and rotation switching.
const assert = require("assert");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} };

const conns = new Map();
const mockConnectionRegistry = {
    getAllConnections: () => conns,
    getConnectionByAuth: () => ({ readyState: 1 }),
};

const mockBrowserManager = {
    browser: { isConnected: () => true },
    contexts: new Map([68, 69, 70, 71, 72, 73, 74].map(index => [index, { page: { isClosed: () => false } }])),
    currentAuthIndex: 70,
    rebalanceContextPool: async () => {},
    replaceContextForAuth: async () => true,
    setConnectionRegistry: () => {},
    setSystemBusyProvider: () => {},
};

const mockConfig = { maxContexts: 3, switchOnUses: 20 };
const mockAuthSource = {
    availableIndices: [68, 69, 70, 71, 72, 73, 74],
    getCanonicalIndex: i => i,
    getRotationIndices: () => [68, 69, 70, 71, 72, 73, 74],
    isExpired: () => false,
    isUnavailable: () => false,
};

async function testQuarantineExcludesAccountFromRouting() {
    const rh = new RequestHandler({}, mockConnectionRegistry, logger, mockBrowserManager, mockConfig, mockAuthSource);

    assert.strictEqual(rh._isInWsCrashLoop(70), false, "account must start healthy");

    rh.recordWsDisconnect(70);
    assert.strictEqual(rh._isInWsCrashLoop(70), false, "a single drop must not quarantine an account");

    rh.recordWsDisconnect(70);
    await rh.recordWsDisconnect(70);
    assert.strictEqual(rh._isInWsCrashLoop(70), true, "3 drops inside the window must quarantine the account");

    const state = rh._getAccountRouteState(70);
    assert.ok(state.wsCrashLoopUntil > Date.now(), "quarantine window must end in the future");

    conns.set(70, { readyState: 1 });
    assert.strictEqual(
        rh._selectRequestAuthIndex(),
        -1,
        "a quarantined account must never be selected, even as the only connected one"
    );

    conns.set(71, { readyState: 1 });
    assert.strictEqual(rh._selectRequestAuthIndex(), 71, "routing must prefer the healthy account");

    conns.delete(71);
    assert.strictEqual(
        rh._selectRequestAuthIndex(),
        -1,
        "the current-account fallback must also skip a quarantined account"
    );
    conns.set(71, { readyState: 1 });

    const switcher = rh.authSwitcher;
    assert.strictEqual(switcher.crashLoopChecker(70), true, "AuthSwitcher must see #70 as quarantined");
    assert.strictEqual(switcher.crashLoopChecker(71), false, "AuthSwitcher must see #71 as healthy");

    const result = await switcher.switchToNextAuth();
    assert.strictEqual(result.success, true, "rotation switch must succeed");
    assert.notStrictEqual(result.newIndex, 70, "rotation must not land back on the quarantined account");
}

(async () => {
    await testQuarantineExcludesAccountFromRouting();
    console.log("crash-loop quarantine tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
