// Regression test: a single upstream HTTP 429 temporarily disables the credential
// (quota circuit breaker), the pool switches to other credentials, and the AutoHeal
// probe restores it after the quota window only if it can serve again.
//
// Expected behaviours covered (v1.2.6 semantics):
//   1. _quotaExhaustDisableAccount disables with disabledReason=quota_exhausted,
//      closes the context, drops the account from rotation and records the window.
//   2. Repeated 429s short-circuit (no duplicate disable / single-flight).
//   3. _markImmediateRateLimitIfNeeded(429) triggers the breaker; non-429 does not.
//   4. The probe skips quota-disabled accounts still inside their window; accounts
//      that failed many probes are STILL probed (probing never gives up).
//   5. Once the window elapsed, a healthy account is restored and counters reset.
//   6. A failed isolated probe keeps the account disabled and costs one episode.
//
// The auth mock mirrors AuthSource's real public surface (getStatusMetadata exists,
// getAccountStatus does not). Run from the repo root; the handler's route-state is
// redirected to a temp file so no production data is touched.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const conns = new Map();
const mockConnectionRegistry = {
    getAllConnections: () => conns,
    getConnectionByAuth: () => ({ readyState: 1 }),
    closeConnectionByAuth: () => {},
    closeMessageQueuesForAuth: () => {},
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
            disabledStatus: metadata.status ?? null,
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
    isUnavailable: i => mockAuthSource.disabled.has(i) || mockAuthSource.expired?.has(i),
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
    launchOrSwitchContext: async () => true,
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
    const tmpPath = path.join(os.tmpdir(), `aitoapi-quota-test-${process.pid}.json`);
    rh.accountRouteStatePath = tmpPath; // never touch production route state

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // ---- 1. single 429 -> temporary disable (quota_exhausted) ----
        mockBrowserManager.contexts.set(70, { page: { isClosed: () => false } });
        await rh._quotaExhaustDisableAccount(70, {
            status: 429,
            message: "Google API returned error: 429 RESOURCE_EXHAUSTED quota",
        });

        assert.strictEqual(mockAuthSource.isDisabled(70), true, "429 must disable the account");
        assert.strictEqual(
            mockAuthSource.getStatusMetadata(70).disabledReason,
            "quota_exhausted",
            "disable reason must be quota_exhausted"
        );
        assert.strictEqual(
            mockAuthSource.getStatusMetadata(70).disabledStatus,
            429,
            "disable status must be recorded"
        );
        assert.ok(
            rh._getAccountRouteState(70).quotaDisabledUntil > Date.now(),
            "quota window must be set into the future"
        );
        assert.strictEqual(
            mockBrowserManager.contexts.has(70),
            false,
            "quota disable must close the browser context"
        );
        assert.strictEqual(
            mockAuthSource.getRotationIndices().includes(70),
            false,
            "quota-disabled account must leave the rotation -> pool switches to other credentials"
        );

        // ---- 2. repeated 429s short-circuit (single-flight / already disabled) ----
        const disablesBefore = mockAuthSource.disableCalls;
        await rh._quotaExhaustDisableAccount(70, {
            status: 429,
            message: "again 429",
        });
        assert.strictEqual(
            mockAuthSource.disableCalls,
            disablesBefore,
            "repeated 429s must not re-disable the account"
        );

        // ---- 3. integrated path: _markImmediateRateLimitIfNeeded(429) triggers breaker; 503 does not ----
        await mockAuthSource.enableAuth(71);
        mockBrowserManager.contexts.set(71, { page: { isClosed: () => false } });
        const callDisables = mockAuthSource.disableCalls;
        rh._markImmediateRateLimitIfNeeded(71, "gemini-3.8-flash", {
            status: 429,
            message: "429 RESOURCE_EXHAUSTED",
        });
        await sleep(50); // the breaker is fire-and-forget
        assert.strictEqual(
            mockAuthSource.disableCalls - callDisables,
            1,
            "429 through the retry path must trip the quota breaker"
        );
        assert.strictEqual(
            mockAuthSource.getStatusMetadata(71).disabledReason,
            "quota_exhausted",
            "breaker must use quota_exhausted reason"
        );

        await mockAuthSource.enableAuth(72);
        mockBrowserManager.contexts.set(72, { page: { isClosed: () => false } });
        const non429Disables = mockAuthSource.disableCalls;
        rh._markImmediateRateLimitIfNeeded(72, "gemini-3.8-flash", {
            status: 503,
            message: "Service unavailable",
        });
        await sleep(50);
        assert.strictEqual(
            mockAuthSource.disableCalls,
            non429Disables,
            "a 503 must not trip the quota breaker (only 401/403 auto-disable applies)"
        );

        // ---- 4. probe skips in-window accounts; over-probed accounts are STILL probed ----
        await mockAuthSource.disableAuth(73, { reason: "quota_exhausted", status: 429 });
        rh._getAccountRouteState(73).quotaDisabledUntil = Date.now() + 1200000; // in-window
        rh._getAccountRouteState(73).autoHealNextProbeAt = rh._getAccountRouteState(73).quotaDisabledUntil;
        rh._getAccountRouteState(73).quotaProbeEpisodes = 0;

        await mockAuthSource.disableAuth(74, { reason: "quota_exhausted", status: 429 });
        rh._getAccountRouteState(74).quotaDisabledUntil = 0; // window elapsed
        rh._getAccountRouteState(74).autoHealNextProbeAt = Date.now() - 1;
        rh._getAccountRouteState(74).quotaProbeEpisodes = 3; // past the old max — still probed (never give up)

        const enablesBefore = mockAuthSource.enableCalls;
        await rh._runAutoHealProbe();
        assert.strictEqual(
            mockAuthSource.enableCalls,
            enablesBefore + 1, // #74 was probed (and restored by the mock), only the window skip applied to #73
            "window-elapsed accounts must be probed regardless of past failed episodes"
        );
        assert.strictEqual(mockAuthSource.isDisabled(73), true, "in-window account stays disabled");

        // ---- 5. healthy account is restored once the window elapsed ----
        await mockAuthSource.disableAuth(69, { reason: "quota_exhausted", status: 429 });
        rh._getAccountRouteState(69).quotaDisabledUntil = 0;
        rh._getAccountRouteState(69).autoHealNextProbeAt = Date.now() - 1;
        rh._getAccountRouteState(69).quotaProbeEpisodes = 0;

        await rh._runAutoHealProbe();
        assert.strictEqual(mockAuthSource.isDisabled(69), false, "healthy account must be restored");
        assert.strictEqual(
            mockAuthSource.getRotationIndices().includes(69),
            true,
            "restored account must return to the rotation"
        );
        const state69 = rh._getAccountRouteState(69);
        assert.strictEqual(state69.quotaProbeEpisodes, 0, "successful probe must clear probe episodes");
        assert.strictEqual(state69.quotaDisabledUntil, 0, "successful probe must clear the quota window");

        // ---- 6. failed isolated probe keeps the account disabled and costs one episode ----
        await mockAuthSource.disableAuth(68, { reason: "quota_exhausted", status: 429 });
        rh._getAccountRouteState(68).quotaDisabledUntil = 0;
        rh._getAccountRouteState(68).autoHealNextProbeAt = Date.now() - 1;
        rh._getAccountRouteState(68).quotaProbeEpisodes = 0;

        const result = await rh._probeAndRestoreAccount(68, "quota_exhausted");
        assert.strictEqual(result.restored, false, "a failed probe must not restore the account");
        assert.strictEqual(
            result.reason,
            "WebSocket not initialized within 600s",
            "probe failure must surface the underlying error"
        );
        assert.strictEqual(mockAuthSource.isDisabled(68), true, "failed probe must keep the account disabled");
        assert.strictEqual(
            mockAuthSource.getStatusMetadata(68).disabledReason,
            "quota_exhausted",
            "rollback must keep quota_exhausted reason"
        );
        assert.strictEqual(
            rh._getAccountRouteState(68).quotaProbeEpisodes,
            1,
            "a failed quota probe must count as one episode"
        );
    } finally {
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            /* ignore */
        }
    }
}

(async () => {
    await main();
    console.log("quota circuit-breaker tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
