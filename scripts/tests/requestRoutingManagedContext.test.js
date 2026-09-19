"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const RequestHandler = require("../../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function makeHandler({ contextIndices = [], closedIndices = [], connectionIndices = [] } = {}) {
    const connections = new Map(connectionIndices.map(index => [index, { readyState: 1 }]));
    const contexts = new Map(
        contextIndices.map(index => [index, { page: { isClosed: () => closedIndices.includes(index) } }])
    );
    const handler = Object.create(RequestHandler.prototype);
    handler.browserManager = { contexts };
    handler.connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: index => connections.get(index),
    };
    handler.authSource = {
        availableIndices: [...new Set([...contextIndices, ...connectionIndices])],
        isUnavailable: () => false,
    };
    handler.accountRouteState = new Map();
    handler.authSwitcher = { currentAuthIndex: contextIndices[0] ?? connectionIndices[0] ?? -1 };
    handler.requestRouteCursor = 0;
    handler.logger = logger;
    handler._isAuthUnavailable = () => false;
    handler._isInWsCrashLoop = () => false;
    handler._isPerAccountUsageRoutingEnabled = () => false;
    return handler;
}

test("registry-only connection is not selected", () => {
    const handler = makeHandler({ connectionIndices: [7] });
    assert.equal(handler._selectRequestAuthIndex(), -1);
});

test("closed page connection is not selected", () => {
    const handler = makeHandler({ closedIndices: [7], connectionIndices: [7], contextIndices: [7] });
    assert.equal(handler._selectRequestAuthIndex(), -1);
});

test("managed live context with OPEN connection is selected", () => {
    const handler = makeHandler({ connectionIndices: [7], contextIndices: [7] });
    assert.equal(handler._selectRequestAuthIndex(), 7);
});

test("current-account fallback also requires a managed live context", () => {
    const handler = makeHandler({ connectionIndices: [7] });
    handler.authSwitcher.currentAuthIndex = 7;
    assert.equal(handler._selectRequestAuthIndex(), -1);
    handler.browserManager.contexts.set(7, { page: { isClosed: () => false } });
    assert.equal(handler._selectRequestAuthIndex(), 7);
});
