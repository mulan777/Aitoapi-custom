const assert = require("assert");
const BrowserManager = require("../../src/core/BrowserManager");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createFakePage() {
    let closed = false;
    const page = {
        bringToFront: async () => {},
        close: () => {
            closed = true;
        },
        evaluate: async () => {
            page.evaluateCalls++;
            return { found: false };
        },
        evaluateCalls: 0,
        isClosed: () => closed,
        mouse: {
            down: async () => {},
            move: async () => {},
            up: async () => {},
        },
        viewportSize: () => ({ height: 900, width: 1200 }),
    };
    return page;
}

async function main() {
    const logger = {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {},
    };
    const manager = new BrowserManager(logger, {}, {});
    manager._simulateHumanMovement = async () => {};

    const page0 = createFakePage();
    const page1 = createFakePage();
    manager.contexts.set(0, { context: {}, healthMonitorInterval: null, page: page0 });
    manager.contexts.set(1, { context: {}, healthMonitorInterval: null, page: page1 });

    manager._startBackgroundWakeup(0);
    manager._startBackgroundWakeup(1);
    await delay(1800);

    assert.strictEqual(manager.backgroundWakeups.size, 2, "each auth context should have a worker");
    assert.ok(page0.evaluateCalls > 0, "account 0 page should be scanned");
    assert.ok(page1.evaluateCalls > 0, "account 1 page should be scanned");

    await manager._stopBackgroundWakeup(0, "test");
    assert.strictEqual(manager.backgroundWakeups.size, 1, "stopping one account must preserve the other worker");
    await manager._stopBackgroundWakeup(1, "test");
    assert.strictEqual(manager.backgroundWakeups.size, 0, "all workers should stop cleanly");
    assert.strictEqual(manager.backgroundWakeupRunning, false, "aggregate worker flag should reset");

    console.log("backgroundWakeup: PASS");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
