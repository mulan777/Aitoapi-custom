const assert = require("assert");
const fs = require("fs");
const path = require("path");

const RequestHandler = require("../../src/core/RequestHandler");
const ConfigLoader = require("../../src/utils/ConfigLoader");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function createLogger() {
    return {
        debug() {},
        error() {},
        info() {},
        warn() {},
    };
}

function createHandler(overrides = {}) {
    const handler = Object.create(RequestHandler.prototype);
    Object.assign(handler, {
        accountDisableCleanup: new Map(),
        accountRouteState: new Map(),
        accountRouteStatePath: null,
        accountRouteStateWrite: Promise.resolve(),
        authSource: {
            availableIndices: [],
            disableAuth: async () => true,
            enableAuth: async () => true,
            getStatusMetadata: () => ({ disabledAt: null, disabledReason: null }),
            isDisabled: () => false,
        },
        authSwitcher: { isSystemBusy: false },
        autoHealAccountProbes: new Map(),
        autoHealCyclePromise: null,
        autoHealNextRunAt: 0,
        autoHealStopped: true,
        autoHealTimer: null,
        browserManager: {
            probeAccountIsolated: async () => true,
            rebalanceContextPool: async () => {},
        },
        config: {
            autoDisableStatusCodes: [401, 403],
            autoHealBusyRetryMs: 30000,
            autoHealProbeIntervalMs: 300000,
            autoHealProbeTimeoutMs: 600000,
            autoHealStartupDelayMs: 15000,
        },
        connectionRegistry: {},
        logger: createLogger(),
    });
    Object.assign(handler, overrides);
    return handler;
}

async function testCycleSingleFlight() {
    const gate = deferred();
    let runs = 0;
    const handler = createHandler();
    handler._runAutoHealProbeCycle = async () => {
        runs += 1;
        await gate.promise;
    };

    const first = handler._runAutoHealProbe();
    const second = handler._runAutoHealProbe();
    assert.strictEqual(first, second, "overlapping cycle callers must join the same promise");
    await Promise.resolve();
    assert.strictEqual(runs, 1, "only one cycle may execute");
    gate.resolve();
    await Promise.all([first, second]);
    assert.strictEqual(handler.autoHealCyclePromise, null, "cycle lock must be released");
}

async function testAccountSingleFlight() {
    const gate = deferred();
    let launches = 0;
    let enables = 0;
    const handler = createHandler({
        authSource: {
            availableIndices: [7],
            enableAuth: async () => {
                enables += 1;
                return true;
            },
            getStatusMetadata: () => ({ disabledReason: "crash_loop" }),
        },
        browserManager: {
            probeAccountIsolated: async () => {
                launches += 1;
                await gate.promise;
                return true;
            },
            rebalanceContextPool: async () => {},
        },
    });

    const first = handler._probeAndRestoreAccount(7, "crash_loop");
    const second = handler._probeAndRestoreAccount(7, "crash_loop");
    assert.strictEqual(first, second, "same-account probes must share one in-flight promise");
    await Promise.resolve();
    assert.strictEqual(launches, 1, "only one isolated browser may launch for an account");
    gate.resolve();
    const results = await Promise.all([first, second]);
    assert.deepStrictEqual(results, [{ restored: true }, { restored: true }]);
    assert.strictEqual(enables, 1, "the account must only be enabled once");
    assert.strictEqual(handler.autoHealAccountProbes.size, 0, "account lock must be released");
}

async function testStartupAndBusyRetry() {
    let scheduled = null;
    const handler = createHandler({
        config: {
            autoHealBusyRetryMs: 12345,
            autoHealProbeIntervalMs: 300000,
            autoHealProbeTimeoutMs: 600000,
            autoHealStartupDelayMs: 4321,
        },
    });
    handler._scheduleAutoHealProbe = (delayMs, reason) => {
        scheduled = { delayMs, reason };
    };
    handler.startAutoHealProbe();
    assert.deepStrictEqual(scheduled, { delayMs: 4321, reason: "startup_scan" });

    handler.authSwitcher.isSystemBusy = true;
    const before = Date.now();
    const result = await handler._probeAndRestoreAccount(3, "crash_loop");
    const retryAt = handler._getAccountRouteState(3).autoHealNextProbeAt;
    assert.strictEqual(result.reason, "busy");
    assert(retryAt >= before + 12345, "busy retry must use the short retry window");
    assert(retryAt <= Date.now() + 12345, "busy retry must not wait a full probe interval");
}

