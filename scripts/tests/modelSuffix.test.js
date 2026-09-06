const assert = require("assert");
const FormatConverter = require("../../src/core/FormatConverter");
const RequestHandler = require("../../src/core/RequestHandler");

const logger = {
    debug() {},
    info() {},
    warn() {},
};

const hasTool = (tools, key) =>
    Array.isArray(tools) && tools.some(tool => tool && Object.prototype.hasOwnProperty.call(tool, key));

const testCombinedSuffixParsing = () => {
    const parsedTools = FormatConverter.parseModelBuiltInToolSuffixes("gemini-3-flash-preview-high-fake-search");
    assert.strictEqual(parsedTools.cleanModelName, "gemini-3-flash-preview-high-fake");
    assert.strictEqual(parsedTools.forceWebSearch, true);
    assert.strictEqual(parsedTools.forceCodeExecution, false);

    const parsedStream = FormatConverter.parseModelStreamingModeSuffix(parsedTools.cleanModelName);
    assert.strictEqual(parsedStream.cleanModelName, "gemini-3-flash-preview-high");
    assert.strictEqual(parsedStream.streamingMode, "fake");

    const parsedThinking = FormatConverter.parseModelThinkingLevel(parsedStream.cleanModelName);
    assert.strictEqual(parsedThinking.cleanModelName, "gemini-3-flash-preview");
    assert.strictEqual(parsedThinking.thinkingLevel, "HIGH");

    const minimal = FormatConverter.parseModelThinkingLevel("gemini-3-flash-preview-minimal");
    assert.strictEqual(minimal.thinkingLevel, "MINIMAL");

    const realSearch = FormatConverter.parseModelBuiltInToolSuffixes("gemini-3-flash-preview-high-real-search");
    const realStream = FormatConverter.parseModelStreamingModeSuffix(realSearch.cleanModelName);
    assert.strictEqual(realStream.cleanModelName, "gemini-3-flash-preview-high");
    assert.strictEqual(realStream.streamingMode, "real");
};

const testDiscoverableVariants = () => {
    const models = FormatConverter.expandModelListWithSuffixes([
        {
            name: "models/gemini-3-flash-preview",
            supportedGenerationMethods: ["generateContent", "countTokens"],
            thinking: true,
        },
        {
            name: "models/gemini-2.5-flash-preview-tts",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
        },
    ]);
    const names = new Set(models.map(model => model.name));

    assert.ok(names.has("models/gemini-3-flash-preview-high-fake-search"));
    assert.ok(names.has("models/gemini-3-flash-preview-high-fake-search-code"));
    assert.ok(names.has("models/gemini-3-flash-preview-search"));
    assert.ok(!names.has("models/gemini-2.5-flash-preview-tts-high-fake-search"));
};

const testOpenAITranslation = async () => {
    const converter = new FormatConverter(logger, {
        config: {
            forceCodeExecution: false,
            forceUrlContext: false,
            forceWebSearch: false,
            safetySettingsThreshold: "OFF",
        },
    });
    const result = await converter.translateOpenAIToGoogle({
        messages: [{ content: "search for this", role: "user" }],
        model: "gemini-3-flash-preview-high-fake-search",
    });

    assert.strictEqual(result.cleanModelName, "gemini-3-flash-preview");
    assert.strictEqual(result.modelStreamingMode, "fake");
    assert.strictEqual(result.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.strictEqual(hasTool(result.googleRequest.tools, "googleSearch"), true);
};

const testNativeGeminiRouting = () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.logger = logger;
    handler.config = {
        forceCodeExecution: false,
        forceThinking: false,
        forceUrlContext: false,
        forceWebSearch: false,
        safetySettingsThreshold: "OFF",
        streamingMode: "real",
    };
    handler.formatConverter = new FormatConverter(logger, { config: handler.config });

    const result = handler._buildProxyRequest(
        {
            body: {
                contents: [{ parts: [{ text: "search for this" }], role: "user" }],
            },
            headers: { "content-type": "application/json" },
            method: "POST",
            path: "/proxy/v1beta/models/gemini-3-flash-preview-high-fake-search:streamGenerateContent",
            query: {},
        },
        "request-1"
    );
    const body = JSON.parse(result.body);

    assert.strictEqual(result.path, "/v1beta/models/gemini-3-flash-preview:streamGenerateContent");
    assert.strictEqual(result.streaming_mode, "fake");
    assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.strictEqual(hasTool(body.tools, "googleSearch"), true);
};

(async () => {
    testCombinedSuffixParsing();
    testDiscoverableVariants();
    await testOpenAITranslation();
    testNativeGeminiRouting();
    console.log("model suffix tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
