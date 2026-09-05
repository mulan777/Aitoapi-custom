const assert = require("node:assert/strict");
const test = require("node:test");

const FormatConverter = require("../src/core/FormatConverter");

const logger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
};

const serverSystem = {
    config: {
        safetySettingsThreshold: "OFF",
    },
};

test("removes trailing model turns for every conversational model", () => {
    for (const model of ["gemini-3.1-pro-preview", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-2.5-pro"]) {
        const contents = [
            { parts: [{ text: "question" }], role: "user" },
            { parts: [{ text: "draft one" }], role: "model" },
            { parts: [{ text: "draft two" }], role: "model" },
        ];

        const removed = FormatConverter.removeUnsupportedTrailingModelTurns(contents, model);

        assert.equal(removed, 2);
        assert.deepEqual(contents, [{ parts: [{ text: "question" }], role: "user" }]);
    }
});

test("leaves non-conversation payloads unchanged", () => {
    const contents = null;

    const removed = FormatConverter.removeUnsupportedTrailingModelTurns(contents, "gemini-embedding-001");

    assert.equal(removed, 0);
});

test("OpenAI conversion never sends Gemini 3.1 Pro a model-ending request", async () => {
    const converter = new FormatConverter(logger, serverSystem);
    const result = await converter.translateOpenAIToGoogle({
        messages: [
            { content: "question", role: "user" },
            { content: "stale draft", role: "assistant" },
        ],
        model: "gemini-3.1-pro-preview",
    });

    assert.equal(result.googleRequest.contents.at(-1).role, "user");
    assert.equal(result.googleRequest.contents.length, 1);
});

test("thinking-level suffix requests returned thoughts", async () => {
    const converter = new FormatConverter(logger, serverSystem);
    const result = await converter.translateOpenAIToGoogle({
        messages: [{ content: "solve this", role: "user" }],
        model: "gemini-3.8-flash-high",
    });

    assert.equal(result.cleanModelName, "gemini-3.8-flash");
    assert.deepEqual(result.googleRequest.generationConfig.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "HIGH",
    });
});

test("thinking and search suffixes can be combined", async () => {
    const converter = new FormatConverter(logger, serverSystem);
    const result = await converter.translateOpenAIToGoogle({
        messages: [{ content: "research this", role: "user" }],
        model: "gemini-3.8-flash-high-search",
    });

    assert.equal(result.cleanModelName, "gemini-3.8-flash");
    assert.equal(result.googleRequest.generationConfig.thinkingConfig.includeThoughts, true);
    assert.equal(result.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.deepEqual(result.googleRequest.tools, [{ googleSearch: {} }]);
});

test("model discovery includes supported suffix variants", () => {
    const models = [
        {
            inputTokenLimit: 1000,
            name: "models/gemini-3.8-flash",
            outputTokenLimit: 100,
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
        },
        {
            name: "models/gemini-2.5-flash-image",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
        },
        {
            name: "models/gemini-embedding-001",
            supportedGenerationMethods: ["embedContent"],
        },
    ];

    const ids = FormatConverter.expandModelListWithSuffixes(models).map(model => model.name);

    assert.ok(ids.includes("models/gemini-3.8-flash"));
    assert.ok(ids.includes("models/gemini-3.8-flash-search"));
    assert.ok(ids.includes("models/gemini-3.8-flash-high"));
    assert.ok(ids.includes("models/gemini-3.8-flash-high-fake"));
    assert.ok(ids.includes("models/gemini-3.8-flash-high-search"));
    assert.ok(ids.includes("models/gemini-3.8-flash-high-fake-search"));
    assert.ok(!ids.includes("models/gemini-2.5-flash-image-search"));
    assert.ok(!ids.includes("models/gemini-embedding-001-high"));
    assert.equal(new Set(ids).size, ids.length);
});

test("OpenAI conversion strips search suffix and injects Google Search", async () => {
    const converter = new FormatConverter(logger, serverSystem);
    const result = await converter.translateOpenAIToGoogle({
        messages: [{ content: "latest news", role: "user" }],
        model: "gemini-3.8-flash-search",
    });

    assert.equal(result.cleanModelName, "gemini-3.8-flash");
    assert.deepEqual(result.googleRequest.tools, [{ googleSearch: {} }]);
});
