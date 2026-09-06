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
    assert.ok(names.has("models/gemini-3-flash-preview-high-real-search"));
    assert.ok(names.has("models/gemini-3-flash-preview-high-fake-search-code"));
    assert.ok(names.has("models/gemini-3-flash-preview-real"));
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
        messages: [
            { content: "search for this", role: "user" },
            { content: "stale assistant prefill", role: "assistant" },
        ],
        model: "gemini-3-flash-preview-high-fake-search",
    });

    assert.strictEqual(result.cleanModelName, "gemini-3-flash-preview");
    assert.strictEqual(result.modelStreamingMode, "fake");
    assert.strictEqual(result.googleRequest.contents.at(-1).role, "user");
    assert.strictEqual(result.googleRequest.generationConfig.thinkingConfig.includeThoughts, true);
    assert.strictEqual(result.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.strictEqual(hasTool(result.googleRequest.tools, "googleSearch"), true);
};

const testThinkingConfigIsIndependentOfStreamingMode = async () => {
    const converter = new FormatConverter(logger, {
        config: {
            safetySettingsThreshold: "OFF",
        },
    });

    for (const model of [
        "gemini-3-flash-preview-high",
        "gemini-3-flash-preview-high-real",
        "gemini-3-flash-preview-high-search",
        "gemini-3-flash-preview-high-real-search",
    ]) {
        const result = await converter.translateOpenAIToGoogle({
            messages: [{ content: "show the result", role: "user" }],
            model,
        });

        assert.strictEqual(
            result.googleRequest.generationConfig.thinkingConfig.includeThoughts,
            true,
            `${model} should request returned thought parts`
        );
        assert.strictEqual(result.googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    }
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
                contents: [
                    { parts: [{ text: "search for this" }], role: "user" },
                    { parts: [{ text: "stale assistant prefill" }], role: "model" },
                ],
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
    assert.strictEqual(body.contents.at(-1).role, "user");
    assert.strictEqual(body.generationConfig.thinkingConfig.includeThoughts, true);
    assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.strictEqual(hasTool(body.tools, "googleSearch"), true);
};

const testNativeRealThinkingRouting = () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.logger = logger;
    handler.config = {
        forceCodeExecution: false,
        forceThinking: false,
        forceUrlContext: false,
        forceWebSearch: false,
        safetySettingsThreshold: "OFF",
        streamingMode: "fake",
    };
    handler.formatConverter = new FormatConverter(logger, { config: handler.config });

    const result = handler._buildProxyRequest(
        {
            body: {
                contents: [{ parts: [{ text: "show the reasoning" }], role: "user" }],
            },
            headers: { "content-type": "application/json" },
            method: "POST",
            path: "/proxy/v1beta/models/gemini-3-flash-preview-high-real-search:streamGenerateContent",
            query: {},
        },
        "request-real-thinking"
    );
    const body = JSON.parse(result.body);

    assert.strictEqual(result.path, "/v1beta/models/gemini-3-flash-preview:streamGenerateContent");
    assert.strictEqual(result.streaming_mode, "real");
    assert.strictEqual(body.generationConfig.thinkingConfig.includeThoughts, true);
    assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.strictEqual(hasTool(body.tools, "googleSearch"), true);
};

const testTrailingModelTurnHelper = () => {
    const contents = [
        { parts: [{ text: "question" }], role: "user" },
        { parts: [{ text: "draft one" }], role: "model" },
        { parts: [{ text: "draft two" }], role: "model" },
    ];

    assert.strictEqual(FormatConverter.removeUnsupportedTrailingModelTurns(contents), 2);
    assert.deepStrictEqual(contents, [{ parts: [{ text: "question" }], role: "user" }]);
};

const testThoughtPartsRemainVisibleInFakeConversion = () => {
    const converter = new FormatConverter(logger, {
        config: {
            safetySettingsThreshold: "OFF",
        },
    });
    const chunk = JSON.stringify({
        candidates: [
            {
                content: {
                    parts: [{ text: "internal reasoning", thought: true }],
                    role: "model",
                },
            },
        ],
    });

    const converted = converter.translateGoogleToOpenAIStream(chunk, "gemini-3-flash-preview", {});
    assert.ok(converted.includes('"reasoning_content":"internal reasoning"'));
};

(async () => {
    testCombinedSuffixParsing();
    testDiscoverableVariants();
    await testOpenAITranslation();
    await testThinkingConfigIsIndependentOfStreamingMode();
    testNativeGeminiRouting();
    testNativeRealThinkingRouting();
    testTrailingModelTurnHelper();
    testThoughtPartsRemainVisibleInFakeConversion();
    console.log("model suffix tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
