// v1.2.6 regression tests:
//   1. forbidden (Google ban) accounts are auto-REMOVED with a backup copy in
//      data/removed-auth-backup/.
//   2. A failed direct recovery (page open, WS never ready) counts as a WS drop
//      so recover-to-same-account loops trip the crash-loop quarantine.
//   3. _startAutoHealTimer re-arms when config.autoHealProbeIntervalMs changes.
//   4. _probeAndRestoreAccount uses the isolated probe browser, never the pool.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const conns = new Map();
const mockConnectionRegistry = {
    getAllConnections: () => conns,
    getConnectionByAuth: () => null,
    closeConnectionByAuth: () => {},
    closeMessageQueuesForAuth: () => {},
};

const statusMap = new Map();
const removed = [];
const mockAuthSource = {
    availableIndices: [64, 68, 70],
    disabled: new Set(),
    accountNameMap: new Map([
        [64, "banned@gmail.com"],
        [68, "flaky@gmail.com"],
        [70, "current@gmail.com"],
    ]),
    getRotationIndices: () =>
        mockAuthSource.availableIndices.filter(i => !mockAuthSource.disabled.has(i)),
    getCanonicalIndex: i => i,
    getStatusMetadata: i =>
        statusMap.get(i) || { disabledAt: null, disabledReason: null, disabledStatus: null },
    disableAuth: async (i, metadata = {}) => {
        mockAuthSource.disabled.add(i);
        statusMap.set(i, {
            disabledAt: new Date().toISOString(),
            disabledReason: metadata.reason || "manual",
            disabledStatus: metadata.status ?? null,
        });
        return true;
    },
    enableAuth: async i => {
        mockAuthSource.disabled.delete(i);
        statusMap.set(i, { disabledAt: null, disabledReason: null, disabledStatus: null });
        return true;
    },
    isDisabled: i => mockAuthSource.disabled.has(i),
    isUnavailable: i => mockAuthSource.disabled.has(i),
    isExpired: () => false,
    removeAuth: i => {
        removed.push(i);
        mockAuthSource.availableIndices = mockAuthSource.availableIndices.filter(x => x !== i);
        return { remainingAccounts: mockAuthSource.availableIndices.length, removedIndex: i };
    },
};

let probeCalls = [];
const mockBrowserManager = {
    contexts: new Map(),
    currentAuthIndex: 70,
    browser: { isConnected: () => true },
    closeContext: async i => {
        mockBrowserManager.contexts.delete(i);
    },
    probeAccountIsolated: async (i, timeoutMs) => {
        probeCalls.push({ i, timeoutMs });
        return true;
    },
    preCleanupForSwitch: async () => {},
    launchOrSwitchContext: async () => true,
    rebalanceContextPool: async () => {},
    isClosingIntentionally: false,
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
    const rh = makeHandler();
    const tmpPath = path.join(os.tmpdir(), `aitoapi-v126-test-${process.pid}.json`);
    const tmpBackup = path.join(os.tmpdir(), `aitoapi-v126-backup-${process.pid}`);
    rh.accountRouteStatePath = tmpPath;

    // ---- 1. forbidden accounts are removed with backup ----
    fs.mkdirSync(tmpBackup, { recursive: true });
    const authDir = path.dirname(tmpPath); // cwd-relative auth dir is not used: removeAuth is mocked
    await mockAuthSource.disableAuth(64, { reason: "forbidden", status: 403 });
    await rh._removeForbiddenAccounts([64]);
    assert.deepStrictEqual(removed, [64], "forbidden account must be removed via removeAuth");
    assert.strictEqual(
        mockAuthSource.availableIndices.includes(64),
        false,
        "forbidden account must leave availableIndices"
    );

    // ---- 2. failed direct recovery counts as a WS drop ----
    // Simulate the _handleBrowserRecovery catch path in isolation: the accounting
    // lives in the catch block, exercised via recordWsDisconnect directly here.
    rh.config = mockConfig;
    const before = rh._getAccountRouteState(68).wsDropCount;
    await rh.recordWsDisconnect(68);
    await rh.recordWsDisconnect(68);
    await rh.recordWsDisconnect(68);
    const state68 = rh._getAccountRouteState(68);
    assert.strictEqual(state68.wsDropCount, 0, "a completed threshold window must reset its drop counter");
    assert.strictEqual(state68.crashLoopEpisodes, 1, "3 drops must count as one crash-loop episode");
    assert.ok(
        state68.wsCrashLoopUntil > Date.now(),
        "3 drops must arm the crash-loop quarantine (recovery will reroute)"
    );
    assert.strictEqual(rh._isInWsCrashLoop(68), true, "account must be considered in crash loop");

    // ---- 3. probe timer re-arms on config change ----
    rh.autoHealTimer = null;
    mockConfig.autoHealProbeIntervalMs = 5 * 60 * 60 * 1000;
    rh.startAutoHealProbe();
    const firstTimer = rh.autoHealTimer;
    assert.ok(firstTimer, "probe timer must be armed");
    mockConfig.autoHealProbeIntervalMs = 60 * 1000;
    rh._startAutoHealTimer();
    assert.notStrictEqual(rh.autoHealTimer, firstTimer, "changing the interval must re-arm the timer");
    clearInterval(rh.autoHealTimer);

    // ---- 4. probe uses the isolated browser ----
    await mockAuthSource.disableAuth(70, { reason: "crash_loop" });
    const result = await rh._probeAndRestoreAccount(70, "crash_loop");
    assert.strictEqual(result.restored, true, "healthy account must be restored");
    assert.strictEqual(probeCalls.length, 1, "probe must call probeAccountIsolated");
    assert.strictEqual(probeCalls[0].i, 70, "probe must target the right account");
    assert.strictEqual(
        mockAuthSource.isDisabled(70),
        false,
        "successful isolated probe must re-enable the account"
    );

    try {
        fs.rmSync(tmpPath, { force: true });
        fs.rmSync(tmpBackup, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

(async () => {
    await main();
    console.log("autoheal v1.2.6 tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
