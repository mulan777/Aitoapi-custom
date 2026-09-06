const assert = require("assert");
const FormatConverter = require("../../src/core/FormatConverter");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = {
    debug() {},
    info() {},
    warn() {},
};

const makeHandler = () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.logger = logger;
    handler.timeouts = { STREAM_CHUNK: 100 };
    handler.formatConverter = new FormatConverter(logger, {
        config: {
            safetySettingsThreshold: "OFF",
        },
    });
    handler._isResponseWritable = response => !response.writableEnded;
    handler._isConnectionResetError = () => false;
    handler._handleRealStreamQueueClosedError = error => {
        throw error;
    };
    return handler;
};

const makeResponse = () => ({
    chunks: [],
    writableEnded: false,
    write(chunk) {
        this.chunks.push(chunk);
    },
});

const makeQueue = messages => ({
    async dequeue() {
        return messages.shift();
    },
});

const googleChunk = ({ finishReason } = {}) =>
    JSON.stringify({
        candidates: [
            {
                content: {
                    parts: [{ text: "answer" }],
                    role: "model",
                },
                ...(finishReason ? { finishReason } : {}),
            },
        ],
    });

const testCompleteRealStream = async () => {
    const handler = makeHandler();
    const response = makeResponse();
    const trackedErrors = [];
    handler._markTrackedResponseError = (...args) => trackedErrors.push(args);

    await handler._streamOpenAIResponse(
        makeQueue([{ data: googleChunk() }, { data: googleChunk({ finishReason: "STOP" }) }, { type: "STREAM_END" }]),
        response,
        "gemini-3-flash-preview-high",
        "complete-real-stream"
    );

    assert.deepStrictEqual(trackedErrors, []);
    assert.ok(response.chunks.includes("data: [DONE]\n\n"));
    assert.ok(response.chunks.some(chunk => chunk.includes('"finish_reason":"stop"')));
};

const testIncompleteRealStream = async () => {
    const handler = makeHandler();
    const response = makeResponse();
    const trackedErrors = [];
    handler._markTrackedResponseError = (...args) => trackedErrors.push(args);

    await handler._streamOpenAIResponse(
        makeQueue([{ data: googleChunk() }, { type: "STREAM_END" }]),
        response,
        "gemini-3-flash-preview-high-real",
        "incomplete-real-stream"
    );

    assert.deepStrictEqual(trackedErrors, [
        [
            response,
            "Upstream stream ended before a normal finishReason was received; partial response is incomplete.",
            502,
        ],
    ]);
    assert.ok(response.chunks.some(chunk => chunk.includes('"type":"incomplete_stream_error"')));
    assert.ok(!response.chunks.includes("data: [DONE]\n\n"));
};

(async () => {
    await testCompleteRealStream();
    await testIncompleteRealStream();
    console.log("stream integrity tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