function testEarliestDueScheduling() {
    const dueAt = Date.now() + 20000;
    let delay = null;
    const handler = createHandler({
        authSource: {
            availableIndices: [2],
            getStatusMetadata: () => ({
                disabledAt: new Date(Date.now() - 60000).toISOString(),
                disabledReason: "quota_exhausted",
            }),
        },
        autoHealStopped: false,
    });
    handler._getAccountRouteState(2).quotaDisabledUntil = dueAt;
    handler._scheduleAutoHealProbe = value => {
        delay = value;
    };
    handler._scheduleNextAutoHealProbe("test");
    assert(delay > 19000 && delay <= 20000, `expected earliest due delay near 20s, got ${delay}`);
}

async function test503NeverPersistsDisable() {
    let disableCalls = 0;
    const handler = createHandler({
        authSource: {
            disableAuth: async () => {
                disableCalls += 1;
                return true;
            },
            isDisabled: () => false,
        },
        config: {
            autoDisableStatusCodes: [401, 403, 503],
        },
    });
    assert.strictEqual(handler._autoDisableAccountForStatus(1, { status: 503 }), false);
    await Promise.resolve();
    assert.strictEqual(disableCalls, 0, "503 must stay transient even in stale persisted settings");

    const loader = new ConfigLoader(createLogger());
    assert.deepStrictEqual(loader._parseStatusCodes("401,503"), [401], "503 must be filtered from saved config");
}

async function testLegacy503DisableIsCleared() {
    let enables = 0;
    let probes = 0;
    const handler = createHandler({
        authSource: {
            availableIndices: [9],
            enableAuth: async () => {
                enables += 1;
                return true;
            },
            getStatusMetadata: () => ({ disabledReason: "http_503", disabledStatus: 503 }),
        },
        browserManager: {
            probeAccountIsolated: async () => {
                probes += 1;
                return true;
            },
            rebalanceContextPool: async () => {},
        },
    });
    await handler._runAutoHealProbeCycle();
    assert.strictEqual(enables, 1, "legacy persisted 503 disable must be cleared on scan");
    assert.strictEqual(probes, 0, "503 restore does not need an isolated credential probe");
}

async function testFailedProbeDoesNotRewriteDisabledFile() {
    let disableCalls = 0;
    const handler = createHandler({
        authSource: {
            availableIndices: [5],
            disableAuth: async () => {
                disableCalls += 1;
                return true;
            },
            enableAuth: async () => true,
            getStatusMetadata: () => ({ disabledReason: "crash_loop" }),
        },
        browserManager: {
            probeAccountIsolated: async () => {
                throw new Error("still unhealthy");
            },
            rebalanceContextPool: async () => {},
        },
    });
    const before = Date.now();
    const result = await handler._probeAndRestoreAccount(5, "crash_loop");
    assert.strictEqual(result.restored, false);
    assert.strictEqual(disableCalls, 0, "failed probes must not rewrite disabledAt/reason");
    assert(
        handler._getAccountRouteState(5).autoHealNextProbeAt >= before + handler.config.autoHealProbeIntervalMs,
        "failed probes must receive a future due time"
    );
}

function testIsolatedProbeNeverTouchesProductionPool() {
    const sourcePath = path.join(__dirname, "..", "..", "src", "core", "BrowserManager.js");
    const source = fs.readFileSync(sourcePath, "utf-8");
    const start = source.indexOf("async probeAccountIsolated(");
    const end = source.indexOf("\n    /**", start + 1);
    assert(start >= 0 && end > start, "isolated probe method must exist");
    const method = source.slice(start, end);
    assert(method.includes("firefox.launch"), "probe must launch a separate browser process");
    assert(method.includes("await browser.close()"), "probe browser must always be closed");
    assert(!method.includes("this.contexts.set"), "probe must not occupy a MAX_CONTEXTS pool slot");
}

async function main() {
    await testCycleSingleFlight();
    await testAccountSingleFlight();
    await testStartupAndBusyRetry();
    testEarliestDueScheduling();
    await test503NeverPersistsDisable();
    await testLegacy503DisableIsCleared();
    await testFailedProbeDoesNotRewriteDisabledFile();
    testIsolatedProbeNeverTouchesProductionPool();
    process.stdout.write("autoHealScheduler.test.js: all tests passed\n");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
