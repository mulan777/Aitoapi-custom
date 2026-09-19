// Regression test: repeated crash-loop episodes auto-disable an account, the AutoHeal
// probe restores only healthy accounts, rolls back on failure, and stops probing an
// account after WS_CRASH_MAX_EPISODES.
//
// The auth mock mirrors AuthSource's real public surface: account state is read through
// getStatusMetadata (getAccountStatus does not exist on AuthSource).
//
// Run it from a directory without a data/account-route-state.json (e.g. `npm run
// test:crashloop-autoheal` from the repo root) so restored production state cannot
// influence the assertions.
const assert = require("assert");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const conns = new Map();
const mockConnectionRegistry = {
    getAllConnections: () => conns,
    getConnectionByAuth: () => ({ readyState: 1 }),
};

const statusMap = new Map();
const mockAuthSource = {
    availableIndices: [68, 69, 70, 71, 72, 73, 74],
    disabled: new Set(),
    disableCalls: 0,
    enableCalls: 0,
    getRotationIndices: () =>
        mockAuthSource.availableIndices.filter(i => !mockAuthSource.disabled.has(i)),
    getCanonicalIndex: i => i,
    getStatusMetadata: i =>
        statusMap.get(i) || { disabledAt: null, disabledReason: null, disabledStatus: null },
    disableAuth: async (i, metadata = {}) => {
        mockAuthSource.disableCalls += 1;
        mockAuthSource.disabled.add(i);
        statusMap.set(i, {
            disabledAt: new Date().toISOString(),
            disabledReason: metadata.reason || "manual",
            disabledStatus: null,
        });
        return true;
    },
    enableAuth: async i => {
        mockAuthSource.enableCalls += 1;
        mockAuthSource.disabled.delete(i);
        statusMap.set(i, { disabledAt: null, disabledReason: null, disabledStatus: null });
        return true;
    },
    isDisabled: i => mockAuthSource.disabled.has(i),
    isUnavailable: i => mockAuthSource.disabled.has(i),
    isExpired: () => false,
};

const mockBrowserManager = {
    contexts: new Map(),
    currentAuthIndex: 70,
    browser: { isConnected: () => true },
    closeContext: async i => {
        mockBrowserManager.contexts.delete(i);
    },
    // v1.2.6: the probe uses an ISOLATED throwaway browser instead of the pool.
    probeAccountIsolated: async i => {
        if (i === 68) throw new Error("WebSocket not initialized within 600s"); // simulated probe failure
        return true;
    },
    replaceContextForAuth: async () => true,
    rebalanceContextPool: async () => {},
};

const mockConfig = { maxContexts: 3, switchOnUses: 20 };

function makeHandler() {
    return new RequestHandler(
        {},
        mockConnectionRegistry,
        logger,
        mockBrowserManager,
        mockConfig,
        mockAuthSource
    );
}

