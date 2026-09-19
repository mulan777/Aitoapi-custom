/**
 * File: src/utils/ConfigLoader.js
 * Description: Configuration loader that reads and validates system settings from environment variables
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const path = require("path");
const { getProxySummaryFromEnv } = require("./ProxyUtils");

/**
 * Configuration Loader Module
 * Responsible for loading system configuration from environment variables
 */
class ConfigLoader {
    constructor(logger) {
        this.logger = logger;
    }

    loadConfiguration() {
        const config = {
            accountCooldownMaxMs: 1800000,
            accountCooldownMs: 300000,
            apiKeys: [],
            apiKeySource: "Not set",
            autoDisableStatusCodes: [401, 403],
            autoHealProbeIntervalMs: 5 * 60 * 60 * 1000,
            autoHealProbeTimeoutMs: 10 * 60 * 1000,
            browserExecutablePath: null,
            checkUpdate: true,
            enableAuthUpdate: true,
            enableUsageStats: true,
            failureThreshold: 3,
            fakeStreamTimeoutMs: 300000,
            forceCodeExecution: false,
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            host: "0.0.0.0",
            httpPort: 7860,
            immediateSwitchStatusCodes: [429, 503],
            // maxContexts is the total managed/login context ceiling.  Keep the
            // legacy name for backwards compatibility with MAX_CONTEXTS and
            // existing runtime-settings.json files.
            maxContexts: 1,

            maxRetries: 3,

            modelPoolAllowlist: [],

            modelPoolMode: "all",

            modelRouting: null,

            retryDelay: 2000,
            // Capacity is split into a total/login cap, a routable READY
            // WebSocket cap, and optional standby contexts.  Keep the READY
            // cap unset until MAX_CONTEXTS/runtime settings have been applied
            // so existing installations retain the legacy "all contexts are
            // routable" behaviour.
            routingPoolSize: null,
            safetySettingsThreshold: "OFF",
            streamingMode: "real",
            streamTimeoutMs: 60000,
            switchOnUses: 40,
            warmStandbyContexts: 0,
            wsPort: 9998,
        };

        // Environment variable overrides
        if (process.env.PORT) {
            const parsed = parseInt(process.env.PORT, 10);
            config.httpPort = Number.isFinite(parsed) ? parsed : config.httpPort;
        }
        if (process.env.HOST) config.host = process.env.HOST;
        if (process.env.STREAMING_MODE) config.streamingMode = process.env.STREAMING_MODE;
        if (process.env.FAILURE_THRESHOLD) {
            const parsed = parseInt(process.env.FAILURE_THRESHOLD, 10);
            config.failureThreshold = Number.isFinite(parsed) ? Math.max(0, parsed) : config.failureThreshold;
        }
        if (process.env.SWITCH_ON_USES) {
            const parsed = parseInt(process.env.SWITCH_ON_USES, 10);
            config.switchOnUses = Number.isFinite(parsed) ? Math.max(0, parsed) : config.switchOnUses;
        }
        if (process.env.MAX_RETRIES) {
            const parsed = parseInt(process.env.MAX_RETRIES, 10);
            config.maxRetries = Number.isFinite(parsed) ? Math.max(1, parsed) : config.maxRetries;
        }
        if (process.env.RETRY_DELAY) {
            const parsed = parseInt(process.env.RETRY_DELAY, 10);
            config.retryDelay = Number.isFinite(parsed) ? Math.max(50, parsed) : config.retryDelay;
        }
        if (process.env.AUTO_DISABLE_STATUS_CODES) {
            config.autoDisableStatusCodes = this._parseStatusCodes(process.env.AUTO_DISABLE_STATUS_CODES, [401, 403]);
        }
        if (process.env.STREAM_TIMEOUT_MS) {
            const parsed = parseInt(process.env.STREAM_TIMEOUT_MS, 10);
            config.streamTimeoutMs = Number.isFinite(parsed)
                ? Math.min(300000, Math.max(1, parsed))
                : config.streamTimeoutMs;
        }
        if (process.env.FAKE_STREAM_TIMEOUT_MS) {
            const parsed = parseInt(process.env.FAKE_STREAM_TIMEOUT_MS, 10);
            config.fakeStreamTimeoutMs = Number.isFinite(parsed)
                ? Math.min(300000, Math.max(1, parsed))
                : config.fakeStreamTimeoutMs;
        }
        if (process.env.WS_PORT) {
            // WS_PORT environment variable is no longer supported
            this.logger.error(
                `[Config] ❌ WS_PORT environment variable is deprecated and no longer supported. ` +
                    `The WebSocket port is now fixed at 9998. Please remove WS_PORT from your .env file.`
            );
            // Do not modify config.wsPort - keep it at default 9998
        }
        if (process.env.MAX_CONTEXTS) {
            const parsed = parseInt(process.env.MAX_CONTEXTS, 10);
            config.maxContexts = Number.isFinite(parsed) ? Math.max(0, parsed) : config.maxContexts;
        }
        if (process.env.ROUTING_POOL_SIZE) {
            const parsed = parseInt(process.env.ROUTING_POOL_SIZE, 10);
            config.routingPoolSize = Number.isFinite(parsed) ? Math.max(0, parsed) : config.routingPoolSize;
        }
        if (process.env.WARM_STANDBY_CONTEXTS) {
            const parsed = parseInt(process.env.WARM_STANDBY_CONTEXTS, 10);
            config.warmStandbyContexts = Number.isFinite(parsed) ? Math.max(0, parsed) : config.warmStandbyContexts;
        }
        if (process.env.ACCOUNT_COOLDOWN_MS) {
            const parsed = parseInt(process.env.ACCOUNT_COOLDOWN_MS, 10);
            config.accountCooldownMs = Number.isFinite(parsed) ? Math.max(1000, parsed) : config.accountCooldownMs;
        }
        if (process.env.ACCOUNT_COOLDOWN_MAX_MS) {
            const parsed = parseInt(process.env.ACCOUNT_COOLDOWN_MAX_MS, 10);
            config.accountCooldownMaxMs = Number.isFinite(parsed)
                ? Math.max(config.accountCooldownMs, parsed)
                : config.accountCooldownMaxMs;
        }

        // Settings changed from the Web UI are kept in a small local runtime
        // file. Environment variables remain the bootstrap/default source;
        // the runtime file is applied afterwards so a UI change survives a
        // process restart without rewriting .env or exposing credentials.
        this._applyRuntimeSettings(config);
        // A missing split-pool value is intentionally backward compatible:
        // every login Context remains eligible for routing until an operator
        // explicitly chooses a smaller READY pool.
        if (!Number.isInteger(config.routingPoolSize)) config.routingPoolSize = config.maxContexts;
        if (config.maxContexts > 0 && config.routingPoolSize > config.maxContexts) {
            config.routingPoolSize = config.maxContexts;
        }
        if (config.maxContexts > 0 && config.warmStandbyContexts > config.maxContexts) {
            config.warmStandbyContexts = config.maxContexts;
        }
        if (process.env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
        if (process.env.API_KEYS) {
            config.apiKeys = process.env.API_KEYS.split(",");
        }
        if (process.env.CHECK_UPDATE) config.checkUpdate = process.env.CHECK_UPDATE.toLowerCase() !== "false";
        if (process.env.FORCE_THINKING) config.forceThinking = process.env.FORCE_THINKING.toLowerCase() === "true";
        if (process.env.FORCE_CODE_EXECUTION)
            config.forceCodeExecution = process.env.FORCE_CODE_EXECUTION.toLowerCase() === "true";
        if (process.env.FORCE_WEB_SEARCH) config.forceWebSearch = process.env.FORCE_WEB_SEARCH.toLowerCase() === "true";
        if (process.env.FORCE_URL_CONTEXT)
            config.forceUrlContext = process.env.FORCE_URL_CONTEXT.toLowerCase() === "true";
        if (process.env.SAFETY_SETTINGS_THRESHOLD) {
            const rawThreshold = String(process.env.SAFETY_SETTINGS_THRESHOLD).trim().toUpperCase();
            const allowedThresholds = new Set([
                "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
                "BLOCK_LOW_AND_ABOVE",
                "BLOCK_MEDIUM_AND_ABOVE",
                "BLOCK_ONLY_HIGH",
                "BLOCK_NONE",
                "OFF",
            ]);
            if (allowedThresholds.has(rawThreshold)) {
                config.safetySettingsThreshold = rawThreshold;
            } else {
                this.logger.warn(
                    `[Config] Invalid SAFETY_SETTINGS_THRESHOLD "${process.env.SAFETY_SETTINGS_THRESHOLD}", falling back to ${config.safetySettingsThreshold}.`
                );
            }
        }
        if (process.env.ENABLE_AUTH_UPDATE)
            config.enableAuthUpdate = process.env.ENABLE_AUTH_UPDATE.toLowerCase() !== "false";
        if (process.env.ENABLE_USAGE_STATS)
            config.enableUsageStats = process.env.ENABLE_USAGE_STATS.toLowerCase() !== "false";
        if (process.env.MODEL_POOL_MODE) {
            const mode = String(process.env.MODEL_POOL_MODE).trim().toLowerCase();
            if (mode === "all" || mode === "allowlist") config.modelPoolMode = mode;
        }
        if (process.env.MODEL_POOL_ALLOWLIST !== undefined) {
            config.modelPoolAllowlist = this._parseModelPoolAllowlist(process.env.MODEL_POOL_ALLOWLIST);
        }

        let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
        let codesSource = "environment variable";

        if (
            rawCodes === undefined &&
            config.immediateSwitchStatusCodes &&
            Array.isArray(config.immediateSwitchStatusCodes)
        ) {
            rawCodes = config.immediateSwitchStatusCodes.join(",");
            codesSource = "default value";
        }

        if (rawCodes && typeof rawCodes === "string") {
            config.immediateSwitchStatusCodes = rawCodes
                .split(",")
                .map(code => parseInt(String(code).trim(), 10))
                .filter(code => !isNaN(code) && code >= 400 && code <= 599);
        } else {
            config.immediateSwitchStatusCodes = [];
        }
        if (config.immediateSwitchStatusCodes.length > 0) {
            this.logger.info(`[System] Loaded "immediate switch status codes" from ${codesSource}.`);
        }
        if (Array.isArray(config.apiKeys)) {
            config.apiKeys = config.apiKeys.map(k => String(k).trim()).filter(k => k);
        } else {
            config.apiKeys = [];
        }

        if (config.apiKeys.length > 0) {
            config.apiKeySource = "Custom";
        } else {
            config.apiKeys = ["123456"];
            config.apiKeySource = "Default";
            this.logger.info("[System] No API key set, using default password: 123456");
        }

        // Load model list
        const modelsPath = path.join(process.cwd(), "configs", "models.json");
        try {
            if (fs.existsSync(modelsPath)) {
                const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
                const modelsData = JSON.parse(modelsFileContent);
                if (modelsData && modelsData.models) {
                    config.modelList = modelsData.models;
                    this.logger.info(
                        `[System] Successfully loaded ${config.modelList.length} models from models.json.`
                    );
                } else {
                    this.logger.warn(`[System] models.json is not in the expected format, using default model list.`);
                    config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
                }
            } else {
                this.logger.warn(`[System] models.json file not found, using default model list.`);
                config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
            }
        } catch (error) {
            this.logger.error(
                `[System] Failed to read or parse models.json: ${error.message}, using default model list.`
            );
            config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
        }

        this._printConfiguration(config);
        return config;
    }

    _parseStatusCodes(value, fallback = []) {
        const values = Array.isArray(value) ? value : String(value || "").split(",");
        const parsed = [
            ...new Set(
                values
                    .map(item => Number.parseInt(String(item).trim(), 10))
                    .filter(code => Number.isInteger(code) && code >= 400 && code <= 599 && code !== 503)
            ),
        ];
        return parsed.length > 0 ? parsed : [...fallback];
    }

    _parseModelPoolAllowlist(value) {
        const values = Array.isArray(value) ? value : String(value || "").split(",");
        return [
            ...new Set(
                values
                    .map(item => String(item || "").trim())
                    .filter(Boolean)
                    .slice(0, 100)
            ),
        ];
    }

    _applyRuntimeSettings(config) {
        const runtimeSettingsPath = path.join(process.cwd(), "configs", "runtime-settings.json");
        if (!fs.existsSync(runtimeSettingsPath)) return;

        try {
            const raw = JSON.parse(fs.readFileSync(runtimeSettingsPath, "utf-8"));
            if (!raw || typeof raw !== "object") return;

            const isIntegerInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

            if (isIntegerInRange(raw.maxContexts, 0, 1000)) config.maxContexts = raw.maxContexts;
            // Files written by older versions do not have routingPoolSize;
            // inherit the legacy total-context setting in that case.
            if (!Object.prototype.hasOwnProperty.call(raw, "routingPoolSize")) {
                config.routingPoolSize = config.maxContexts;
            }
            if (isIntegerInRange(raw.routingPoolSize, 0, 1000)) config.routingPoolSize = raw.routingPoolSize;
            if (isIntegerInRange(raw.warmStandbyContexts, 0, 1000)) {
                config.warmStandbyContexts = raw.warmStandbyContexts;
            }
            if (raw.modelPoolMode === "all" || raw.modelPoolMode === "allowlist") {
                config.modelPoolMode = raw.modelPoolMode;
            }
            if (Array.isArray(raw.modelPoolAllowlist)) {
                config.modelPoolAllowlist = this._parseModelPoolAllowlist(raw.modelPoolAllowlist);
            }
            if (raw.modelRouting && typeof raw.modelRouting === "object") {
                config.modelRouting = raw.modelRouting;
                if (raw.modelRouting.mode === "all" || raw.modelRouting.mode === "allowlist") {
                    config.modelPoolMode = raw.modelRouting.mode;
                }
                if (Array.isArray(raw.modelRouting.allowlist)) {
                    config.modelPoolAllowlist = this._parseModelPoolAllowlist(raw.modelRouting.allowlist);
                }
            }
            if (isIntegerInRange(raw.maxRetries, 1, 20)) config.maxRetries = raw.maxRetries;
            if (isIntegerInRange(raw.retryDelay, 50, 600000)) config.retryDelay = raw.retryDelay;
            if (Array.isArray(raw.autoDisableStatusCodes)) {
                config.autoDisableStatusCodes = this._parseStatusCodes(raw.autoDisableStatusCodes, []);
            }
            if (isIntegerInRange(raw.accountCooldownMs, 1000, 86400000)) {
                config.accountCooldownMs = raw.accountCooldownMs;
            }
            if (isIntegerInRange(raw.accountCooldownMaxMs, 1000, 604800000)) {
                config.accountCooldownMaxMs = Math.max(config.accountCooldownMs, raw.accountCooldownMaxMs);
            }
            if (config.accountCooldownMaxMs < config.accountCooldownMs) {
                config.accountCooldownMaxMs = config.accountCooldownMs;
            }
            if (config.maxContexts > 0 && config.routingPoolSize !== null) {
                config.routingPoolSize = Math.min(config.routingPoolSize, config.maxContexts);
            }
            if (config.maxContexts > 0) {
                config.warmStandbyContexts = Math.min(config.warmStandbyContexts, config.maxContexts);
            }
            // AutoHeal probe schedule (v1.2.6): interval + per-account probe timeout.
            if (isIntegerInRange(raw.autoHealProbeIntervalMs, 60000, 604800000)) {
                config.autoHealProbeIntervalMs = raw.autoHealProbeIntervalMs;
            }
            if (isIntegerInRange(raw.autoHealProbeTimeoutMs, 30000, 3600000)) {
                config.autoHealProbeTimeoutMs = raw.autoHealProbeTimeoutMs;
            }
            this.logger.info(`[Config] Applied runtime settings from ${runtimeSettingsPath}.`);
        } catch (error) {
            this.logger.warn(`[Config] Ignoring invalid runtime settings file: ${error.message}`);
        }
    }

    _printConfiguration(config) {
        this.logger.info("================ [ Active Configuration ] ================");
        this.logger.info(`  HTTP Server Port: ${config.httpPort}`);
        this.logger.info(`  Listening Address: ${config.host}`);
        this.logger.info(`  Streaming Mode: ${config.streamingMode}`);
        this.logger.info(`  Stream Timeout: ${config.streamTimeoutMs}ms`);
        this.logger.info(`  Fake/Non-Stream Timeout: ${config.fakeStreamTimeoutMs}ms`);
        this.logger.info(`  Force Thinking: ${config.forceThinking}`);
        this.logger.info(`  Force Code Execution: ${config.forceCodeExecution}`);
        this.logger.info(`  Force Web Search: ${config.forceWebSearch}`);
        this.logger.info(`  Force URL Context: ${config.forceUrlContext}`);
        this.logger.info(`  Check Update: ${config.checkUpdate}`);
        this.logger.info(`  Default Safety Threshold: ${config.safetySettingsThreshold}`);
        this.logger.info(`  Auto Update Auth: ${config.enableAuthUpdate}`);
        this.logger.info(`  Usage Stats: ${config.enableUsageStats}`);
        this.logger.info(
            `  Max Contexts (login/managed): ${config.maxContexts === 0 ? "Unlimited" : config.maxContexts}`
        );
        this.logger.info(`  READY Routing Pool: ${config.routingPoolSize === 0 ? "All" : config.routingPoolSize}`);
        this.logger.info(`  Warm Standby Contexts: ${config.warmStandbyContexts}`);
        this.logger.info(
            `  Model Pool: ${config.modelPoolMode}${config.modelPoolAllowlist.length ? ` (${config.modelPoolAllowlist.join(", ")})` : ""}`
        );
        this.logger.info(
            `  Account 429 Cooldown: ${Math.round(config.accountCooldownMs / 1000)}s (max ${Math.round(config.accountCooldownMaxMs / 1000)}s)`
        );
        this.logger.info(
            `  Usage-based Switch Threshold: ${
                config.switchOnUses > 0 ? `Switch after every ${config.switchOnUses} requests` : "Disabled"
            }`
        );
        this.logger.info(
            `  Failure-based Switch: ${
                config.failureThreshold > 0 ? `Switch after ${config.failureThreshold} failures` : "Disabled"
            }`
        );
        this.logger.info(
            `  Immediate Switch Status Codes: ${
                config.immediateSwitchStatusCodes.length > 0 ? config.immediateSwitchStatusCodes.join(", ") : "Disabled"
            }`
        );
        this.logger.info(`  Max Retries per Request: ${config.maxRetries} times`);
        this.logger.info(`  Retry Delay: ${config.retryDelay}ms`);
        this.logger.info(`  Auto-disable Status Codes: ${config.autoDisableStatusCodes.join(", ")}`);
        this.logger.info(`  API Key Source: ${config.apiKeySource}`);

        const proxySummary = getProxySummaryFromEnv();
        if (!proxySummary.enabled) {
            this.logger.info("  Proxy: Disabled");
        } else {
            this.logger.info(`  Proxy: Enabled (${proxySummary.envKey})`);
            this.logger.info(`  Proxy Server: ${proxySummary.server}`);
        }
        this.logger.info("=============================================================");
    }
}

module.exports = ConfigLoader;