async function main() {
    // One handler for the whole scenario: the crash-loop counters live on the handler,
    // so episodes accumulate across disconnects exactly like they do in production.
    const rh = makeHandler();

    // ---- 1. first crash-loop episode quarantines but does not disable ----
    await rh.recordWsDisconnect(70);
    await rh.recordWsDisconnect(70);
    await rh.recordWsDisconnect(70);

    let state = rh._getAccountRouteState(70);
    assert.strictEqual(state.crashLoopEpisodes, 1, "first crash-loop episode must be counted");
    assert.strictEqual(rh._isInWsCrashLoop(70), true, "first episode must quarantine the account");
    assert.strictEqual(
        mockAuthSource.isDisabled(70),
        false,
        "a single episode must NOT auto-disable the account"
    );

    // ---- 2. second episode auto-disables and drops the account out of rotation ----
    mockBrowserManager.contexts.set(70, { page: { isClosed: () => false } }); // context still alive
    const disablesBefore = mockAuthSource.disableCalls;

    await rh.recordWsDisconnect(70);
    await rh.recordWsDisconnect(70);
    await rh.recordWsDisconnect(70);

    state = rh._getAccountRouteState(70);
    assert.strictEqual(state.crashLoopEpisodes, 2, "second crash-loop episode must be counted");
    assert.strictEqual(mockAuthSource.isDisabled(70), true, "second episode must auto-disable the account");
    assert.strictEqual(
        mockAuthSource.disableCalls - disablesBefore,
        1,
        "later drops must short-circuit instead of re-disabling the account"
    );
    assert.strictEqual(
        mockAuthSource.getStatusMetadata(70).disabledReason,
        "crash_loop",
        "auto-disable must be recorded with disabledReason=crash_loop"
    );
    assert.strictEqual(mockBrowserManager.contexts.has(70), false, "auto-disable must close the browser context");
    assert.strictEqual(
        mockAuthSource.getRotationIndices().includes(70),
        false,
        "auto-disabled account must leave the rotation"
    );

    // ---- 3. probe skips still-quarantined accounts; over-probed accounts are STILL probed ----
    await mockAuthSource.disableAuth(68, { reason: "crash_loop" });
    const exhausted = rh._getAccountRouteState(68);
    exhausted.crashLoopEpisodes = 3; // past the old WS_CRASH_MAX_EPISODES — still probed (never give up)
    exhausted.wsCrashLoopUntil = 0;
    exhausted.autoHealNextProbeAt = Date.now() - 1;

    // #70 is disabled as crash_loop but still inside its quarantine window.
    const enablesBefore = mockAuthSource.enableCalls;
    await rh._runAutoHealProbe();
    // #68's window elapsed so it WAS probed (never give up) — but the mock probe
    // fails for #68, so it stays disabled and costs one more episode (3 -> 4).
    assert.strictEqual(
        mockAuthSource.enableCalls,
        enablesBefore,
        "a failed probe must not enable the account"
    );
    assert.strictEqual(
        rh._getAccountRouteState(68).crashLoopEpisodes,
        4,
        "over-probed account must STILL be probed (episode incremented) — probing never gives up"
    );
    assert.strictEqual(mockAuthSource.isDisabled(70), true, "quarantined account stays disabled");

    // ---- 4. probe restores a healthy account once the quarantine window elapsed ----
    rh._getAccountRouteState(70).wsCrashLoopUntil = 0;
    rh._getAccountRouteState(70).autoHealNextProbeAt = Date.now() - 1;
    await rh._runAutoHealProbe();

    assert.strictEqual(mockAuthSource.isDisabled(70), false, "a healthy account must be restored to rotation");
    assert.strictEqual(
        mockAuthSource.getRotationIndices().includes(70),
        true,
        "restored account must return to the rotation"
    );
    state = rh._getAccountRouteState(70);
    assert.strictEqual(state.crashLoopEpisodes, 0, "successful probe must clear the episode counter");
    assert.strictEqual(state.wsDropCount, 0, "successful probe must clear the drop counter");

    // ---- 5. failed isolated probe rolls the account back to disabled ----
    const retry = rh._getAccountRouteState(68);
    retry.crashLoopEpisodes = 0;
    retry.wsCrashLoopUntil = 0;
    await mockAuthSource.disableAuth(68, { reason: "crash_loop" });

    const result = await rh._probeAndRestoreAccount(68);
    assert.strictEqual(result.restored, false, "a failed probe must not restore the account");
    assert.strictEqual(
        result.reason,
        "WebSocket not initialized within 600s",
        "probe failure must surface the underlying error"
    );
    assert.strictEqual(mockAuthSource.isDisabled(68), true, "failed probe must roll the account back to disabled");
    assert.strictEqual(
        rh._getAccountRouteState(68).crashLoopEpisodes,
        1,
        "a failed probe must count as one episode"
    );
}

(async () => {
    await main();
    console.log("crash-loop auto-heal tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
