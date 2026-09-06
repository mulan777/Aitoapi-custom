/**
 * File: src/core/RequestHandler.js
 * Description: Main request handler that processes API requests, manages retries, and coordinates between authentication and format conversion
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

/**
 * Request Handler Module (Refactored)
 * Main request handler that coordinates between other modules
 */
const AuthSwitcher = require("../auth/AuthSwitcher");
const FormatConverter = require("./FormatConverter");
const { isUserAbortedError } = require("../utils/CustomErrors");
const { QueueClosedError, QueueTimeoutError } = require("../utils/MessageQueue");

const WS_RECONNECT_WAIT_MS = 130000;
const WS_CONNECTION_READY_TIMEOUT_MS = 10000;

// Default timeout constants (in milliseconds)
const DEFAULT_TIMEOUTS = {
    FAKE_STREAM: 300000, // 300 seconds (5 minutes) - timeout for fake streaming (buffered response)
    STREAM_CHUNK: 60000, // 60 seconds - timeout between stream chunks
};

class RequestHandler {
    constructor(serverSystem, connectionRegistry, logger, browserManager, config, authSource) {
        this.serverSystem = serverSystem;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.config = config;
        this.authSource = authSource;

        // Initialize sub-modules
        this.authSwitcher = new AuthSwitcher(logger, config, authSource, browserManager);
        this.formatConverter = new FormatConverter(logger, serverSystem);

        this.needsSwitchingAfterRequest = false;

        // Request-scoped account routing. `currentAuthIndex` is a UI/recovery state,
        // not a safe request-routing key: another request can change it while an
        // existing stream is still waiting on its own WebSocket queue.
        this.requestAuthBindings = new Map();
        this.requestModelBindings = new Map();
        this.requestRouteCursor = 0;
        this.requestFailureCounts = new Map();
        this.accountRouteState = new Map();
        this.pendingUsageRotations = new Set();
        this.usageRotationPromise = null;
        this.usageRotationRetryTimer = null;

        // Timeout settings
        this.timeouts = {
            FAKE_STREAM: this.config.fakeStreamTimeoutMs || DEFAULT_TIMEOUTS.FAKE_STREAM,
            STREAM_CHUNK: this.config.streamTimeoutMs || DEFAULT_TIMEOUTS.STREAM_CHUNK,
        };
    }

    _normalizeRouteModel(modelName) {
        if (!modelName) return null;
        let value = String(modelName)
            .trim()
            .replace(/^models\//, "")
            .replace(/^\/+/, "");
        try {
            value = FormatConverter.parseModelBuiltInToolSuffixes(value).cleanModelName;
            value = FormatConverter.parseModelStreamingModeSuffix(value).cleanModelName;
            value = FormatConverter.parseModelThinkingLevel(value).cleanModelName;
        } catch {
            // Keep the original normalized name if an optional model parser
            // changes in a future converter version.
        }
        return value || null;
    }

    _getRequestedModel(req) {
        if (!req) return null;
        const pathMatch = String(req.path || "").match(/\/models\/([^:/?]+)(?::|$)/);
        return this._normalizeRouteModel(pathMatch ? pathMatch[1] : req.body?.model || req.query?.model);
    }

    _getProxyRequestModel(proxyRequest) {
        if (proxyRequest?.tracking_model) return this._normalizeRouteModel(proxyRequest.tracking_model);
        const pathMatch = String(proxyRequest?.path || "").match(/\/models\/([^:/?]+)(?::|$)/);
        return this._normalizeRouteModel(pathMatch ? pathMatch[1] : null);
    }

    async _warmStandbyForModel(modelName, excluded = []) {
        const routeModel = this._normalizeRouteModel(modelName);
        if (!routeModel || !this.browserManager?.ensureContextForAuth) return false;
        const excludedSet = new Set(excluded);
        const candidates = (this.authSource?.getRotationIndices?.() || this.authSource?.availableIndices || [])
            .filter(index => !excludedSet.has(index) && !this.browserManager.contexts.has(index))
            .filter(index => !this.authSource?.isExpired?.(index));

        for (const authIndex of candidates) {
            const state = this._getAccountRouteState(authIndex);
            if (
                state.cooldownUntil > Date.now() ||
                state.usageExhausted ||
                (state.modelCooldowns?.[routeModel] || 0) > Date.now()
            ) {
                continue;
            }
            if (await this.browserManager.ensureContextForAuth(authIndex)) {
                this.logger.info(`[Routing] Warmed standby account #${authIndex} for model "${routeModel}".`);
                return true;
            }
        }
        return false;
    }

    _selectRequestAuthIndex(excluded = [], modelName = null) {
        const excludedSet = new Set(excluded.filter(index => Number.isInteger(index) && index >= 0));
        const routeModel = this._normalizeRouteModel(modelName);
        const now = Date.now();
        const activeIndices = [...this.connectionRegistry.getAllConnections().entries()]
            .filter(([, connection]) => connection && connection.readyState === 1)
            .map(([authIndex]) => authIndex)
            .filter(authIndex => {
                if (excludedSet.has(authIndex)) return false;
                if (
                    Array.isArray(this.authSource?.availableIndices) &&
                    !this.authSource.availableIndices.includes(authIndex)
                ) {
                    return false;
                }
                if (this.authSource?.isExpired?.(authIndex)) return false;
                const routeState = this.accountRouteState.get(authIndex);
                if (routeState?.cooldownUntil > now) return false;
                if (this._isPerAccountUsageRoutingEnabled() && routeState?.usageExhausted) return false;
                return !routeModel || (routeState?.modelCooldowns?.[routeModel] || 0) <= now;
            })
            .sort((a, b) => a - b);

        if (activeIndices.length === 0) {
            const current = this.currentAuthIndex;
            const currentState = this.accountRouteState.get(current);
            const currentConnection = this.connectionRegistry.getConnectionByAuth(current, false);
            const currentAvailable =
                Number.isInteger(current) &&
                current >= 0 &&
                !excludedSet.has(current) &&
                (!Array.isArray(this.authSource?.availableIndices) ||
                    this.authSource.availableIndices.includes(current)) &&
                !this.authSource?.isExpired?.(current) &&
                currentConnection &&
                currentConnection.readyState === 1 &&
                (!currentState?.cooldownUntil || currentState.cooldownUntil <= now) &&
                (!this._isPerAccountUsageRoutingEnabled() || !currentState?.usageExhausted) &&
                (!routeModel || (currentState?.modelCooldowns?.[routeModel] || 0) <= now);
            return currentAvailable ? current : -1;
        }

        // Round-robin is used only as a tie breaker. Long streams should not
        // occupy the same account while another ready account is idle.
        const offset = this.requestRouteCursor % activeIndices.length;
        const rotated = activeIndices.slice(offset).concat(activeIndices.slice(0, offset));
        const minInFlight = Math.min(...rotated.map(authIndex => this._getAccountRouteState(authIndex).inFlight));
        const selected = rotated.find(authIndex => this._getAccountRouteState(authIndex).inFlight === minInFlight);
        this.requestRouteCursor = (activeIndices.indexOf(selected) + 1) % activeIndices.length;
        return selected;
    }

    _getAccountRouteState(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return {
                cooldownUntil: 0,
                inFlight: 0,
                lastError: null,
                lastStatus: null,
                modelCooldowns: {},
                modelRateLimitHits: {},
                rateLimitHits: 0,
                usageCount: 0,
                usageExhausted: false,
                usageExhaustedAt: 0,
            };
        }
        if (!this.accountRouteState.has(authIndex)) {
            this.accountRouteState.set(authIndex, {
                cooldownUntil: 0,
                inFlight: 0,
                lastError: null,
                lastStatus: null,
                modelCooldowns: {},
                modelRateLimitHits: {},
                rateLimitHits: 0,
                usageCount: 0,
                usageExhausted: false,
                usageExhaustedAt: 0,
            });
        }
        return this.accountRouteState.get(authIndex);
    }

    _isPerAccountUsageRoutingEnabled() {
        return this.config.maxContexts === 0 || this.config.maxContexts > 1;
    }

    _incrementGenerationUsage(requestId, fallbackAuthIndex, label) {
        const authIndex = this._getRequestAuthIndex(requestId, fallbackAuthIndex);
        if (authIndex < 0) {
            return { authIndex, count: 0, exhausted: false, limit: this.config.switchOnUses };
        }

        if (!this._isPerAccountUsageRoutingEnabled()) {
            const count = this.authSwitcher.incrementUsageCount();
            if (this.authSwitcher.shouldSwitchByUsage() && this._shouldRotateGlobalAccount()) {
                this.needsSwitchingAfterRequest = true;
            }
            return {
                authIndex,
                count,
                exhausted: this.authSwitcher.shouldSwitchByUsage(),
                limit: this.config.switchOnUses,
                mode: "global",
            };
        }

        const state = this._getAccountRouteState(authIndex);
        state.usageCount += 1;
        const limit = Number(this.config.switchOnUses) || 0;
        if (limit > 0 && state.usageCount >= limit) {
            if (!state.usageExhausted) {
                state.usageExhausted = true;
                state.usageExhaustedAt = Date.now();
                this.pendingUsageRotations.add(authIndex);
                this.logger.info(
                    `[Routing] Account #${authIndex} reached usage threshold ` +
                        `(${state.usageCount}/${limit}) for ${label}; it will be replaced after in-flight requests drain.`
                );
            }
        }

        this.logger.info(
            `[Request] ${label} routed through account #${authIndex}: ` +
                `${limit > 0 ? `${state.usageCount}/${limit}` : state.usageCount}`
        );
        return {
            authIndex,
            count: state.usageCount,
            exhausted: state.usageExhausted,
            limit,
            mode: "per-account",
        };
    }

    _getUsageRotationCandidates(sourceAuthIndex) {
        const rotation = this.authSource?.getRotationIndices?.() ||
            this.authSource?.availableIndices || [...this.connectionRegistry.getAllConnections().keys()];
        const ordered = Array.isArray(rotation) ? [...rotation] : [];
        if (ordered.length === 0) return [];

        const sourcePosition = ordered.indexOf(sourceAuthIndex);
        const start = sourcePosition >= 0 ? sourcePosition + 1 : 0;
        const candidates = [];
        const seen = new Set();
        const now = Date.now();

        for (let offset = 0; offset < ordered.length; offset++) {
            const authIndex = ordered[(start + offset) % ordered.length];
            if (seen.has(authIndex) || authIndex === sourceAuthIndex) continue;
            seen.add(authIndex);

            if (this.authSource?.isExpired?.(authIndex)) continue;
            const state = this._getAccountRouteState(authIndex);
            if (state.cooldownUntil > now || state.usageExhausted) continue;
            candidates.push(authIndex);
        }

        return candidates;
    }

    _resetExhaustedUsageCycle() {
        const rotation = this.authSource?.getRotationIndices?.() ||
            this.authSource?.availableIndices || [...this.accountRouteState.keys()];
        let resetCount = 0;
        for (const authIndex of Array.isArray(rotation) ? rotation : []) {
            const state = this._getAccountRouteState(authIndex);
            if (!state.usageExhausted) continue;
            state.usageCount = 0;
            state.usageExhausted = false;
            state.usageExhaustedAt = 0;
            resetCount += 1;
        }
        if (resetCount > 0) {
            this.logger.info(`[Routing] All usable accounts reached the usage threshold; started a new cycle.`);
        }
        return resetCount;
    }

    async _rotateAccountAfterUsage(sourceAuthIndex) {
        if (!this._isPerAccountUsageRoutingEnabled()) return false;

        const sourceState = this._getAccountRouteState(sourceAuthIndex);
        if (!sourceState.usageExhausted || sourceState.inFlight > 0) return false;
        const wasCurrent = this.browserManager?.currentAuthIndex === sourceAuthIndex;

        let candidates = this._getUsageRotationCandidates(sourceAuthIndex);
        if (candidates.length === 0) {
            this._resetExhaustedUsageCycle();
            candidates = this._getUsageRotationCandidates(sourceAuthIndex);
        }
        if (candidates.length === 0) {
            this.logger.warn(
                `[Routing] No replacement account is available for exhausted account #${sourceAuthIndex}.`
            );
            return false;
        }

        const hasContext = authIndex => this.browserManager?.contexts?.has(authIndex);
        const coldCandidates = candidates.filter(authIndex => !hasContext(authIndex));
        const activeCandidates = candidates.filter(authIndex =>
            this.connectionRegistry.getConnectionByAuth(authIndex, false)
        );
        const orderedCandidates = [...coldCandidates, ...activeCandidates, ...candidates].filter(
            (authIndex, index, list) => list.indexOf(authIndex) === index
        );

        // Free the exhausted slot first.  The request binding has already been
        // released by the caller, so closeContext will not interrupt the
        // request that caused the threshold to be reached.
        if (this.browserManager?.contexts?.has(sourceAuthIndex)) {
            await this.browserManager.closeContext(sourceAuthIndex);
        }

        const activateIfNeeded = async targetAuthIndex => {
            if (!wasCurrent || !this.browserManager?.launchOrSwitchContext) return true;
            try {
                await this.browserManager.launchOrSwitchContext(targetAuthIndex);
                return this.browserManager.currentAuthIndex === targetAuthIndex;
            } catch (error) {
                this.logger.warn(
                    `[Routing] Failed to make replacement account #${targetAuthIndex} current: ${error.message}`
                );
                return false;
            }
        };

        for (const targetAuthIndex of orderedCandidates) {
            if (this.browserManager?.contexts?.has(targetAuthIndex)) {
                if (await activateIfNeeded(targetAuthIndex)) {
                    this.logger.info(
                        `[Routing] Replaced exhausted account #${sourceAuthIndex} with warm account #${targetAuthIndex}.`
                    );
                    return true;
                }
                continue;
            }

            if (this.browserManager?.ensureContextForAuth) {
                const warmed = await this.browserManager.ensureContextForAuth(targetAuthIndex);
                if (warmed && (await activateIfNeeded(targetAuthIndex))) {
                    this.logger.info(
                        `[Routing] Replaced exhausted account #${sourceAuthIndex} with account #${targetAuthIndex}; ` +
                            `context warmed and WebSocket connected.`
                    );
                    return true;
                }
            }
        }

        this.logger.warn(`[Routing] Replacement warm-up failed for exhausted account #${sourceAuthIndex}.`);
        return false;
    }

    async _flushPendingUsageRotations() {
        if (!this._isPerAccountUsageRoutingEnabled() || this.pendingUsageRotations.size === 0) return;

        for (const authIndex of [...this.pendingUsageRotations]) {
            const state = this._getAccountRouteState(authIndex);
            if (!state.usageExhausted) {
                this.pendingUsageRotations.delete(authIndex);
                continue;
            }
            if (state.inFlight > 0) continue;

            const rotated = await this._rotateAccountAfterUsage(authIndex);
            if (rotated) this.pendingUsageRotations.delete(authIndex);
        }
    }

    _schedulePendingUsageRotations() {
        if (
            !this._isPerAccountUsageRoutingEnabled() ||
            this.pendingUsageRotations.size === 0 ||
            this.usageRotationPromise ||
            this.usageRotationRetryTimer
        ) {
            return;
        }

        this.usageRotationPromise = this._flushPendingUsageRotations()
            .catch(error => {
                this.logger.error(`[Routing] Pending usage rotation failed: ${error.message}`);
            })
            .finally(() => {
                this.usageRotationPromise = null;
                if (this.pendingUsageRotations.size > 0) {
                    // Warm-up failures are usually transient. Delay the next
                    // attempt so an unavailable browser/auth source cannot
                    // create a synchronous promise loop.
                    this.usageRotationRetryTimer = setTimeout(() => {
                        this.usageRotationRetryTimer = null;
                        this._schedulePendingUsageRotations();
                    }, 2000);
                }
            });
    }

    _parseRetryAfterMs(errorDetails) {
        const retryAfter = errorDetails?.retryAfter ?? errorDetails?.retry_after;
        if (Number.isFinite(Number(retryAfter))) return Math.max(1000, Number(retryAfter) * 1000);
        return 0;
    }

    _markAccount429(authIndex, errorDetails) {
        return this._markAccount429ForModel(authIndex, null, errorDetails);
    }

    _markAccount429ForModel(authIndex, modelName, errorDetails) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        const state = this._getAccountRouteState(authIndex);
        const base = Math.max(1000, this.config.accountCooldownMs || 300000);
        const max = Math.max(base, this.config.accountCooldownMaxMs || 1800000);
        const retryAfterMs = this._parseRetryAfterMs(errorDetails);
        const routeModel = this._normalizeRouteModel(modelName);
        const hitCount = routeModel ? state.modelRateLimitHits[routeModel] || 0 : state.rateLimitHits;
        const backoffMs = Math.min(max, base * 2 ** Math.min(hitCount, 3));
        const cooldownMs = Math.min(max, Math.max(retryAfterMs, backoffMs));
        const cooldownUntil = Date.now() + cooldownMs;
        if (routeModel) {
            state.modelCooldowns[routeModel] = Math.max(state.modelCooldowns[routeModel] || 0, cooldownUntil);
        } else {
            state.cooldownUntil = cooldownUntil;
        }
        state.lastError = errorDetails?.message || "Upstream returned HTTP 429";
        state.lastStatus = 429;
        if (routeModel) {
            state.modelRateLimitHits[routeModel] = hitCount + 1;
        } else {
            state.rateLimitHits += 1;
        }
        this.logger.warn(
            `[Routing] Account #${authIndex} entered ${routeModel ? `model "${routeModel}" ` : ""}429 cooldown for ${Math.ceil(cooldownMs / 1000)}s; matching requests will skip it.`
        );
    }

    _markAccountSuccess(authIndex, modelName = null) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        const state = this._getAccountRouteState(authIndex);
        state.lastError = null;
        state.lastStatus = 200;
        const routeModel = this._normalizeRouteModel(modelName);
        if (routeModel) {
            state.modelRateLimitHits[routeModel] = 0;
            if (state.modelCooldowns[routeModel] <= Date.now()) {
                delete state.modelCooldowns[routeModel];
            }
        } else {
            state.rateLimitHits = 0;
        }
        if (state.cooldownUntil && state.cooldownUntil <= Date.now()) state.cooldownUntil = 0;
        // Failure thresholds represent consecutive/transient failures. A successful
        // request on this account proves that the previous failure streak is over.
        this.requestFailureCounts.delete(authIndex);
        if (this.authSwitcher?.failureCount > 0) {
            this.authSwitcher.failureCount = 0;
        }
    }

    _markImmediateRateLimitIfNeeded(authIndex, modelName, errorDetails) {
        if (Number(errorDetails?.status) === 429) {
            this._markAccount429ForModel(authIndex, modelName, errorDetails);
        }
    }

    getAccountRouteStatus(authIndex) {
        const state = this._getAccountRouteState(authIndex);
        return {
            cooldownUntil: state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : null,
            inFlight: state.inFlight,
            lastError: state.lastError,
            lastStatus: state.lastStatus,
            modelCooldowns: Object.fromEntries(
                Object.entries(state.modelCooldowns || {}).filter(([, until]) => until > Date.now())
            ),
            rateLimitHits: state.rateLimitHits,
            usageCount: state.usageCount,
            usageExhausted: state.usageExhausted,
            usageLimit: Number(this.config.switchOnUses) || 0,
        };
    }

    getNextCooldownMs(modelName = null) {
        const now = Date.now();
        const routeModel = this._normalizeRouteModel(modelName);
        const remaining = [...this.accountRouteState.values()]
            .flatMap(state => {
                const values = state.cooldownUntil > now ? [state.cooldownUntil - now] : [];
                if (routeModel && state.modelCooldowns?.[routeModel] > now) {
                    values.push(state.modelCooldowns[routeModel] - now);
                }
                return values;
            })
            .filter(value => value > 0);
        return remaining.length > 0 ? Math.min(...remaining) : 0;
    }

    clearAccountCooldown(authIndex) {
        const state = this._getAccountRouteState(authIndex);
        state.cooldownUntil = 0;
        state.modelCooldowns = {};
        state.modelRateLimitHits = {};
        state.rateLimitHits = 0;
        state.lastError = null;
        state.lastStatus = null;
    }

    async testAccount(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return { message: "Invalid account index.", status: 400, success: false };
        }
        if (!this.authSource.availableIndices.includes(authIndex)) {
            return { message: `Account #${authIndex} not found.`, status: 404, success: false };
        }

        try {
            // Prefer the already-loaded context so a diagnostic click does
            // not move the global UI account or disturb another request.
            let contextData = this.browserManager.contexts.get(authIndex);
            if (!contextData) {
                if (typeof this.browserManager.ensureContextForAuth === "function") {
                    const warmed = await this.browserManager.ensureContextForAuth(authIndex);
                    if (!warmed) {
                        return {
                            authIndex,
                            connected: false,
                            hasContext: false,
                            message: "Account could not be warmed without evicting a busy context.",
                            status: 503,
                            success: false,
                        };
                    }
                } else {
                    await this.browserManager.launchOrSwitchContext(authIndex);
                }
                contextData = this.browserManager.contexts.get(authIndex);
            }
            const connection = this.connectionRegistry.getConnectionByAuth(authIndex, false);
            if (!contextData?.page || contextData.page.isClosed() || !connection || connection.readyState !== 1) {
                return { message: "Account context or WebSocket is not ready.", status: 503, success: false };
            }
            await this.browserManager._checkPageStatusAndErrors(
                contextData.page,
                `[AccountTest#${authIndex}]`,
                authIndex
            );
            // A connectivity test does not prove that an upstream 429 quota
            // window has elapsed. Keep an active rate-limit quarantine intact;
            // otherwise clicking "Test" could immediately send new traffic to
            // the account that was just rate-limited.
            const routeState = this._getAccountRouteState(authIndex);
            const cooldownActive =
                routeState.cooldownUntil > Date.now() ||
                Object.values(routeState.modelCooldowns || {}).some(until => until > Date.now());
            if (!cooldownActive) {
                this._markAccountSuccess(authIndex);
            }
            return {
                ...this.getAccountRouteStatus(authIndex),
                authIndex,
                connected: true,
                cooldownPreserved: cooldownActive,
                hasContext: true,
                success: true,
            };
        } catch (error) {
            return {
                authIndex,
                connected: false,
                hasContext: false,
                message: error.message,
                status: 503,
                success: false,
            };
        }
    }

    _bindRequestAuthIndex(requestId, authIndex) {
        if (typeof requestId !== "string") return;
        if (Number.isInteger(authIndex) && authIndex >= 0) {
            const previous = this.requestAuthBindings.get(requestId);
            if (previous !== authIndex && Number.isInteger(previous) && previous >= 0) {
                const previousState = this._getAccountRouteState(previous);
                previousState.inFlight = Math.max(0, previousState.inFlight - 1);
            }
            this.requestAuthBindings.set(requestId, authIndex);
            if (previous !== authIndex) this._getAccountRouteState(authIndex).inFlight += 1;
        }
    }

    _getRequestAuthIndex(requestId, fallback = this.currentAuthIndex) {
        const bound = this.requestAuthBindings.get(requestId);
        if (Number.isInteger(bound) && bound >= 0) return bound;
        return Number.isInteger(fallback) && fallback >= 0 ? fallback : -1;
    }

    _releaseRequestAuthIndex(requestId) {
        const authIndex = this.requestAuthBindings.get(requestId);
        if (Number.isInteger(authIndex) && authIndex >= 0) {
            const state = this._getAccountRouteState(authIndex);
            state.inFlight = Math.max(0, state.inFlight - 1);
            if (state.inFlight === 0 && state.usageExhausted) {
                this._schedulePendingUsageRotations();
            }
        }
        this.requestAuthBindings.delete(requestId);
        this.requestModelBindings.delete(requestId);
    }

    _shouldRotateGlobalAccount() {
        // Global rotation is only safe when there is one live browser connection.
        // With multiple connections, request routing already provides distribution
        // and a global switch would invalidate unrelated in-flight requests.
        return this.connectionRegistry.getAllConnections().size <= 1;
    }

    async _handleRequestFailureScoped(errorDetails, requestId, sourceAuthIndex = null, sendErrorCallback = null) {
        const source =
            Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0
                ? sourceAuthIndex
                : this._getRequestAuthIndex(requestId);
        const failureCount = (this.requestFailureCounts.get(source) || 0) + 1;
        this.requestFailureCounts.set(source, failureCount);

        const status = Number(errorDetails?.status);
        const modelName = this._normalizeRouteModel(
            errorDetails?.modelName || this.requestModelBindings.get(requestId)
        );
        if (status === 429) {
            const state = this._getAccountRouteState(source);
            const modelCooldownUntil = modelName ? state.modelCooldowns?.[modelName] || 0 : state.cooldownUntil;
            if (state.lastStatus !== 429 || modelCooldownUntil <= Date.now()) {
                this._markAccount429ForModel(source, modelName, errorDetails);
            }
        }
        const immediate = this.config.immediateSwitchStatusCodes.includes(status);
        const thresholdReached = this.config.failureThreshold > 0 && failureCount >= this.config.failureThreshold;
        if (!immediate && !thresholdReached) return { success: false, switched: false };

        // Prefer an already-live account. This changes only this request's binding;
        // it does not mutate the global UI/recovery account used by other requests.
        const nextAuthIndex = this._selectRequestAuthIndex([source], modelName);
        if (nextAuthIndex >= 0) {
            this._bindRequestAuthIndex(requestId, nextAuthIndex);
            this.requestFailureCounts.set(source, 0);
            const message = `Request routed from account #${source} to account #${nextAuthIndex}.`;
            this.logger.warn(`[Request] ${message}`);
            if (sendErrorCallback) sendErrorCallback(message);
            return { newIndex: nextAuthIndex, success: true, switched: true };
        }

        if (status === 429) {
            return {
                rateLimited: true,
                retryAfterMs: Math.max(0, this.getNextCooldownMs(modelName)),
                success: false,
                switched: false,
            };
        }

        // If the pool has only one live connection, retain the existing recovery
        // behavior so a missing context can still be initialized.
        return this.authSwitcher.handleRequestFailureAndSwitch(errorDetails, sendErrorCallback);
    }

    // Delegate properties to AuthSwitcher
    get currentAuthIndex() {
        return this.authSwitcher.currentAuthIndex;
    }

    get failureCount() {
        return this.authSwitcher.failureCount;
    }

    get usageCount() {
        return this.authSwitcher.usageCount;
    }

    get isSystemBusy() {
        return this.authSwitcher.isSystemBusy;
    }

    set isSystemBusy(value) {
        this.authSwitcher.isSystemBusy = value === true;
    }

    _getUsageStatsService() {
        return this.serverSystem.usageStatsService || null;
    }

    _getAccountNameForIndex(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return null;
        }

        return this.authSource?.accountNameMap?.get(authIndex) || null;
    }

    _getClientIp(req) {
        return this.serverSystem.webRoutes.authRoutes.getClientIP(req);
    }

    _extractModelFromPath(pathValue) {
        if (typeof pathValue !== "string") return null;

        const match = pathValue.match(/\/models\/([^:/?]+)(?::|$)/);
        return match?.[1] || null;
    }

    _convertEmbedContentBodyToBatch(bodyObj, modelName) {
        return {
            requests: [
                {
                    ...bodyObj,
                    model: `models/${modelName}`,
                },
            ],
        };
    }

    _convertBatchEmbedResponseToEmbedContent(fullBodyBuffer) {
        const batchResponse = JSON.parse(fullBodyBuffer.toString());
        const embedding = Array.isArray(batchResponse.embeddings) ? batchResponse.embeddings[0] : null;

        if (!embedding) {
            throw new Error("Backend batchEmbedContents response did not contain embeddings[0].");
        }

        return Buffer.from(
            JSON.stringify({
                embedding,
                ...(batchResponse.usageMetadata ? { usageMetadata: batchResponse.usageMetadata } : {}),
            })
        );
    }

    _categorizeRequest(pathValue, fallback = "request") {
        if (typeof pathValue !== "string") return fallback;
        if (
            pathValue.includes("embedContent") ||
            pathValue.includes("batchEmbedContents") ||
            pathValue.includes("embeddings")
        )
            return "embedding";
        if (pathValue.includes("countTokens") || pathValue.includes("input_tokens")) return "count_tokens";
        if (pathValue.includes("generateContent") || pathValue.includes("streamGenerateContent")) return "generation";
        if (pathValue.includes("/upload/")) return "upload";
        return fallback;
    }

    _setResponseApiFormat(res, apiFormat) {
        if (!res || !apiFormat) return;
        res.__proxyApiFormat = apiFormat;
    }

    _resolveErrorFormat(res) {
        const trackedFormat = res?.__proxyApiFormat;
        if (trackedFormat && trackedFormat !== "upload") return trackedFormat;
        return "gemini";
    }

    _getDefaultErrorType(format, statusCode) {
        if (statusCode === 504) return "timeout_error";
        if (statusCode === 503) {
            return format === "claude" ? "overloaded_error" : "service_unavailable";
        }
        return "api_error";
    }

    _startTrackedRequest(requestId, req, meta = {}) {
        const requestedModel = this._getRequestedModel(req);
        if (requestedModel) {
            this.requestModelBindings.set(requestId, requestedModel);
        }
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        const initialAuthIndex = this._getRequestAuthIndex(requestId);

        usageStatsService.startRequest(requestId, {
            clientIp: this._getClientIp(req),
            initialAccountName: this._getAccountNameForIndex(initialAuthIndex),
            initialAuthIndex,
            method: req.method,
            path: req.path,
            ...meta,
        });
    }

    _updateTrackedRequest(requestId, patch = {}) {
        if (typeof requestId === "string" && patch.model) {
            this.requestModelBindings.set(requestId, this._normalizeRouteModel(patch.model));
        }
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;
        usageStatsService.updateRequest(requestId, patch);
    }

    _finalizeTrackedRequest(requestId, res, overrides = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        let outcome = overrides.outcome;
        if (!outcome) {
            if (res.__usageTrackingClientAborted) {
                outcome = "aborted";
            } else if (res.__usageTrackingOutcome) {
                outcome = res.__usageTrackingOutcome;
            } else {
                const statusCode = Number.isFinite(res.statusCode) ? Number(res.statusCode) : null;
                outcome = statusCode !== null && statusCode >= 400 ? "error" : "success";
            }
        }

        const statusCode =
            overrides.statusCode ??
            res.__usageTrackingErrorStatus ??
            (Number.isFinite(res.statusCode) && res.statusCode > 0 ? Number(res.statusCode) : null);

        const errorMessage =
            overrides.errorMessage ??
            res.__usageTrackingErrorMessage ??
            (outcome === "error" ? "Request failed" : null);

        usageStatsService.finishRequest(requestId, {
            errorMessage,
            finalAccountName: overrides.finalAccountName,
            finalAuthIndex: overrides.finalAuthIndex,
            outcome,
            statusCode,
        });
    }

    _markTrackedResponseError(res, message, statusCode = null, outcome = "error") {
        if (!res) return;
        res.__usageTrackingOutcome = outcome;
        res.__usageTrackingErrorMessage = message || null;
        if (Number.isFinite(statusCode)) {
            res.__usageTrackingErrorStatus = Number(statusCode);
        }
    }

    _markTrackedClientAbort(res, message = "Client disconnected") {
        if (!res) return;
        res.__usageTrackingClientAborted = true;
        res.__usageTrackingOutcome = "aborted";
        res.__usageTrackingErrorMessage = message;
    }

    _markTrackedEarlyExitIfNeeded(res, message = "Service temporarily unavailable.", statusCode = 503) {
        if (!res || res.__usageTrackingClientAborted || res.__usageTrackingOutcome) return;
        if (!this._isResponseWritable(res)) {
            this._markTrackedClientAbort(res, message);
            return;
        }
        this._markTrackedResponseError(res, message, statusCode);
    }

    // Delegate methods to AuthSwitcher
    async _switchToNextAuth() {
        return this.authSwitcher.switchToNextAuth();
    }

    async _switchToSpecificAuth(targetIndex) {
        return this.authSwitcher.switchToSpecificAuth(targetIndex);
    }

    async _waitForGraceReconnect(timeoutMs = WS_RECONNECT_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!this.connectionRegistry.isInGracePeriod() && !this.connectionRegistry.isReconnectingInProgress()) {
                const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                return connectionReady;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return !!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
    }

    _isConnectionResetError(error) {
        if (!error) return false;
        // Check for QueueClosedError type
        if (error instanceof QueueClosedError) return true;
        // Check for error code
        if (error.code === "QUEUE_CLOSED") return true;
        // Fallback to message check for backward compatibility
        if (error.message) {
            return (
                error.message.includes("Queue closed") ||
                error.message.includes("Queue is closed") ||
                error.message.includes("Connection lost")
            );
        }
        return false;
    }

    _logGeminiNativeChunkDebug(googleChunk, mode = "stream") {
        this.logger.debug(`[Proxy] Debug: Received Google chunk for Gemini native ${mode}: ${googleChunk}`);
    }

    _logGeminiNativeResponseDebug(googleResponse, mode = "non-stream") {
        try {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode}: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode} (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }
    }

    /**
     * Handle queue closed error in real streaming mode with proper SSE error response
     * @param {Error} error - The error object (QueueClosedError)
     * @param {Object} res - Express response object
     * @returns {boolean} true if error was handled, false otherwise
     */
    _handleRealStreamQueueClosedError(error, res) {
        const format = this._resolveErrorFormat(res);
        const isClientDisconnect = error.reason === "client_disconnect" || !this._isResponseWritable(res);

        if (isClientDisconnect) {
            // Client disconnected or queue closed due to client disconnect - no error needed
            this._markTrackedClientAbort(res, error.message || "Client disconnected");
            this.logger.debug(
                `[Request] ${format} stream interrupted by client disconnect (reason: ${error.reason || "connection_lost"})`
            );
            return true;
        }

        // Queue was closed for other reasons (account switch, page_closed, etc.)
        // but client is still connected - send proper error SSE
        this.logger.warn(
            `[Request] ${format} stream interrupted: Queue closed (reason: ${error.reason || "unknown"}), sending error SSE`
        );

        if (!this._isResponseWritable(res)) {
            return true;
        }

        try {
            const errorMessage = `Stream interrupted: ${error.reason === "page_closed" ? "Account context closed" : error.reason || "Connection lost"}`;
            this._markTrackedResponseError(res, errorMessage, 503);

            if (format === "claude") {
                // Claude format: event: error\ndata: {...}
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        error: {
                            message: errorMessage,
                            type: "api_error",
                        },
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "openai") {
                // OpenAI format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            type: "api_error",
                        },
                    })}\n\n`
                );
            } else if (format === "response_api") {
                // OpenAI Response API format: event: error\ndata: {...}
                if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                res.__responseApiSeq += 1;
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        code: "service_unavailable",
                        message: `Service unavailable: ${errorMessage}`,
                        param: null,
                        sequence_number: res.__responseApiSeq,
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "gemini") {
                // Gemini format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            status: "UNAVAILABLE",
                        },
                    })}\n\n`
                );
            }
        } catch (writeError) {
            this.logger.debug(`[Request] Failed to write error to ${format} stream: ${writeError.message}`);
        }

        return true;
    }

    /**
     * Classify and handle fake stream errors
     * @param {Error} error - The error object
     * @param {Object} res - Express response object
     * @throws {Error} Rethrows unexpected errors for outer handler
     */
    _handleFakeStreamError(error, res) {
        const format = this._resolveErrorFormat(res);
        if (!this._isResponseWritable(res)) {
            return; // Client disconnected, no need to send error
        }

        try {
            let errorPayload;
            let trackingStatus = 500;
            let trackingMessage = String(error?.message ?? error);

            if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                // True timeout error - 504
                trackingStatus = 504;
                trackingMessage = `Stream timeout: ${trackingMessage}`;
                if (format === "openai") {
                    errorPayload = {
                        error: {
                            code: 504,
                            message: `Stream timeout: ${error.message}`,
                            type: "timeout_error",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "claude") {
                    errorPayload = {
                        error: {
                            message: `Stream timeout: ${error.message}`,
                            type: "timeout_error",
                        },
                        type: "error",
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "response_api") {
                    // OpenAI Response API format
                    errorPayload = {
                        code: "timeout_error",
                        message: `Stream timeout: ${error.message}`,
                        param: null,
                        sequence_number: 0,
                        type: "error",
                    };
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    errorPayload.sequence_number = res.__responseApiSeq;
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else {
                    // gemini
                    errorPayload = {
                        error: {
                            code: 504,
                            message: `Stream timeout: ${error.message}`,
                            status: "DEADLINE_EXCEEDED",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                }
            } else if (error.code === "QUEUE_CLOSED" || error instanceof QueueClosedError) {
                // Queue closed (account switch, system reset, etc.) - 503
                trackingStatus = 503;
                trackingMessage = `Service unavailable: ${trackingMessage}`;
                if (format === "openai") {
                    errorPayload = {
                        error: {
                            code: 503,
                            message: `Service unavailable: ${error.message}`,
                            type: "service_unavailable",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "claude") {
                    errorPayload = {
                        error: {
                            message: `Service unavailable: ${error.message}`,
                            type: "overloaded_error",
                        },
                        type: "error",
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "response_api") {
                    // OpenAI Response API format
                    errorPayload = {
                        code: "service_unavailable",
                        message: `Service unavailable: ${error.message}`,
                        param: null,
                        sequence_number: 0,
                        type: "error",
                    };
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    errorPayload.sequence_number = res.__responseApiSeq;
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else {
                    // gemini
                    errorPayload = {
                        error: {
                            code: 503,
                            message: `Service unavailable: ${error.message}`,
                            status: "UNAVAILABLE",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                }
            } else {
                // Other unexpected errors - rethrow to outer handler
                throw error;
            }

            this._markTrackedResponseError(res, trackingMessage, trackingStatus);
        } catch (writeError) {
            this.logger.debug(`[Request] Failed to write fake stream error to client: ${writeError.message}`);
            // If write failed or unexpected error, rethrow original error
            throw error;
        }
    }

    /**
     * Wait for WebSocket connection to be established for current account
     * @param {number} timeoutMs - Maximum time to wait in milliseconds
     * @returns {Promise<boolean>} true if connection established, false if timeout
     */
    async _waitForConnection(timeoutMs = 10000) {
        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            const connection = this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
            // Check both existence and readyState (1 = OPEN)
            if (connection && connection.readyState === 1) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(
            `[Request] Timeout waiting for WebSocket connection for account #${this.currentAuthIndex}. Closing unresponsive context...`
        );
        // Proactively close the unresponsive context so subsequent attempts re-initialize it
        if (this.browserManager) {
            try {
                await this.browserManager.closeContext(this.currentAuthIndex);
            } catch (e) {
                this.logger.warn(
                    `[System] Failed to close unresponsive context for account #${this.currentAuthIndex}: ${e.message}`
                );
            }
        }
        return false;
    }

    /**
     * Wait for system to become ready (not busy with switching/recovery)
     * @param {number} timeoutMs - Maximum time to wait in milliseconds (default 120s, same as browser launch timeout)
     * @returns {Promise<boolean>} true if system becomes ready, false if timeout
     */
    async _waitForSystemReady(timeoutMs = 120000) {
        if (!this.authSwitcher.isSystemBusy) {
            return true;
        }

        this.logger.info(`[System] System is busy (switching/recovering), waiting up to ${timeoutMs / 1000}s...`);

        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            if (!this.authSwitcher.isSystemBusy) {
                this.logger.info(`[System] System ready after ${Date.now() - startTime}ms.`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(`[System] Timeout waiting for system after ${timeoutMs}ms.`);
        return false;
    }

    async _waitForSystemAndConnectionIfBusy(res = null, options = {}) {
        const {
            busyMessage = "Server undergoing internal maintenance (account switching/recovery), please try again later.",
            connectionMessage = "Service temporarily unavailable: Connection not established after switching.",
            connectionTimeoutMs = WS_CONNECTION_READY_TIMEOUT_MS,
            onConnectionTimeout,
            sendError = res ? (status, message) => this._sendErrorResponse(res, status, message) : () => {},
        } = options;

        const ready = await this._waitForSystemReady();
        if (!ready) {
            sendError(503, busyMessage);
            return false;
        }

        if (!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex)) {
            const connectionReady = await this._waitForConnection(connectionTimeoutMs);
            if (!connectionReady) {
                if (typeof onConnectionTimeout === "function") {
                    try {
                        onConnectionTimeout();
                    } catch (e) {
                        this.logger.debug(`[System] onConnectionTimeout handler failed: ${e.message}`);
                    }
                }
                sendError(503, connectionMessage);
                return false;
            }
        }

        return true;
    }

    async _ensureBrowserBackedRequestReady(res, options = {}) {
        const { logPrefix = "Request", waitErrorType = null, waitOptions, authIndex, requestId } = options;
        const routeModel = this.requestModelBindings.get(requestId) || null;

        // HTTP starts listening before the initial context pool is ready. A
        // health check or client request during that window must wait for the
        // single startup workflow instead of launching a second browser or
        // aborting its background preload.
        if (this.authSwitcher.isSystemBusy) {
            const systemReady = await this._waitForSystemReady();
            if (!systemReady) {
                this._sendErrorResponse(
                    res,
                    503,
                    "Service temporarily unavailable: browser startup is still in progress.",
                    waitErrorType
                );
                this._markTrackedEarlyExitIfNeeded(res, "Initial browser startup did not finish in time.");
                return false;
            }
        }

        let targetAuthIndex = this._getRequestAuthIndex(requestId, authIndex);

        if (targetAuthIndex < 0) {
            // Startup/recovery can briefly have no current account while a
            // background context is already ready. Bind to that connection
            // before returning a transient 503.
            let replacementAuthIndex = this._selectRequestAuthIndex([], routeModel);
            if (replacementAuthIndex < 0) {
                await this._warmStandbyForModel(routeModel);
                replacementAuthIndex = this._selectRequestAuthIndex([], routeModel);
            }
            if (replacementAuthIndex >= 0) {
                targetAuthIndex = replacementAuthIndex;
                this._bindRequestAuthIndex(requestId, replacementAuthIndex);
            } else {
                const cooldownMs = this.getNextCooldownMs(routeModel);
                if (cooldownMs > 0) {
                    res.setHeader("Retry-After", Math.ceil(cooldownMs / 1000));
                    this._sendErrorResponse(res, 429, "All accounts are temporarily rate-limited.", waitErrorType);
                } else {
                    // No live connection exists yet. Run the normal recovery
                    // path so an initial request can initialize an account
                    // instead of failing before recovery gets a chance.
                    const recovered = await this._handleBrowserRecovery(res);
                    if (!recovered) {
                        this._markTrackedEarlyExitIfNeeded(res, "No schedulable account connection.");
                        return false;
                    }

                    const recoveredAuthIndex = this._selectRequestAuthIndex();
                    if (recoveredAuthIndex < 0) {
                        this._sendErrorResponse(res, 503, "No healthy account connection is available.", waitErrorType);
                        this._markTrackedEarlyExitIfNeeded(res, "No schedulable account connection.");
                        return false;
                    }
                    targetAuthIndex = recoveredAuthIndex;
                    this._bindRequestAuthIndex(requestId, recoveredAuthIndex);
                }
            }
            if (targetAuthIndex < 0) {
                this._markTrackedEarlyExitIfNeeded(res, "No schedulable account connection.");
                return false;
            }
        }

        // A request may have been assigned while the account was healthy, then
        // waited behind another request that received 429. Re-check the
        // quarantine immediately before touching the browser connection.
        const targetRouteState = this._getAccountRouteState(targetAuthIndex);
        const targetModelCooldownUntil = routeModel ? targetRouteState.modelCooldowns?.[routeModel] || 0 : 0;
        const targetUsageExhausted =
            this._isPerAccountUsageRoutingEnabled() && targetRouteState.usageExhausted === true;
        if (
            targetRouteState.cooldownUntil > Date.now() ||
            targetModelCooldownUntil > Date.now() ||
            targetUsageExhausted
        ) {
            const replacementAuthIndex = this._selectRequestAuthIndex([targetAuthIndex], routeModel);
            if (replacementAuthIndex >= 0) {
                targetAuthIndex = replacementAuthIndex;
                this._bindRequestAuthIndex(requestId, replacementAuthIndex);
            } else {
                await this._warmStandbyForModel(routeModel, [targetAuthIndex]);
                const warmedAuthIndex = this._selectRequestAuthIndex([], routeModel);
                if (warmedAuthIndex >= 0) {
                    targetAuthIndex = warmedAuthIndex;
                    this._bindRequestAuthIndex(requestId, warmedAuthIndex);
                    return this._ensureBrowserBackedRequestReady(res, options);
                }
                if (targetUsageExhausted) {
                    this._schedulePendingUsageRotations();
                    this._sendErrorResponse(
                        res,
                        503,
                        "Account pool is rotating; no fresh account connection is ready yet.",
                        waitErrorType
                    );
                    this._markTrackedEarlyExitIfNeeded(res, "Account usage threshold reached while pool was rotating.");
                    return false;
                }
                const cooldownMs = this.getNextCooldownMs(routeModel);
                res.setHeader("Retry-After", Math.max(1, Math.ceil(cooldownMs / 1000)));
                this._sendErrorResponse(res, 429, "All accounts are temporarily rate-limited.", waitErrorType);
                this._markTrackedEarlyExitIfNeeded(res, "Assigned account entered 429 cooldown.");
                return false;
            }
        }

        // Check the request's account connection. Do not consult the mutable global
        // current account once a request has been assigned to a connection.
        if (!this.connectionRegistry.getConnectionByAuth(targetAuthIndex)) {
            this.logger.warn(`[${logPrefix}] No WebSocket connection for account #${targetAuthIndex}`);
            const contextData = this.browserManager?.contexts?.get(targetAuthIndex);
            let recovered = false;
            if (contextData?.page && !contextData.page.isClosed()) {
                recovered = await this.browserManager.attemptLightweightReconnect(targetAuthIndex);
                if (recovered) {
                    recovered = await this._waitForConnectionForAuth(targetAuthIndex, WS_CONNECTION_READY_TIMEOUT_MS);
                }
            }
            if (!recovered) recovered = await this._handleBrowserRecovery(res);
            if (!recovered) {
                this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: Browser recovery failed.");
                return false;
            }
            if (requestId) {
                const boundAuthIndex = this._getRequestAuthIndex(requestId, -1);
                if (!this.connectionRegistry.getConnectionByAuth(boundAuthIndex, false)) {
                    const replacementAuthIndex = this._selectRequestAuthIndex();
                    this._bindRequestAuthIndex(
                        requestId,
                        replacementAuthIndex >= 0 ? replacementAuthIndex : this.currentAuthIndex
                    );
                }
            }
        }

        // Wait for system to become ready if it's busy
        const effectiveWaitOptions =
            waitOptions === undefined && waitErrorType
                ? {
                      sendError: (status, message) => this._sendErrorResponse(res, status, message, waitErrorType),
                  }
                : waitOptions;
        const targetConnection = this.connectionRegistry.getConnectionByAuth(targetAuthIndex, false);
        const ready =
            targetConnection && targetConnection.readyState === 1
                ? true
                : effectiveWaitOptions === undefined
                  ? await this._waitForSystemAndConnectionIfBusy(res)
                  : await this._waitForSystemAndConnectionIfBusy(res, effectiveWaitOptions);
        if (!ready) {
            this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: System not ready.");
            return false;
        }

        if (this.browserManager) {
            this.browserManager.notifyUserActivity();
        }

        return true;
    }

    async _waitForConnectionForAuth(authIndex, timeoutMs = WS_CONNECTION_READY_TIMEOUT_MS) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const connection = this.connectionRegistry.getConnectionByAuth(authIndex, false);
            if (connection && connection.readyState === 1) return true;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return false;
    }

    _createImmediateSwitchTracker(initialAuthIndex = this.currentAuthIndex, modelName = null) {
        const attemptedAuthIndices = new Set();
        if (Number.isInteger(initialAuthIndex) && initialAuthIndex >= 0) {
            attemptedAuthIndices.add(initialAuthIndex);
        }
        return { attemptedAuthIndices, modelName: this._normalizeRouteModel(modelName) };
    }

    _getImmediateStatusRetryCloseReason(status) {
        return `immediate_status_retry_${status}`;
    }

    async _performImmediateSwitchRetry(errorDetails, requestId, tracker) {
        const sourceAuthIndex = this._getRequestAuthIndex(requestId);
        const nextAuthIndex = this._selectRequestAuthIndex(
            [sourceAuthIndex, ...tracker.attemptedAuthIndices],
            tracker.modelName
        );
        if (nextAuthIndex >= 0) {
            this._bindRequestAuthIndex(requestId, nextAuthIndex);
            tracker.attemptedAuthIndices.add(nextAuthIndex);
            this.logger.warn(
                `[Request] Immediate retry for request #${requestId} routed from account #${sourceAuthIndex} to account #${nextAuthIndex}.`
            );
            return true;
        }

        // A 429 quarantines the source account. Do not fall back to the global
        // account switcher here, because it can immediately select that same
        // rate-limited context and defeat the quarantine.
        if (Number(errorDetails?.status) === 429) return false;

        await this.authSwitcher.handleRequestFailureAndSwitch(
            { message: errorDetails.message, status: Number(errorDetails.status) },
            null
        );

        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
            sendError: () => {},
        });
        if (!ready) {
            throw new Error("System not ready after immediate-switch retry.");
        }

        const newAuthIndex = this.currentAuthIndex;
        if (!Number.isInteger(newAuthIndex) || newAuthIndex < 0) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} did not produce a valid target account.`
            );
            return false;
        }

        if (tracker.attemptedAuthIndices.has(newAuthIndex)) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} returned to already-attempted account #${newAuthIndex}, stopping account-switch retries.`
            );
            return false;
        }

        tracker.attemptedAuthIndices.add(newAuthIndex);
        return true;
    }

    async _prepareImmediateStatusRetry(errorDetails, requestId, tracker, sourceAuthIndex) {
        const currentAuthIndex = this._getRequestAuthIndex(requestId, this.currentAuthIndex);
        const hasSourceAuth = Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0;
        const hasCurrentAuth = Number.isInteger(currentAuthIndex) && currentAuthIndex >= 0;

        if (hasSourceAuth && hasCurrentAuth && sourceAuthIndex !== currentAuthIndex) {
            const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                sendError: () => {},
            });
            if (!ready) {
                throw new Error(
                    `System not ready after non-current account retry preparation for request #${requestId}: ` +
                        `status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, currentAuthIndex=${currentAuthIndex}.`
                );
            }

            let retryAuthIndex = this._selectRequestAuthIndex(
                [sourceAuthIndex, ...tracker.attemptedAuthIndices],
                tracker.modelName
            );
            if (retryAuthIndex < 0 && Number(errorDetails?.status) === 429) {
                await this._warmStandbyForModel(tracker.modelName, [sourceAuthIndex, ...tracker.attemptedAuthIndices]);
                retryAuthIndex = this._selectRequestAuthIndex(
                    [sourceAuthIndex, ...tracker.attemptedAuthIndices],
                    tracker.modelName
                );
            }
            if (sourceAuthIndex === retryAuthIndex) {
                return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
            }
            if (!Number.isInteger(retryAuthIndex) || retryAuthIndex < 0) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} did not find a valid current account ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, retryAuthIndex=${retryAuthIndex}).`
                );
                return false;
            }
            if (tracker.attemptedAuthIndices.has(retryAuthIndex)) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} would reuse already-attempted account #${retryAuthIndex} ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}), stopping account-switch retries.`
                );
                return false;
            }

            this.logger.warn(
                `[Request] Received ${errorDetails.status} from non-current account #${sourceAuthIndex}; ` +
                    `retrying request #${requestId} on current account #${retryAuthIndex} without switching.`
            );

            tracker.attemptedAuthIndices.add(retryAuthIndex);
            this._bindRequestAuthIndex(requestId, retryAuthIndex);
            return true;
        }

        return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
    }

    _logFinalRequestFailure(errorDetails, contextLabel = "Request", requestId = null, options = {}) {
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";
        const failurePhase = options.afterRetries === false ? "failed" : "failed after retries";
        this.logger.error(
            `❌ [Request] ${contextLabel} ${failurePhase}. Status code: ${errorDetails?.status || 500}, message: ${errorDetails?.message || "Unknown error"}${requestIdSuffix}`
        );
    }

    /**
     * Handle browser recovery when connection is lost
     *
     * Important: isSystemBusy flag management strategy:
     * - Direct recovery (recoveryAuthIndex >= 0): We manually set and reset isSystemBusy
     * - Switch to next account (recoveryAuthIndex = -1): Let switchToNextAuth() manage isSystemBusy internally
     * - This prevents the bug where isSystemBusy is set here, then switchToNextAuth() checks it and returns "already in progress"
     *
     * @returns {boolean} true if recovery successful, false otherwise
     */
    async _handleBrowserRecovery(res) {
        // If within grace period or lightweight reconnect is running, wait up to 130s for WebSocket reconnection
        if (this.connectionRegistry.isInGracePeriod() || this.connectionRegistry.isReconnectingInProgress()) {
            this.logger.info(
                "[System] Waiting up to 130s for WebSocket reconnection (grace/reconnect in progress) before full recovery..."
            );
            const reconnected = await this._waitForGraceReconnect(WS_RECONNECT_WAIT_MS);
            if (reconnected) {
                this.logger.info("[System] Connection restored, skipping recovery.");
                return true;
            }
            this.logger.warn("[System] Reconnection wait expired, proceeding to recovery workflow.");
        }

        // Wait for system to become ready if it's busy (someone else is starting/switching browser)
        if (this.authSwitcher.isSystemBusy) {
            return await this._waitForSystemAndConnectionIfBusy(res, {
                connectionMessage: "Service temporarily unavailable: Browser failed to start. Please try again.",
                onConnectionTimeout: () => {
                    this.logger.error(
                        `[System] WebSocket connection not established for account #${this.currentAuthIndex} after system ready, browser startup may have failed.`
                    );
                },
            });
        }

        // Determine if this is first-time startup or actual crash recovery
        const recoveryAuthIndex = this.currentAuthIndex;
        const isFirstTimeStartup = recoveryAuthIndex < 0 && !this.browserManager.browser;

        if (isFirstTimeStartup) {
            this.logger.info(
                "🚀 [System] Browser not yet started. Initializing browser with first available account..."
            );
        } else {
            this.logger.error(
                "❌ [System] Browser WebSocket connection disconnected! Possible process crash. Attempting recovery..."
            );
        }

        let wasDirectRecovery = false;
        let recoverySuccess = false;

        try {
            if (recoveryAuthIndex >= 0) {
                // Direct recovery: we manage isSystemBusy ourselves
                wasDirectRecovery = true;
                this.authSwitcher.isSystemBusy = true;
                this.logger.info(`[System] Set isSystemBusy=true for direct recovery to account #${recoveryAuthIndex}`);

                await this.browserManager.preCleanupForSwitch(recoveryAuthIndex);
                await this.browserManager.launchOrSwitchContext(recoveryAuthIndex);
                this.logger.info(`✅ [System] Browser successfully recovered to account #${recoveryAuthIndex}!`);

                // Wait for WebSocket connection to be established
                this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                if (!connectionReady) {
                    throw new Error("WebSocket connection not established within timeout period");
                }
                this.logger.info("✅ [System] WebSocket connection is ready!");
                recoverySuccess = true;
            } else if (this.authSource.getRotationIndices().length > 0) {
                // Don't set isSystemBusy here - let switchToNextAuth manage it
                const result = await this.authSwitcher.switchToNextAuth();
                if (!result.success) {
                    this.logger.error(`❌ [System] Failed to switch to available account: ${result.reason}`);
                    await this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                    recoverySuccess = false;
                } else {
                    this.logger.info(`✅ [System] Successfully recovered to account #${result.newIndex}!`);

                    // Wait for WebSocket connection to be established
                    this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                    const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                    if (!connectionReady) {
                        throw new Error("WebSocket connection not established within timeout period");
                    }
                    this.logger.info("✅ [System] WebSocket connection is ready!");
                    recoverySuccess = true;
                }
            } else {
                this.logger.error("❌ [System] No available accounts for recovery.");
                await this._sendErrorResponse(res, 503, "Service temporarily unavailable: No available accounts.");
                recoverySuccess = false;
            }
        } catch (error) {
            this.logger.error(`❌ [System] Recovery failed: ${error.message}`);

            if (wasDirectRecovery && this.authSource.getRotationIndices().length > 1) {
                this.logger.warn("⚠️ [System] Attempting to switch to alternative account...");
                // Reset isSystemBusy before calling switchToNextAuth to avoid "already in progress" rejection
                this.authSwitcher.isSystemBusy = false;
                wasDirectRecovery = false; // Prevent finally block from resetting again
                try {
                    const result = await this.authSwitcher.switchToNextAuth();
                    if (!result.success) {
                        this.logger.error(`❌ [System] Failed to switch to alternative account: ${result.reason}`);
                        await this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                        recoverySuccess = false;
                    } else {
                        this.logger.info(
                            `✅ [System] Successfully switched to alternative account #${result.newIndex}!`
                        );

                        // Wait for WebSocket connection to be established
                        this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                        const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                        if (!connectionReady) {
                            throw new Error("WebSocket connection not established within timeout period");
                        }
                        this.logger.info("✅ [System] WebSocket connection is ready!");
                        recoverySuccess = true;
                    }
                } catch (switchError) {
                    this.logger.error(`❌ [System] All accounts failed: ${switchError.message}`);
                    await this._sendErrorResponse(res, 503, "Service temporarily unavailable: All accounts failed.");
                    recoverySuccess = false;
                }
            } else {
                await this._sendErrorResponse(
                    res,
                    503,
                    "Service temporarily unavailable: Browser crashed and cannot auto-recover."
                );
                recoverySuccess = false;
            }
        } finally {
            // Only reset if we set it (for direct recovery attempt)
            if (wasDirectRecovery) {
                this.logger.info("[System] Resetting isSystemBusy=false in recovery finally block");
                this.authSwitcher.isSystemBusy = false;
            }
        }

        return recoverySuccess;
    }

    // Process standard Google API requests
    async processRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "gemini",
            requestCategory: this._categorizeRequest(req.path, "request"),
        });
        this._setResponseApiFormat(res, "gemini");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { authIndex: requestAuthIndex, requestId }))) {
                return;
            }

            // Handle usage-based account switching
            const isGenerativeRequest =
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent"));

            if (isGenerativeRequest) {
                this._incrementGenerationUsage(requestId, requestAuthIndex, "Google generation request");
            }

            const proxyRequest = this._buildProxyRequest(req, requestId);
            proxyRequest.is_generative = isGenerativeRequest;
            this._initializeProxyRequestAttempt(proxyRequest);

            const wantsStream = req.path.includes(":streamGenerateContent");
            res.__proxyResponseStreamMode = wantsStream ? proxyRequest.streaming_mode : null;

            this._updateTrackedRequest(requestId, {
                isStreaming: wantsStream,
                model: this._extractModelFromPath(proxyRequest.path),
                path: proxyRequest.path,
                requestCategory: this._categorizeRequest(
                    proxyRequest.path,
                    isGenerativeRequest ? "generation" : "request"
                ),
                streamMode: wantsStream ? proxyRequest.streaming_mode : null,
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (wantsStream) {
                    if (proxyRequest.streaming_mode === "fake") {
                        await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);
                    } else {
                        await this._handleRealStreamResponse(proxyRequest, messageQueue, req, res);
                    }
                } else {
                    proxyRequest.streaming_mode = "fake";
                    await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest && this._shouldRotateGlobalAccount()) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
            this._schedulePendingUsageRotations();
        }
    }

    // Process OpenAI embeddings requests
    async processOpenAIEmbeddingsRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: false,
            requestCategory: "embedding",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "service_unavailable",
                }))
            ) {
                return;
            }

            const { cleanModelName, googleRequest, path } = this.formatConverter.translateOpenAIEmbeddingsToGoogle(
                req.body
            );
            const proxyRequest = {
                body: JSON.stringify(googleRequest),
                headers: req.headers,
                is_generative: false,
                method: "POST",
                path,
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "fake",
                tracking_model: cleanModelName,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                isStreaming: false,
                model: proxyRequest.tracking_model,
                path: proxyRequest.path,
                requestCategory: "embedding",
                streamMode: null,
            });

            try {
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleQueueTimeout(error, requestId);
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process File Upload requests
    async processUploadRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this.logger.info(`[Upload] Processing upload request ${req.method} ${req.path}, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "upload",
            isStreaming: false,
            requestCategory: "upload",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "upload");

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    logPrefix: "Upload",
                    requestId,
                }))
            ) {
                return;
            }

            const uploadBodyBuffer = this._patchUploadStartMetadata(req);
            const proxyRequest = {
                body_b64: uploadBodyBuffer ? uploadBodyBuffer.toString("base64") : undefined,
                headers: req.headers,
                is_generative: false, // Uploads are never generative
                method: req.method,
                path: req.path.replace(/^\/proxy/, ""),
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "fake", // Uploads always return a single JSON response
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                path: proxyRequest.path,
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    _patchUploadStartMetadata(req) {
        const originalBody = req.rawBody;

        if (!this._isUploadStartRequest(req)) return originalBody;

        const uploadContentType = req.headers["x-goog-upload-header-content-type"];
        if (!uploadContentType || !originalBody?.length) return originalBody;

        let bodyObj;
        try {
            bodyObj = JSON.parse(originalBody.toString());
        } catch (e) {
            this.logger.debug(`[Upload] Start metadata is not valid JSON, skipping mimeType patch: ${e.message}`);
            return originalBody;
        }

        if (!bodyObj || typeof bodyObj !== "object") return originalBody;

        const fileMetadata = bodyObj.file || bodyObj.file_metadata || bodyObj;
        if (!fileMetadata || typeof fileMetadata !== "object") return originalBody;

        if (fileMetadata.mimeType || fileMetadata.mime_type) {
            return originalBody;
        }

        fileMetadata.mimeType = uploadContentType;
        return Buffer.from(JSON.stringify(bodyObj));
    }

    _isUploadStartRequest(req) {
        const command = String(req.headers["x-goog-upload-command"] || "").toLowerCase();
        return req.method === "POST" && req.path.includes("/upload/") && command.includes("start");
    }

    // Process OpenAI format requests
    async processOpenAIRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "service_unavailable",
                }))
            ) {
                return;
            }

            const isOpenAIStream = req.body.stream === true;
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting per assigned account in multi-context mode.
            this._incrementGenerationUsage(requestId, requestAuthIndex, "OpenAI generation request");

            // Translate OpenAI format to Google format (also handles model name suffix parsing)
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid OpenAI request format.", "invalid_request_error");
            }

            const effectiveStreamMode = modelStreamingMode || systemStreamMode;
            const useRealStream = isOpenAIStream && effectiveStreamMode === "real";
            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            res.__proxyResponseStreamMode = isOpenAIStream ? (useRealStream ? "real" : "fake") : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isOpenAIStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isOpenAIStream ? { streamMode: useRealStream ? "real" : "fake" } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(
                        currentQueueAuthIndex,
                        this._getProxyRequestModel(proxyRequest)
                    );

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        this._forwardRequest(proxyRequest, currentQueueAuthIndex);
                        initialMessage = await currentQueue.dequeue();

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this.config?.immediateSwitchStatusCodes?.includes(initialStatus)
                        ) {
                            this.logger.warn(
                                `[Request] OpenAI real stream received ${initialStatus}, preparing retry...`
                            );
                            this._markImmediateRateLimitIfNeeded(
                                currentQueueAuthIndex,
                                this._getProxyRequestModel(proxyRequest),
                                initialMessage
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this._getRequestAuthIndex(requestId, requestAuthIndex),
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "OpenAI real stream", requestId, {
                            afterRetries: false,
                        });

                        // Send standard HTTP error response
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message);

                        // Avoid switching account if the error is just a connection reset
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this._handleRequestFailureScoped(initialMessage, requestId);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        } else {
                            this.logger.info(
                                "[Request] Failure due to connection reset (Real Stream), skipping account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI interface request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] OpenAI streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponse(currentQueue, res, model, requestId);
                } else {
                    // OpenAI Fake Stream / Non-Stream mode
                    // Set up keep-alive timer for fake stream mode to prevent client timeout
                    let connectionMaintainer;
                    if (isOpenAIStream) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write(": keep-alive\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(result.error, "OpenAI fake/non-stream", requestId);
                            // Send standard HTTP error response for both streaming and non-streaming
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isOpenAIStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(res, result.error.status || 500, result.error.message);
                            }

                            // Avoid switching account if the error is just a connection reset
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this._handleRequestFailureScoped(result.error, requestId);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            } else {
                                this.logger.info(
                                    "[Request] Failure due to connection reset (OpenAI), skipping account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(
                                `✅ [Auth] OpenAI interface request successful - failure count reset to 0`
                            );
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isOpenAIStream) {
                            // Fake stream - ensure headers are set before sending data
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                });
                            }
                            // Clear keep-alive timer as we are about to send real data
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] OpenAI streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        this.logger.error(
                                            `❌ [Request] Error received during OpenAI fake stream: ${message.message}`
                                        );
                                        this._markTrackedResponseError(res, message.message, 500);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.write(
                                                    `data: ${JSON.stringify({ error: { code: 500, message: message.message, type: "api_error" } })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to OpenAI fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (message.data) fullBody += message.data;
                                }
                                if (hadStreamError) {
                                    // Backend errored; don't attempt to translate/send a "normal" stream afterwards.
                                    return;
                                }
                                const streamState = {};
                                const translatedChunk = this.formatConverter.translateGoogleToOpenAIStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                        res.write("data: [DONE]\n\n");
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake OpenAI stream chunks: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake OpenAI stream chunks."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (OpenAI fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendOpenAINonStreamResponse(activeQueue, res, model, requestId);
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest && this._shouldRotateGlobalAccount()) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
            this._schedulePendingUsageRotations();
        }
    }

    // Process OpenAI Response API format requests
    async processOpenAIResponseRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "response_api");
        res.__proxyResponseStreamMode = null;

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "service_unavailable",
                }))
            ) {
                return;
            }

            const isOpenAIStream = req.body.stream === true;
            const normalizeInstructions = value => {
                if (typeof value === "string") return value;
                if (!Array.isArray(value)) return null;
                const chunks = [];
                for (const item of value) {
                    if (!item || typeof item !== "object") continue;
                    const content = item.content;
                    if (typeof content === "string") {
                        chunks.push(content);
                        continue;
                    }
                    if (!Array.isArray(content)) continue;
                    for (const part of content) {
                        if (!part || typeof part !== "object") continue;
                        if (part.type === "text" || part.type === "input_text") {
                            if (typeof part.text === "string" && part.text) chunks.push(part.text);
                        }
                    }
                }
                return chunks.length > 0 ? chunks.join("\n") : null;
            };
            const responseDefaultsRaw = {
                instructions: normalizeInstructions(req.body?.instructions),
                max_output_tokens: req.body?.max_output_tokens ?? null,
                metadata:
                    req.body?.metadata && typeof req.body.metadata === "object" && !Array.isArray(req.body.metadata)
                        ? req.body.metadata
                        : {},
                parallel_tool_calls:
                    typeof req.body?.parallel_tool_calls === "boolean" ? req.body.parallel_tool_calls : true,
                reasoning:
                    req.body?.reasoning && typeof req.body.reasoning === "object" && !Array.isArray(req.body.reasoning)
                        ? req.body.reasoning
                        : undefined,
                temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
                text:
                    req.body?.text && typeof req.body.text === "object" && !Array.isArray(req.body.text)
                        ? req.body.text
                        : undefined,
                tool_choice: req.body?.tool_choice ?? undefined,
                tools: Array.isArray(req.body?.tools) ? req.body.tools : undefined,
                top_p: typeof req.body?.top_p === "number" ? req.body.top_p : undefined,
                truncation: typeof req.body?.truncation === "string" ? req.body.truncation : undefined,
                user: typeof req.body?.user === "string" ? req.body.user : undefined,
            };

            const responseDefaults = Object.fromEntries(
                Object.entries(responseDefaultsRaw).filter(([, v]) => v !== undefined)
            );
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting per assigned account in multi-context mode.
            this._incrementGenerationUsage(requestId, requestAuthIndex, "OpenAI Response generation request");

            // Translate OpenAI Response format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
            }

            const effectiveStreamMode = modelStreamingMode || systemStreamMode;
            const useRealStream = isOpenAIStream && effectiveStreamMode === "real";

            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            res.__proxyResponseStreamMode = isOpenAIStream ? (useRealStream ? "real" : "fake") : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isOpenAIStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isOpenAIStream ? { streamMode: useRealStream ? "real" : "fake" } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(
                        currentQueueAuthIndex,
                        this._getProxyRequestModel(proxyRequest)
                    );

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        this._forwardRequest(proxyRequest, currentQueueAuthIndex);
                        initialMessage = await currentQueue.dequeue();

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this.config?.immediateSwitchStatusCodes?.includes(initialStatus)
                        ) {
                            this.logger.warn(
                                `[Request] OpenAI Response API real stream received ${initialStatus}, preparing retry...`
                            );
                            this._markImmediateRateLimitIfNeeded(
                                currentQueueAuthIndex,
                                this._getProxyRequestModel(proxyRequest),
                                initialMessage
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this._getRequestAuthIndex(requestId, requestAuthIndex),
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "OpenAI Response API real stream", requestId, {
                            afterRetries: false,
                        });

                        // Send standard HTTP error response
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message);

                        // Avoid switching account if the error is just a connection reset
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this._handleRequestFailureScoped(initialMessage, requestId);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        } else {
                            this.logger.info(
                                "[Request] Failure due to connection reset (Real Stream), skipping account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI Response API request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] OpenAI Response API streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponseAPIResponse(currentQueue, res, model, {
                        requestId,
                        responseDefaults,
                    });
                } else {
                    // OpenAI Response API Fake Stream / Non-Stream mode
                    // Set up keep-alive timer for fake stream mode to prevent client timeout
                    let connectionMaintainer;
                    if (isOpenAIStream) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write(": keep-alive\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(
                                result.error,
                                "OpenAI Response API fake/non-stream",
                                requestId
                            );
                            // Send standard HTTP error response for both streaming and non-streaming
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isOpenAIStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(res, result.error.status || 500, result.error.message);
                            }

                            // Avoid switching account if the error is just a connection reset
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this._handleRequestFailureScoped(result.error, requestId);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            } else {
                                this.logger.info(
                                    "[Request] Failure due to connection reset (Response API), skipping account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(
                                `✅ [Auth] OpenAI Response API request successful - failure count reset to 0`
                            );
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isOpenAIStream) {
                            // Fake stream - ensure headers are set before sending data
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                });
                            }
                            // Clear keep-alive timer as we are about to send real data
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] OpenAI Response API streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        this.logger.error(
                                            `❌ [Request] Error received during OpenAI Response API fake stream: ${message.message}`
                                        );
                                        this._markTrackedResponseError(res, message.message, 500);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.__responseApiSeq += 1;
                                                res.write(
                                                    `event: error\ndata: ${JSON.stringify({
                                                        code: "api_error",
                                                        message: message.message,
                                                        param: null,
                                                        sequence_number: res.__responseApiSeq,
                                                        type: "error",
                                                    })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to OpenAI Response API fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (message.data) fullBody += message.data;
                                }

                                // If backend errored, don't attempt to translate/send a "normal" Responses stream afterwards.
                                if (hadStreamError) {
                                    return;
                                }

                                const streamState = {};
                                streamState.responseDefaults = responseDefaults;
                                const translatedChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake OpenAI Response API stream chunks: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake OpenAI Response API stream chunks."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (OpenAI Response API fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendOpenAIResponseAPINonStreamResponse(
                                activeQueue,
                                res,
                                model,
                                requestId,
                                responseDefaults
                            );
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest && this._shouldRotateGlobalAccount()) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
            this._schedulePendingUsageRotations();
        }
    }

    // Process Claude API format requests
    async processClaudeRequest(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "claude");
        res.__proxyResponseStreamMode = null;

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "overloaded_error",
                }))
            ) {
                return;
            }

            const isClaudeStream = req.body.stream === true;
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting per assigned account in multi-context mode.
            this._incrementGenerationUsage(requestId, requestAuthIndex, "Claude generation request");

            // Translate Claude format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            const effectiveStreamMode = modelStreamingMode || systemStreamMode;
            const useRealStream = isClaudeStream && effectiveStreamMode === "real";

            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            res.__proxyResponseStreamMode = isClaudeStream ? (useRealStream ? "real" : "fake") : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isClaudeStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isClaudeStream ? { streamMode: useRealStream ? "real" : "fake" } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(
                        currentQueueAuthIndex,
                        this._getProxyRequestModel(proxyRequest)
                    );

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        this._forwardRequest(proxyRequest, currentQueueAuthIndex);
                        initialMessage = await currentQueue.dequeue();

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this.config?.immediateSwitchStatusCodes?.includes(initialStatus)
                        ) {
                            this.logger.warn(
                                `[Request] Claude real stream received ${initialStatus}, preparing retry...`
                            );
                            this._markImmediateRateLimitIfNeeded(
                                currentQueueAuthIndex,
                                this._getProxyRequestModel(proxyRequest),
                                initialMessage
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this._getRequestAuthIndex(requestId, requestAuthIndex),
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this._getRequestAuthIndex(requestId, requestAuthIndex);
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "Claude real stream", requestId, {
                            afterRetries: false,
                        });
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message, "api_error");
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this._handleRequestFailureScoped(initialMessage, requestId);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] Claude streaming response (Real Mode) started...`);
                    await this._streamClaudeResponse(currentQueue, res, model, requestId);
                } else {
                    // Claude Fake Stream / Non-Stream mode
                    let connectionMaintainer;
                    if (isClaudeStream) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000);
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write("event: ping\ndata: {}\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(result.error, "Claude fake/non-stream", requestId);
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isClaudeStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(
                                    res,
                                    result.error.status || 500,
                                    result.error.message,
                                    "api_error"
                                );
                            }
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this._handleRequestFailureScoped(result.error, requestId);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isClaudeStream) {
                            // Fake stream
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                });
                            }
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] Claude streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        this.logger.error(
                                            `❌ [Request] Error received during Claude fake stream: ${message.message}`
                                        );
                                        this._markTrackedResponseError(res, message.message, 500);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.write(
                                                    `event: error\ndata: ${JSON.stringify({
                                                        error: {
                                                            message: message.message,
                                                            type: "api_error",
                                                        },
                                                        type: "error",
                                                    })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to Claude fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (message.data) fullBody += message.data;
                                }
                                if (hadStreamError) {
                                    // Backend errored; don't attempt to translate/send a "normal" stream afterwards.
                                    return;
                                }
                                const streamState = {};
                                const translatedChunk = this.formatConverter.translateGoogleToClaudeStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake Claude stream chunk: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake Claude stream chunk."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (Claude fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendClaudeNonStreamResponse(activeQueue, res, model, requestId);
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest && this._shouldRotateGlobalAccount()) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
            this._schedulePendingUsageRotations();
        }
    }

    // Process Claude count tokens request
    async processClaudeCountTokens(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this.logger.info(`[Request] Claude count tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "claude");

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "overloaded_error",
                }))
            ) {
                return;
            }

            // Translate Claude format to Google format
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            // Build countTokens request
            // Per Gemini API docs, countTokens accepts:
            // - contents[] (simple mode)
            // - generateContentRequest (full request with model, contents, tools, systemInstruction, etc.)
            const countTokensBody = {
                generateContentRequest: {
                    model: `models/${model}`,
                    ...googleBody,
                },
            };

            const proxyRequest = {
                body: JSON.stringify(countTokensBody),
                headers: { "Content-Type": "application/json" },
                is_generative: false,
                method: "POST",
                path: `/v1beta/models/${model}:countTokens`,
                query_params: {},
                request_id: requestId,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                model,
                path: proxyRequest.path,
                requestCategory: "count_tokens",
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                const messageQueueAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ??
                    this._getRequestAuthIndex(requestId, requestAuthIndex);
                this._setupClientDisconnectHandler(res, requestId);

                this._getUsageStatsService()?.recordAttempt(
                    requestId,
                    messageQueueAuthIndex,
                    this._getAccountNameForIndex(messageQueueAuthIndex)
                );
                this._forwardRequest(proxyRequest, messageQueueAuthIndex);
                const response = await messageQueue.dequeue();

                if (response.event_type === "error") {
                    this.logger.error(
                        `❌ [Request] Received error from browser, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );
                    this._sendErrorResponse(res, response.status || 500, response.message, "api_error");
                    if (!this._isConnectionResetError(response)) {
                        await this._handleRequestFailureScoped(response, requestId);
                    }
                    return;
                }

                // For non-streaming requests, consume all chunks until STREAM_END
                let fullBody = "";
                if (response.type !== "STREAM_END") {
                    if (response.data) fullBody += response.data;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const message = await messageQueue.dequeue();
                        if (message.type === "STREAM_END") {
                            break;
                        }
                        if (message.event_type === "error") {
                            this.logger.error(`❌ [Request] Error received during count tokens: ${message.message}`);
                            this._markTrackedResponseError(res, message.message, 500);
                            return this._sendErrorResponse(res, 500, message.message, "api_error");
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                const geminiResponse = JSON.parse(fullBody || response.body);
                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] Count tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                // Return Claude-compatible response
                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (Claude count_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
                );
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // OpenAI Response API count input tokens endpoint
    // Mirrors OpenAI's /v1/responses/input_tokens by returning only the request-side token count.
    async processOpenAIResponseInputTokens(req, res) {
        const requestId = this._generateRequestId();
        const requestAuthIndex = this._selectRequestAuthIndex([], this._getRequestedModel(req));
        this._bindRequestAuthIndex(requestId, requestAuthIndex);
        this.logger.info(`[Request] OpenAI Response input_tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "response_api");

        try {
            if (
                !(await this._ensureBrowserBackedRequestReady(res, {
                    authIndex: requestAuthIndex,
                    requestId,
                    waitErrorType: "service_unavailable",
                }))
            ) {
                return;
            }

            // Translate OpenAI Response format to Google format (so we can use Gemini countTokens)
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response input_tokens translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
            }

            // Gemini countTokens accepts either:
            // - contents[]
            // - generateContentRequest (full request; required here because tools/systemInstruction/etc may be present)
            const countTokensBody = {
                generateContentRequest: {
                    model: `models/${model}`,
                    ...googleBody,
                },
            };

            const proxyRequest = {
                body: JSON.stringify(countTokensBody),
                headers: { "Content-Type": "application/json" },
                is_generative: false,
                method: "POST",
                path: `/v1beta/models/${model}:countTokens`,
                query_params: {},
                request_id: requestId,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                model,
                path: proxyRequest.path,
                requestCategory: "count_tokens",
            });

            try {
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._getRequestAuthIndex(requestId, requestAuthIndex),
                    proxyRequest.request_attempt_id
                );
                const messageQueueAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ??
                    this._getRequestAuthIndex(requestId, requestAuthIndex);
                this._setupClientDisconnectHandler(res, requestId);

                this._getUsageStatsService()?.recordAttempt(
                    requestId,
                    messageQueueAuthIndex,
                    this._getAccountNameForIndex(messageQueueAuthIndex)
                );
                this._forwardRequest(proxyRequest, messageQueueAuthIndex);
                const response = await messageQueue.dequeue();

                if (response.event_type === "error") {
                    this.logger.error(
                        `❌ [Request] Received error from browser for input_tokens, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );

                    this._sendErrorResponse(res, response.status || 500, response.message);

                    // Avoid switching account if the error is just a connection reset
                    if (!this._isConnectionResetError(response)) {
                        await this._handleRequestFailureScoped(response, requestId);
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (input_tokens), skipping account switch."
                        );
                    }
                    return;
                }

                // For non-streaming requests, consume all chunks until STREAM_END
                let fullBody = "";
                if (response.type !== "STREAM_END") {
                    if (response.data) fullBody += response.data;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const message = await messageQueue.dequeue();
                        if (message.type === "STREAM_END") {
                            break;
                        }
                        if (message.event_type === "error") {
                            this.logger.error(
                                `❌ [Request] Error received during input_tokens count: ${message.message}`
                            );
                            this._markTrackedResponseError(res, message.message, 500);
                            this._sendErrorResponse(res, 500, message.message);
                            return;
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                let geminiResponse;
                try {
                    geminiResponse = JSON.parse(fullBody || response.body);
                } catch (parseError) {
                    this.logger.error(`❌ [Request] Failed to parse countTokens response: ${parseError.message}`);
                    this._sendErrorResponse(res, 500, "Failed to parse backend response");
                    return;
                }

                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] input_tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (OpenAI Response input_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
                );
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } finally {
            this._releaseRequestAuthIndex(requestId);
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // === Response Handlers ===

    async _streamClaudeResponse(messageQueue, res, model, requestId) {
        const streamState = {};

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);

                if (message.type === "STREAM_END") {
                    this.logger.info(`✅ [Request] Response completed (Claude real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Claude stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    // Attempt to send error event to client if headers allowed, then close
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    error: {
                                        message: message.message,
                                        type: "api_error",
                                    },
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Claude stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const claudeChunk = this.formatConverter.translateGoogleToClaudeStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (claudeChunk) {
                        // Before writing, ensure the response is still writable to avoid
                        // throwing if the client disconnected mid-stream.
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Claude stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(claudeChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Claude chunk to stream: ${writeError.message}`
                            );
                            // Stop streaming on write failure to avoid misclassifying as a timeout.
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect)
            // Let other errors (timeout, parsing, logic errors) propagate to outer catch
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            // Re-throw all other errors to be handled by outer catch block
            throw error;
        }
    }

    async _sendClaudeNonStreamResponse(messageQueue, res, model, requestId) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] Claude received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(`❌ [Adapter] Error during Claude non-stream conversion: ${message.message}`);
                this._sendErrorResponse(res, 500, message.message, "api_error");
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
            }
        }

        try {
            const googleResponse = JSON.parse(fullBody);
            const claudeResponse = this.formatConverter.convertGoogleToClaudeNonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(claudeResponse));
            this.logger.info(`✅ [Request] Response completed (Claude non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for Claude: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response", "api_error");
        }
    }

    async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
        // Per user request, convert the backend call to non-streaming.
        proxyRequest.path = proxyRequest.path.replace(":streamGenerateContent", ":generateContent");
        if (proxyRequest.query_params && proxyRequest.query_params.alt) {
            delete proxyRequest.query_params.alt;
        }

        let connectionMaintainer;
        const scheduleNextKeepAlive = () => {
            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
            connectionMaintainer = setTimeout(() => {
                if (!res.headersSent) {
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                }
                if (!res.writableEnded) {
                    res.write(": keep-alive\n\n");
                    scheduleNextKeepAlive();
                }
            }, randomInterval);
        };
        scheduleNextKeepAlive();

        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

            if (!result.success) {
                clearTimeout(connectionMaintainer);

                if (isUserAbortedError(result.error)) {
                    this.logger.debug(
                        `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                    );
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini fake stream", proxyRequest.request_id);
                    // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                    if (res.headersSent) {
                        this._handleRequestError(result.error, res, proxyRequest.request_id);
                    } else {
                        this._sendErrorResponse(res, result.error.status || 500, result.error.message);
                    }

                    // Avoid switching account if the error is just a connection reset
                    if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                        await this._handleRequestFailureScoped(result.error, proxyRequest.request_id);
                    } else if (result.error.skipAccountSwitch) {
                        this.logger.info(
                            "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                        );
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (Gemini Non-Stream), skipping account switch."
                        );
                    }
                }
                return;
            }

            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            if (!res.headersSent) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
            }
            // Clear the keep-alive timer as we are about to send real data
            clearTimeout(connectionMaintainer);
            this.logger.info(`[Request] Gemini streaming response (Fake Mode) started...`);

            // Read all data chunks until STREAM_END to handle potential fragmentation
            let fullData = "";
            let hadStreamError = false;
            try {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM); // 5 min timeout for fake streaming
                    if (message.type === "STREAM_END") {
                        break;
                    }

                    if (message.event_type === "error") {
                        this.logger.error(
                            `❌ [Request] Error received during Gemini pseudo-stream: ${message.message}`
                        );
                        this._markTrackedResponseError(res, message.message, 500);
                        hadStreamError = true;
                        this._handleRequestError({ message: message.message }, res, proxyRequest.request_id);
                        break;
                    }

                    if (message.data) {
                        fullData += message.data;
                    }
                }
            } catch (error) {
                // Handle timeout or other errors during streaming
                // Don't attempt to write if it's a connection reset or if response is destroyed
                if (!this._isConnectionResetError(error)) {
                    // Classify error type and send appropriate response
                    this._handleFakeStreamError(error, res);
                } else {
                    this.logger.debug(
                        "[Request] Gemini pseudo-stream interrupted by connection reset, skipping error write"
                    );
                }
                // Return early to prevent JSON parsing of incomplete data
                return;
            }
            if (hadStreamError) {
                // Backend errored; don't attempt to parse/split/send "normal" chunks afterwards.
                return;
            }

            try {
                const googleResponse = JSON.parse(fullData);
                this._logGeminiNativeResponseDebug(googleResponse, "pseudo-stream");
                const candidate = googleResponse.candidates?.[0];

                if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
                    this.logger.debug(
                        "[Request] Splitting full Gemini response into 'thought' and 'content' chunks for pseudo-stream."
                    );

                    const thinkingParts = candidate.content.parts.filter(p => p.thought === true);
                    const contentParts = candidate.content.parts.filter(p => p.thought !== true);
                    const role = candidate.content.role || "model";

                    // Send thinking part first
                    if (thinkingParts.length > 0) {
                        const thinkingResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: thinkingParts,
                                        role,
                                    },
                                    // We don't include finishReason here
                                },
                            ],
                            // We don't include usageMetadata here
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (thinking parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(thinkingResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini thinking chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${thinkingParts.length} thinking part(s).`);
                    }

                    // Then send content part
                    if (contentParts.length > 0) {
                        const contentResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: contentParts,
                                        role,
                                    },
                                    finishReason: candidate.finishReason,
                                    // Other candidate fields can be preserved if needed
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (content parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(contentResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini content chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${contentParts.length} content part(s).`);
                    } else if (candidate.finishReason) {
                        // If there's no content but a finish reason, send an empty content message with it
                        const finalResponse = {
                            candidates: [
                                {
                                    content: { parts: [], role },
                                    finishReason: candidate.finishReason,
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (final response); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini final chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                    }
                } else if (fullData) {
                    // Fallback for responses without candidates or parts, or if parsing fails
                    this.logger.warn(
                        "[Request] Response structure not recognized for splitting, sending as a single chunk."
                    );
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            } catch (e) {
                this.logger.error(
                    `❌ [Request] Failed to parse and split Gemini response: ${e.message}. Sending raw data.`
                );
                if (fullData) {
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (error fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini error fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            }

            this.logger.info(
                `✅ [Request] Response completed (Gemini fake stream), request ID: ${proxyRequest.request_id}`
            );
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        } finally {
            clearTimeout(connectionMaintainer);
            if (!res.writableEnded) {
                res.end();
            }
            this.logger.debug(
                `[Request] Pseudo-stream response processing ended, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleRealStreamResponse(proxyRequest, messageQueue, req, res) {
        let currentQueue = messageQueue;
        let currentQueueAuthIndex = this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex);
        let headerMessage;
        let skipFinalFailureSwitch = false;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(
            currentQueueAuthIndex,
            this._getProxyRequestModel(proxyRequest)
        );

        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Record attempt before forwarding, so failed attempts are also counted
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            this._forwardRequest(proxyRequest, currentQueueAuthIndex);
            headerMessage = await currentQueue.dequeue();

            const headerStatus = Number(headerMessage?.status);
            if (
                headerMessage.event_type === "error" &&
                proxyRequest.is_generative &&
                !isUserAbortedError(headerMessage) &&
                Number.isFinite(headerStatus) &&
                this.config?.immediateSwitchStatusCodes?.includes(headerStatus)
            ) {
                this.logger.warn(`[Request] Gemini real stream received ${headerStatus}, preparing retry...`);
                this._markImmediateRateLimitIfNeeded(
                    currentQueueAuthIndex,
                    this._getProxyRequestModel(proxyRequest),
                    headerMessage
                );
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                const retryPrepared = await this._prepareImmediateStatusRetry(
                    headerMessage,
                    proxyRequest.request_id,
                    immediateSwitchTracker,
                    currentQueueAuthIndex
                );
                if (!retryPrepared) {
                    skipFinalFailureSwitch = true;
                    break;
                }

                try {
                    currentQueue.close(this._getImmediateStatusRetryCloseReason(headerStatus));
                } catch {
                    /* empty */
                }

                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex),
                    proxyRequest.request_attempt_id
                );
                currentQueueAuthIndex = this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex);
                continue;
            }

            break;
        }

        if (headerMessage.event_type === "error") {
            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
            if (isUserAbortedError(headerMessage)) {
                this.logger.debug(
                    `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                );
            } else {
                this._logFinalRequestFailure(headerMessage, "Gemini real stream", proxyRequest.request_id, {
                    afterRetries: false,
                });
                // Avoid switching account if the error is just a connection reset
                if (!skipFinalFailureSwitch && !this._isConnectionResetError(headerMessage)) {
                    await this._handleRequestFailureScoped(headerMessage, proxyRequest.request_id);
                } else if (skipFinalFailureSwitch) {
                    this.logger.info(
                        "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                    );
                } else {
                    this.logger.info(
                        "[Request] Failure due to connection reset (Gemini Real Stream), skipping account switch."
                    );
                }
                return this._sendErrorResponse(res, headerMessage.status, headerMessage.message);
            }
            if (!res.writableEnded) res.end();
            return;
        }

        if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
            this.logger.debug(
                `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
            );
            this.authSwitcher.failureCount = 0;
        }

        this._setResponseHeaders(res, headerMessage, req);
        // Fallback: Ensure Content-Type is set for streaming response
        if (!res.get("Content-Type")) {
            res.type("text/event-stream");
        }
        this.logger.info(`[Request] Gemini streaming response (Real Mode) started...`);
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const dataMessage = await currentQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (dataMessage.type === "STREAM_END") {
                    this.logger.info(
                        `✅ [Request] Response completed (Gemini real stream), request ID: ${proxyRequest.request_id}`
                    );
                    break;
                }

                if (dataMessage.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Gemini real stream: ${dataMessage.message}`);
                    this._markTrackedResponseError(res, dataMessage.message, 500);
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: 500, message: dataMessage.message, status: "INTERNAL" } })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Gemini real stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (dataMessage.data) {
                    this._logGeminiNativeChunkDebug(dataMessage.data, "stream");
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini real stream; stopping stream."
                        );
                        break;
                    }
                    try {
                        res.write(dataMessage.data);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini data chunk to stream: ${writeError.message}`
                        );
                        break;
                    }
                }
            }
        } catch (error) {
            // Handle queue closed errors (account switch, context closed, etc.)
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
            } else if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                // Keep behavior consistent with other interfaces: treat missing stream chunks as a timeout error.
                this._handleRequestError(error, res, proxyRequest.request_id);
            } else {
                // Unexpected error - rethrow to outer handler
                throw error;
            }
        } finally {
            if (!res.writableEnded) res.end();
            this.logger.debug(
                `[Request] Real stream response connection closed, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleNonStreamResponse(proxyRequest, messageQueue, req, res) {
        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

            if (!result.success) {
                // If retries failed, handle the failure (e.g., switch account)
                if (isUserAbortedError(result.error)) {
                    this.logger.info(`[Request] Request #${proxyRequest.request_id} was properly cancelled by user.`);
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini non-stream", proxyRequest.request_id);
                    // Avoid switching account if the error is just a connection reset
                    if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                        await this._handleRequestFailureScoped(result.error, proxyRequest.request_id);
                    } else if (result.error.skipAccountSwitch) {
                        this.logger.info(
                            "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                        );
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (Gemini Non-Stream), skipping account switch."
                        );
                    }
                }
                return this._sendErrorResponse(res, result.error.status || 500, result.error.message);
            }

            // On success, reset failure count if needed
            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Non-stream generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            const headerMessage = result.message;
            const chunks = [];
            let receiving = true;
            while (receiving) {
                const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                if (message.type === "STREAM_END") {
                    this.logger.debug("[Request] Gemini non-stream end signal received.");
                    receiving = false;
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Gemini non-stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    this._sendErrorResponse(res, 500, message.message);
                    return;
                }

                if (message.event_type === "chunk" && message.data) {
                    chunks.push(Buffer.from(message.data));
                }
            }

            const fullBodyBuffer = Buffer.concat(chunks);
            let responseBodyBuffer = fullBodyBuffer;

            try {
                const fullResponse = JSON.parse(responseBodyBuffer.toString());
                this._logGeminiNativeResponseDebug(fullResponse, "non-stream");
            } catch (e) {
                // Ignore JSON parsing errors for finish reason
            }

            if (proxyRequest.response_transform === "batchEmbedToEmbedContent") {
                try {
                    responseBodyBuffer = this._convertBatchEmbedResponseToEmbedContent(responseBodyBuffer);
                } catch (error) {
                    this.logger.error(`❌ [Proxy] Failed to convert embedding response: ${error.message}`);
                    this._sendErrorResponse(res, 500, "Failed to convert backend embedding response");
                    return;
                }
            }

            this._setResponseHeaders(res, headerMessage, req);

            // Ensure Content-Type is set (Express defaults Buffer to application/octet-stream)
            if (!res.get("Content-Type")) {
                res.type("application/json");
            }

            res.send(responseBodyBuffer);
            this.logger.info(
                `✅ [Request] Response completed (Gemini non-stream), request ID: ${proxyRequest.request_id}`
            );
            this.logger.debug(`[Request] Complete non-stream response sent to client.`);
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        }
    }

    // === Helper Methods ===

    _processImageInResponse(fullBody) {
        try {
            const parsedBody = JSON.parse(fullBody);
            let needsReserialization = false;

            const candidate = parsedBody.candidates?.[0];
            if (candidate?.content?.parts) {
                const imagePartIndex = candidate.content.parts.findIndex(p => p.inlineData);

                if (imagePartIndex > -1) {
                    this.logger.info(
                        "[Proxy] Detected image data in Google format response, converting to Markdown..."
                    );
                    const imagePart = candidate.content.parts[imagePartIndex];
                    const image = imagePart.inlineData;

                    candidate.content.parts[imagePartIndex] = {
                        text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
                    };
                    needsReserialization = true;
                }
            }

            if (needsReserialization) {
                return JSON.stringify(parsedBody);
            }
        } catch (e) {
            this.logger.warn(
                `[Proxy] Response body is not valid JSON, or error occurred while processing image: ${e.message}`
            );
        }
        return fullBody;
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue) {
        let lastError = null;
        let currentQueue = messageQueue;
        const registeredQueueAuthIndex = this.connectionRegistry.getAuthIndexForRequest(proxyRequest.request_id);
        // Track the authIndex registered for the current queue, which may differ from the global current account.
        let currentQueueAuthIndex =
            Number.isInteger(registeredQueueAuthIndex) && registeredQueueAuthIndex >= 0
                ? registeredQueueAuthIndex
                : this.currentAuthIndex;
        let retryAttempt = 1;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(
            currentQueueAuthIndex,
            this._getProxyRequestModel(proxyRequest)
        );

        while (retryAttempt <= this.config.maxRetries) {
            // Record attempt at the start of each retry, before forwarding.
            // This ensures failed attempts (e.g. 429 before any response) are also counted.
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest, currentQueueAuthIndex);

                const initialMessage = await currentQueue.dequeue(this.timeouts.FAKE_STREAM);

                if (initialMessage.event_type === "timeout") {
                    throw new Error(
                        JSON.stringify({
                            event_type: "error",
                            message: "Request timed out waiting for browser response.",
                            status: 504,
                        })
                    );
                }

                if (initialMessage.event_type === "error") {
                    // Throw a structured error to be caught by the catch block
                    throw new Error(JSON.stringify(initialMessage));
                }

                // A successful response resets the account's transient 429 streak.
                this._markAccountSuccess(currentQueueAuthIndex, this._getProxyRequestModel(proxyRequest));
                // Success, return the initial message and the queue that received it
                return { message: initialMessage, queue: currentQueue, success: true };
            } catch (error) {
                // Parse the structured error message
                let errorPayload;
                try {
                    errorPayload = JSON.parse(error.message);
                } catch (e) {
                    // JSON parse failed - check if it's a timeout error
                    if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                        errorPayload = { message: error.message || "Queue timeout", status: 504 };
                    } else {
                        errorPayload = { message: error.message, status: 500 };
                    }
                }

                // Stop retrying immediately if the queue is closed
                if (this._isConnectionResetError(error)) {
                    // Check the actual closure reason to provide accurate error messages
                    const reason = error.reason || "unknown";
                    const isClientDisconnect = reason === "client_disconnect";
                    const currentAuthIndex = this._selectRequestAuthIndex(
                        [currentQueueAuthIndex],
                        this._getProxyRequestModel(proxyRequest)
                    );
                    const isClosedAccountRetryable = reason === "context_closed" || reason === "page_closed";
                    const canRetryOnCurrentAccountCandidate =
                        !isClientDisconnect &&
                        isClosedAccountRetryable &&
                        retryAttempt < this.config.maxRetries &&
                        Number.isInteger(currentQueueAuthIndex) &&
                        currentQueueAuthIndex >= 0 &&
                        Number.isInteger(currentAuthIndex) &&
                        currentAuthIndex >= 0 &&
                        currentQueueAuthIndex !== currentAuthIndex;

                    if (canRetryOnCurrentAccountCandidate) {
                        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                            connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                        });
                        if (!ready) {
                            lastError = {
                                message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                                status: 503,
                            };
                            break;
                        }
                    }

                    const canRetryOnCurrentAccount =
                        canRetryOnCurrentAccountCandidate &&
                        Boolean(this.connectionRegistry.getConnectionByAuth(currentAuthIndex, false));

                    if (isClientDisconnect) {
                        this.logger.warn(`[Request] Message queue closed due to client disconnect, aborting retries.`);
                        lastError = { message: "Connection lost (client disconnect)", status: 503 };
                    } else if (canRetryOnCurrentAccount) {
                        this.logger.warn(
                            `[Request] Message queue for non-current account #${currentQueueAuthIndex} closed ` +
                                `(reason: ${reason}); retrying request #${proxyRequest.request_id} on current account #${currentAuthIndex}.`
                        );
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                        this._advanceProxyRequestAttempt(proxyRequest);
                        currentQueue = this.connectionRegistry.createMessageQueue(
                            proxyRequest.request_id,
                            this._getRequestAuthIndex(proxyRequest.request_id, currentAuthIndex),
                            proxyRequest.request_attempt_id
                        );
                        currentQueueAuthIndex = currentAuthIndex;
                        if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                            immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                        retryAttempt++;
                        continue;
                    } else {
                        // Queue closed for other reasons (account_switch, system_reset, etc.)
                        this.logger.warn(`[Request] Message queue closed (reason: ${reason}), aborting retries.`);
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                    }
                    break;
                }

                lastError = errorPayload;
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                const errorStatus = Number(errorPayload?.status);
                if (errorStatus === 429) {
                    this._markAccount429ForModel(
                        currentQueueAuthIndex,
                        this._getProxyRequestModel(proxyRequest),
                        errorPayload
                    );
                }
                const isNonRetryableEmbeddingClientError =
                    (errorStatus === 400 || errorStatus === 404) &&
                    this._categorizeRequest(proxyRequest?.path, "request") === "embedding";
                if (isNonRetryableEmbeddingClientError) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    this.logger.warn(
                        `[Request] Embedding request failed with non-retryable status ${errorPayload.status}; skipping retries and account switching.`
                    );
                    break;
                }

                // Check if we should stop retrying immediately based on status code
                if (
                    Number.isFinite(errorStatus) &&
                    this.config?.immediateSwitchStatusCodes?.includes(errorStatus) &&
                    !isUserAbortedError(errorPayload)
                ) {
                    this.logger.warn(`[Request] Received ${errorStatus}, preparing retry...`);
                    try {
                        const retryPrepared = await this._prepareImmediateStatusRetry(
                            errorPayload,
                            proxyRequest.request_id,
                            immediateSwitchTracker,
                            currentQueueAuthIndex
                        );
                        if (!retryPrepared) {
                            lastError = { ...errorPayload, skipAccountSwitch: true };
                            break;
                        }
                    } catch (switchError) {
                        lastError = { ...errorPayload, skipAccountSwitch: true };
                        this.logger.error(
                            `❌ [Request] Account switch failed during immediate-switch retry flow: ${switchError.message}`
                        );
                        break;
                    }

                    try {
                        currentQueue.close("retry_creating_new_queue");
                    } catch (e) {
                        this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                    }

                    this.logger.debug(
                        `[Request] Creating new message queue after immediate switch for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex)})`
                    );
                    this._advanceProxyRequestAttempt(proxyRequest);
                    currentQueue = this.connectionRegistry.createMessageQueue(
                        proxyRequest.request_id,
                        this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex),
                        proxyRequest.request_attempt_id
                    );
                    currentQueueAuthIndex = this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex);
                    continue;
                }

                // Log the warning for the current attempt
                this.logger.warn(
                    `[Request] Attempt #${retryAttempt}/${this.config.maxRetries} for request #${proxyRequest.request_id} failed: ${errorPayload.message}`
                );

                // If it's the last attempt, break the loop to return failure
                if (retryAttempt >= this.config.maxRetries) {
                    this.logger.error(
                        `❌ [Request] All ${this.config.maxRetries} retries failed for request #${proxyRequest.request_id}. Final error: ${errorPayload.message}`
                    );
                    break;
                }

                // Explicitly close the old queue before creating a new one
                // This ensures waitingResolvers are properly rejected even if authIndex changed
                try {
                    currentQueue.close("retry_creating_new_queue");
                } catch (e) {
                    this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                }

                // Create a new message queue for the retry with CURRENT account
                // Note: We keep the same requestId so the browser response routes to the new queue
                // createMessageQueue will automatically close and remove any existing queue with the same ID from the registry
                this.logger.debug(
                    `[Request] Creating new message queue for retry #${retryAttempt + 1} for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex)})`
                );
                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex),
                    proxyRequest.request_attempt_id
                );
                // Update tracked authIndex for the new queue
                currentQueueAuthIndex = this._getRequestAuthIndex(proxyRequest.request_id, this.currentAuthIndex);
                if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                    immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                }

                // Wait before the next retry
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                if (
                    !(await this._waitForSystemAndConnectionIfBusy(null, {
                        connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                    }))
                ) {
                    lastError = {
                        message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                        status: 503,
                    };
                    break;
                }
                retryAttempt++;
            }
        }

        // After all retries, return the final failure result
        return { error: lastError, success: false };
    }

    async _streamOpenAIResponseAPIResponse(messageQueue, res, model, streamOptions = {}) {
        const streamState = {
            responseDefaults: streamOptions.responseDefaults || {},
        };
        const requestId = streamOptions.requestId;
        // Keep Response API sequence numbers consistent across helpers that might write to the same SSE response.
        if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
        streamState.sequenceNumber = res.__responseApiSeq;

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (message.type === "STREAM_END") {
                    this.logger.info(
                        `✅ [Request] Response completed (OpenAI Response API real stream), request ID: ${requestId}`
                    );
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Response API stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    if (this._isResponseWritable(res)) {
                        try {
                            if (!streamState.sequenceNumber) streamState.sequenceNumber = 0;
                            streamState.sequenceNumber++;
                            res.__responseApiSeq = streamState.sequenceNumber;
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    code: "api_error",
                                    message: message.message,
                                    param: null,
                                    sequence_number: streamState.sequenceNumber,
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Response API stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const responseAPIChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (typeof streamState.sequenceNumber === "number") {
                        res.__responseApiSeq = streamState.sequenceNumber;
                    }
                    if (responseAPIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Response API stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(responseAPIChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Response API chunk (connection likely closed): ${writeError.message}`
                            );
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect / queue closed).
            // Let other errors (timeout, parsing, logic errors) propagate to the outer catch.
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            throw error;
        }
    }

    async _streamOpenAIResponse(messageQueue, res, model, requestId) {
        const streamState = {};
        let sawNormalFinish = false;
        let dataChunkCount = 0;

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (message.type === "STREAM_END") {
                    this.logger.info(
                        `[Request] Upstream stream end received (normal finishReason: ${
                            sawNormalFinish ? "yes" : "no"
                        }, chunks: ${dataChunkCount}), request ID: ${requestId}`
                    );
                    if (!sawNormalFinish) {
                        const incompleteError = new Error(
                            "Upstream stream ended before a normal finishReason was received; partial response is incomplete."
                        );
                        incompleteError.status = 502;
                        this._markTrackedResponseError(res, incompleteError.message, incompleteError.status);
                        if (this._isResponseWritable(res)) {
                            try {
                                res.write(
                                    `data: ${JSON.stringify({
                                        error: {
                                            code: incompleteError.status,
                                            message: incompleteError.message,
                                            type: "incomplete_stream_error",
                                        },
                                    })}\n\n`
                                );
                            } catch (writeError) {
                                this.logger.debug(
                                    `[Request] Failed to write incomplete-stream error: ${writeError.message}`
                                );
                            }
                        }
                        break;
                    }
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write("data: [DONE]\n\n");
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write final [DONE] to OpenAI stream (connection likely closed): ${writeError.message}`
                            );
                        }
                    }
                    this.logger.info(`✅ [Request] Response completed (OpenAI real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during OpenAI stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    // Attempt to send error event to client if headers allowed, then close
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: 500, message: message.message, type: "api_error" } })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to OpenAI stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    dataChunkCount += 1;
                    try {
                        const parsedChunk = JSON.parse(message.data.replace(/^data:\s*/, "").trim());
                        const candidate = parsedChunk?.candidates?.[0];
                        if (candidate?.finishReason) {
                            sawNormalFinish = true;
                            this.logger.info(
                                `[Request] Upstream finishReason=${candidate.finishReason} received ` +
                                    `(chunks: ${dataChunkCount}), request ID: ${requestId}`
                            );
                        }
                    } catch {
                        // A fragmented/non-JSON chunk is passed to the normal converter.
                    }
                    const openAIChunk = this.formatConverter.translateGoogleToOpenAIStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (openAIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during OpenAI stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(openAIChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write OpenAI chunk to stream: ${writeError.message}`
                            );
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect)
            // Let other errors (timeout, parsing, logic errors) propagate to outer catch
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            // Re-throw all other errors to be handled by outer catch block
            throw error;
        }
    }

    async _sendOpenAIResponseAPINonStreamResponse(messageQueue, res, model, requestId, responseDefaults = {}) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] OpenAI Response API received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(
                    `❌ [Adapter] Error during OpenAI Response API non-stream conversion: ${message.message}`
                );
                this._sendErrorResponse(res, 500, message.message);
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
            }
        }

        // Parse and convert to OpenAI Response API format
        try {
            const googleResponse = JSON.parse(fullBody);
            const responseAPIResponse = this.formatConverter.convertGoogleToResponseAPINonStream(
                googleResponse,
                model,
                responseDefaults
            );
            res.type("application/json").send(JSON.stringify(responseAPIResponse));
            this.logger.info(
                `✅ [Request] Response completed (OpenAI Response API non-stream), request ID: ${requestId}`
            );
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI Response API: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response");
        }
    }

    async _sendOpenAINonStreamResponse(messageQueue, res, model, requestId) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] OpenAI received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(`❌ [Adapter] Error during OpenAI non-stream conversion: ${message.message}`);
                this._sendErrorResponse(res, 500, message.message);
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
            }
        }

        // Parse and convert to OpenAI format
        try {
            const googleResponse = JSON.parse(fullBody);
            const openAIResponse = this.formatConverter.convertGoogleToOpenAINonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(openAIResponse));
            this.logger.info(`✅ [Request] Response completed (OpenAI non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response");
        }
    }

    _setResponseHeaders(res, headerMessage, req) {
        res.status(headerMessage.status || 200);
        const headers = headerMessage.headers || {};

        // Filter headers that might cause CORS conflicts
        const forbiddenHeaders = [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
        ];

        Object.entries(headers).forEach(([name, value]) => {
            const lowerName = name.toLowerCase();
            if (forbiddenHeaders.includes(lowerName)) return;
            if (lowerName === "content-length") return;

            // Special handling for upload URL and redirects: point them back to this proxy
            if (lowerName === "x-goog-upload-url" && value.includes("googleapis.com")) {
                try {
                    const urlObj = new URL(value);
                    // Rewrite upload/redirect URLs to point to this proxy server
                    // build.js already rewrote the URL to localhost with __proxy_host__ param
                    // Here we just ensure it matches the client's request host (for Docker/remote access)
                    let newAuthority;
                    if (req && req.headers && req.headers.host) {
                        newAuthority = req.headers.host;
                    } else {
                        const host = this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host;
                        newAuthority = `${host}:${this.config.httpPort}`;
                    }

                    const protocol =
                        req.secure || (req.get && req.get("X-Forwarded-Proto") === "https") ? "https" : "http";
                    const newUrl = `${protocol}://${newAuthority}${urlObj.pathname}${urlObj.search}`;

                    this.logger.debug(`[Response] Debug: Rewriting header ${name}: ${value} -> ${newUrl}`);
                    res.set(name, newUrl);
                } catch (e) {
                    res.set(name, value);
                }
            } else {
                res.set(name, value);
            }
        });
    }

    _handleRequestError(error, res, requestId = null) {
        const format = this._resolveErrorFormat(res);
        // Normalize error message to handle non-Error objects and missing/non-string messages
        const errorMsg = String(error?.message ?? error);
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";

        // Check if this is a client disconnect - if so, just log and return
        if (this._isConnectionResetError(error)) {
            const isClientDisconnect = error.reason === "client_disconnect" || !this._isResponseWritable(res);
            if (isClientDisconnect) {
                this._markTrackedClientAbort(res, errorMsg);
                this.logger.info(
                    `[Request] Request terminated: Queue closed (${error.reason || "connection_lost"})${requestIdSuffix}`
                );
                if (!res.writableEnded) {
                    try {
                        res.end();
                    } catch (e) {
                        // Ignore end errors for disconnected clients
                    }
                }
                return;
            }
        }

        if (res.headersSent) {
            this.logger.error(
                `❌ [Request] Request processing error (headers already sent): ${errorMsg}${requestIdSuffix}`
            );

            // Try to send error in the stream format
            if (this._isResponseWritable(res)) {
                const contentType = res.getHeader("content-type");

                if (contentType && contentType.includes("text/event-stream")) {
                    // SSE format - send error event
                    try {
                        // Determine error code and type based on error classification
                        let errorCode = 500;
                        let errorType = "api_error";
                        let errorMessage = `Processing failed: ${errorMsg}`;

                        // Use precise error type checking instead of string matching
                        if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                            errorCode = 504;
                            errorType = "timeout_error";
                            errorMessage = `Stream timeout: ${errorMsg}`;
                        } else if (this._isConnectionResetError(error)) {
                            errorCode = 503;
                            errorType = format === "claude" ? "overloaded_error" : "service_unavailable";
                            errorMessage = `Service unavailable: ${errorMsg}`;
                        }

                        this._markTrackedResponseError(res, errorMessage, errorCode);

                        if (format === "response_api") {
                            if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                            res.__responseApiSeq += 1;
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    code: errorType,
                                    message: errorMessage,
                                    param: null,
                                    sequence_number: res.__responseApiSeq,
                                    type: "error",
                                })}\n\n`
                            );
                        } else if (format === "claude") {
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    error: {
                                        message: errorMessage,
                                        type: errorType,
                                    },
                                    type: "error",
                                })}\n\n`
                            );
                        } else if (format === "gemini") {
                            let statusText = "INTERNAL";
                            if (errorCode === 504) statusText = "DEADLINE_EXCEEDED";
                            else if (errorCode === 503) statusText = "UNAVAILABLE";
                            res.write(
                                `data: ${JSON.stringify({
                                    error: {
                                        code: errorCode,
                                        message: errorMessage,
                                        status: statusText,
                                    },
                                })}\n\n`
                            );
                        } else {
                            res.write(
                                `data: ${JSON.stringify({
                                    error: {
                                        code: errorCode,
                                        message: errorMessage,
                                        type: errorType,
                                    },
                                })}\n\n`
                            );
                        }
                        this.logger.info("[Request] Error event sent to SSE stream");
                    } catch (writeError) {
                        const writeErrorMsg = String(writeError?.message ?? writeError);
                        this.logger.error(
                            `❌ [Request] Failed to write error to stream: ${writeErrorMsg}${requestIdSuffix}`
                        );
                    }
                } else if (res.__proxyResponseStreamMode === "fake") {
                    // Request-scoped fake stream mode - try to send an SSE-style error chunk
                    try {
                        let status = 500;
                        let errorType = "api_error";
                        if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                            status = 504;
                            errorType = "timeout_error";
                        } else if (this._isConnectionResetError(error)) {
                            status = 503;
                            errorType = this._getDefaultErrorType(format, status);
                        }
                        this._sendErrorChunkToClient(res, `Processing failed: ${errorMsg}`, status, errorType);
                    } catch (writeError) {
                        const writeErrorMsg = String(writeError?.message ?? writeError);
                        this.logger.error(
                            `❌ [Request] Failed to write error chunk: ${writeErrorMsg}${requestIdSuffix}`
                        );
                    }
                }

                try {
                    res.end();
                } catch (endError) {
                    this.logger.debug(`[Request] Failed to end response: ${endError.message}`);
                }
            }
        } else {
            this.logger.error(`❌ [Request] Request processing error: ${errorMsg}${requestIdSuffix}`);
            let status = 500;
            let errorType = "api_error";
            // Use precise error type checking instead of string matching
            if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                status = 504;
                errorType = "timeout_error";
            } else if (this._isConnectionResetError(error)) {
                status = 503;
                errorType = format === "claude" ? "overloaded_error" : "service_unavailable";
                this.logger.info(`[Request] Queue closed, returning 503 Service Unavailable.`);
            }
            this._sendErrorResponse(res, status, `Proxy error: ${errorMsg}`, errorType);
        }
    }

    _sendErrorResponse(res, status, message, errorType = null) {
        if (!res.headersSent) {
            const statusCode = Number(status) || 500;
            const resolvedFormat = this._resolveErrorFormat(res);
            const resolvedErrorType = errorType || this._getDefaultErrorType(resolvedFormat, statusCode);
            let errorPayload;

            if (resolvedFormat === "claude") {
                errorPayload = {
                    error: {
                        message,
                        type: resolvedErrorType,
                    },
                    type: "error",
                };
            } else if (resolvedFormat === "openai") {
                errorPayload = {
                    error: {
                        code: statusCode,
                        message,
                        type: resolvedErrorType,
                    },
                };
            } else if (resolvedFormat === "response_api") {
                errorPayload = {
                    error: {
                        code: resolvedErrorType,
                        message,
                        param: null,
                        type: resolvedErrorType,
                    },
                };
            } else {
                let statusText = "INTERNAL";
                if (statusCode === 504) statusText = "DEADLINE_EXCEEDED";
                else if (statusCode === 503) statusText = "UNAVAILABLE";
                errorPayload = {
                    error: {
                        code: statusCode,
                        message,
                        status: statusText,
                    },
                };
            }

            this._markTrackedResponseError(res, message, statusCode);
            res.status(statusCode).type("application/json").send(JSON.stringify(errorPayload));
        }
    }

    _isResponseWritable(res) {
        // Comprehensive check to ensure response is writable
        // Explicitly return boolean to avoid returning null/undefined from res.socket check
        return Boolean(
            !res.writableEnded && !res.destroyed && res.socket && !res.socket.destroyed && res.socket.writable !== false
        );
    }

    _sendErrorChunkToClient(res, message, statusCode = 500, errorType = null) {
        const format = this._resolveErrorFormat(res);
        const resolvedErrorType = errorType || this._getDefaultErrorType(format, statusCode);
        if (!res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
        }
        this._markTrackedResponseError(res, message, statusCode);
        // Check if response is still writable before attempting to write
        if (this._isResponseWritable(res)) {
            try {
                if (format === "response_api") {
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    res.write(
                        `event: error\ndata: ${JSON.stringify({
                            code: resolvedErrorType,
                            message,
                            param: null,
                            sequence_number: res.__responseApiSeq,
                            type: "error",
                        })}\n\n`
                    );
                } else if (format === "claude") {
                    res.write(
                        `event: error\ndata: ${JSON.stringify({
                            error: {
                                message,
                                type: resolvedErrorType,
                            },
                            type: "error",
                        })}\n\n`
                    );
                } else if (format === "openai") {
                    res.write(
                        `data: ${JSON.stringify({
                            error: {
                                code: statusCode,
                                message,
                                type: resolvedErrorType,
                            },
                        })}\n\n`
                    );
                } else {
                    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
                }
            } catch (writeError) {
                this.logger.debug(`[Request] Failed to write error chunk to client: ${writeError.message}`);
            }
        }
    }

    _setupClientDisconnectHandler(res, requestId) {
        res.on("close", () => {
            if (!res.writableEnded) {
                this._markTrackedClientAbort(res);
                this.logger.warn(`[Request] Client closed request #${requestId} connection prematurely.`);

                // Dynamically look up the current authIndex from the connection registry
                // This ensures we cancel on the correct account even after retries switch accounts
                const targetAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
                const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);

                this._cancelBrowserRequest(requestId, targetAuthIndex, requestAttemptId);
                // Close and remove the message queue to unblock any waiting dequeue() calls
                this.connectionRegistry.removeMessageQueue(requestId, "client_disconnect");
            }
        });
    }

    _cancelBrowserRequest(requestId, authIndex, requestAttemptId = null) {
        const targetAuthIndex = authIndex !== undefined ? authIndex : this.currentAuthIndex;
        const connection = this.connectionRegistry.getConnectionByAuth(targetAuthIndex);
        if (connection) {
            this.logger.info(
                `[Request] Cancelling request #${requestId} on account #${targetAuthIndex}` +
                    (requestAttemptId ? ` (attempt ${requestAttemptId})` : "")
            );
            connection.send(
                JSON.stringify({
                    event_type: "cancel_request",
                    request_attempt_id: requestAttemptId,
                    request_id: requestId,
                })
            );
        } else {
            this.logger.warn(
                `[Request] Unable to send cancel instruction: No available WebSocket connection for account #${targetAuthIndex}.`
            );
        }
    }

    _cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex) {
        if (!Number.isInteger(currentQueueAuthIndex) || currentQueueAuthIndex < 0) {
            this.logger.debug(
                `[Request] Skipping retry cancellation for request #${proxyRequest.request_id}: invalid auth index ${currentQueueAuthIndex}.`
            );
            return;
        }
        this._cancelBrowserRequest(proxyRequest.request_id, currentQueueAuthIndex, proxyRequest.request_attempt_id);
    }

    /**
     * Handle queue timeout by notifying browser to cancel the request
     * @param {Error} error - The timeout error
     * @param {string} requestId - The request ID
     */
    _handleQueueTimeout(error, requestId) {
        if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
            // Get the authIndex for this request from the registry
            const authIndex = this.connectionRegistry.getAuthIndexForRequest(requestId);
            const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);
            if (authIndex !== null) {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, notifying browser on account #${authIndex} to cancel`
                );
                this._cancelBrowserRequest(requestId, authIndex, requestAttemptId);
            } else {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, but queue already removed (authIndex not found)`
                );
            }
        }
    }

    /**
     * Set browser (build.js) log level at runtime for all active contexts
     * @param {string} level - 'DEBUG', 'INFO', 'WARN', or 'ERROR'
     * @returns {number} Number of browser contexts updated (0 if none)
     */
    setBrowserLogLevel(level) {
        const validLevels = ["DEBUG", "INFO", "WARN", "ERROR"];
        const upperLevel = level?.toUpperCase();

        if (!validLevels.includes(upperLevel)) {
            return 0;
        }

        // Broadcast to all active browser contexts
        const sentCount = this.connectionRegistry.broadcastMessage(
            JSON.stringify({
                event_type: "set_log_level",
                level: upperLevel,
            })
        );

        if (sentCount > 0) {
            this.logger.info(`[Config] Browser log level set to: ${upperLevel} (${sentCount} context(s) updated)`);

            // Also update server-side LoggingService level to keep in sync
            const LoggingService = require("../utils/LoggingService");
            LoggingService.setLevel(upperLevel);
            this.logger.info(`[Config] Server log level synchronized to: ${upperLevel}`);

            return sentCount;
        } else {
            this.logger.warn(`[Config] Unable to set browser log level: No active WebSocket connections.`);
            return 0;
        }
    }

    _buildProxyRequest(req, requestId) {
        const fullPath = req.path;
        let cleanPath = fullPath.replace(/^\/proxy/, "");
        const bodyObj = req.body;
        let requestBodyObj = bodyObj;
        let responseTransform = null;

        this.logger.debug(`[Proxy] Debug: incoming Gemini Body (Google Native) = ${JSON.stringify(bodyObj, null, 2)}`);

        // Parse model suffixes from model name in native Gemini generation requests
        // Only handle generation requests: /v1beta/models/{modelName}:generateContent or :streamGenerateContent
        const modelPathMatch = cleanPath.match(
            /^(\/v1beta\/models\/)([^:]+)(:(generateContent|streamGenerateContent).*)$/
        );
        let modelThinkingLevel = null;
        let modelStreamingMode = null;
        let modelForceCodeExecution = false;
        let modelForceWebSearch = false;
        let cleanModelName = null;

        if (modelPathMatch) {
            const pathPrefix = modelPathMatch[1];
            const rawModelName = modelPathMatch[2];
            const pathSuffix = modelPathMatch[3];

            const {
                cleanModelName: toolStrippedModel,
                forceCodeExecution: parsedForceCodeExecution,
                forceWebSearch: parsedForceWebSearch,
            } = FormatConverter.parseModelBuiltInToolSuffixes(rawModelName);
            const { cleanModelName: streamStrippedModel, streamingMode: parsedStreamingMode } =
                FormatConverter.parseModelStreamingModeSuffix(toolStrippedModel);
            const parsedModel = FormatConverter.parseModelThinkingLevel(streamStrippedModel);
            cleanModelName = parsedModel.cleanModelName;
            modelForceCodeExecution = parsedForceCodeExecution;
            modelForceWebSearch = parsedForceWebSearch;
            modelStreamingMode = parsedStreamingMode;
            modelThinkingLevel = parsedModel.thinkingLevel;

            const modelForceToolFlags = [];
            if (modelForceWebSearch) modelForceToolFlags.push("forceWebSearch=true");
            if (modelForceCodeExecution) modelForceToolFlags.push("forceCodeExecution=true");
            if (modelForceToolFlags.length > 0) {
                this.logger.info(
                    `[Proxy] Detected built-in tool suffixes in model path: "${rawModelName}" -> model="${toolStrippedModel}", ${modelForceToolFlags.join(", ")}`
                );
            }

            if (modelStreamingMode) {
                this.logger.info(
                    `[Proxy] Detected streamingMode suffix in model path: "${toolStrippedModel}" -> model="${streamStrippedModel}", streamingMode="${modelStreamingMode}"`
                );
            }

            if (modelThinkingLevel) {
                this.logger.info(
                    `[Proxy] Detected thinkingLevel suffix in model path: "${streamStrippedModel}" -> model="${cleanModelName}", thinkingLevel="${modelThinkingLevel}"`
                );
            }

            // Always strip recognized directives from path model name
            if (cleanModelName !== rawModelName) {
                cleanPath = `${pathPrefix}${cleanModelName}${pathSuffix}`;
            }
        }

        // Force thinking for native Google requests (processed first)
        if (this.config.forceThinking && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (
                !bodyObj.generationConfig.thinkingConfig ||
                bodyObj.generationConfig.thinkingConfig.includeThoughts === undefined
            ) {
                this.logger.info(`[Proxy] ⚠️ Force thinking enabled, setting includeThoughts=true. (Google Native)`);
                bodyObj.generationConfig.thinkingConfig = {
                    ...(bodyObj.generationConfig.thinkingConfig || {}),
                    includeThoughts: true,
                };
            }
        }

        // If thinkingLevel is parsed from model name suffix, inject into thinkingConfig (after force thinking, higher priority, direct override)
        if (modelThinkingLevel && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (!bodyObj.generationConfig.thinkingConfig) {
                bodyObj.generationConfig.thinkingConfig = {};
            }
            // A thinking-level suffix also opts in to returned thought parts.
            bodyObj.generationConfig.thinkingConfig.includeThoughts = true;
            bodyObj.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
            this.logger.info(
                `[Proxy] Applied thinkingLevel from model name suffix: ${modelThinkingLevel} (Google Native)`
            );
        }

        // Pre-process native Google requests
        // 1. Ensure thoughtSignature for functionCall (not functionResponse)
        // 2. Sanitize tools (remove unsupported fields, convert type to uppercase)
        if (req.method === "POST" && bodyObj) {
            if (bodyObj.contents) {
                const removedTrailingTurns = FormatConverter.removeUnsupportedTrailingModelTurns(bodyObj.contents);
                if (removedTrailingTurns > 0) {
                    this.logger.warn(
                        `[Proxy] ${cleanModelName || "Gemini model"} does not support prefilling; ` +
                            `removed ${removedTrailingTurns} trailing model turn(s).`
                    );
                }
                this.formatConverter.ensureThoughtSignature(bodyObj);
            }
            if (bodyObj.tools) {
                this.formatConverter.sanitizeGeminiTools(bodyObj);
            }
        }

        const embedContentMatch = cleanPath.match(/^\/v1beta\/models\/([^:]+):embedContent$/);
        if (req.method === "POST" && embedContentMatch) {
            const modelName = embedContentMatch[1];
            cleanPath = `/v1beta/models/${modelName}:batchEmbedContents`;
            requestBodyObj = this._convertEmbedContentBodyToBatch(bodyObj, modelName);
            responseTransform = "batchEmbedToEmbedContent";
            this.logger.info(`[Proxy] Rewriting embedContent to batchEmbedContents for model "${modelName}".`);
        }

        // Force built-in tools for native Google requests
        if (
            (this.config.forceWebSearch ||
                modelForceWebSearch ||
                this.config.forceUrlContext ||
                this.config.forceCodeExecution ||
                modelForceCodeExecution) &&
            req.method === "POST" &&
            bodyObj &&
            bodyObj.contents
        ) {
            if (!bodyObj.tools) {
                bodyObj.tools = [];
            }

            const toolsToAdd = [];

            // Handle Google Search
            if (this.config.forceWebSearch || modelForceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(bodyObj.tools);
                if (!hasSearch) {
                    bodyObj.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided web search detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle URL Context
            if (this.config.forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(bodyObj.tools);
                if (!hasUrlContext) {
                    bodyObj.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided URL context detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle Code Execution
            if (this.config.forceCodeExecution || modelForceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(bodyObj.tools);
                if (!hasCodeExecution) {
                    bodyObj.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided code execution detected, skipping force injection. (Google Native)`
                    );
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(
                    `[Proxy] ⚠️ Forcing tools enabled, injecting: [${toolsToAdd.join(", ")}] (Google Native)`
                );
            }
        }

        this.formatConverter.ensureServerSideToolInvocations(bodyObj, "[Proxy]");

        // Apply safety settings for native Google requests (only if not already provided)
        if (req.method === "POST" && bodyObj && bodyObj.contents && !bodyObj.safetySettings) {
            bodyObj.safetySettings = this.formatConverter.getDefaultSafetySettings();
        }

        this.logger.debug(
            `[Proxy] Debug: Final Gemini Request (Google Native) = ${JSON.stringify(requestBodyObj, null, 2)}`
        );

        return {
            body: req.method !== "GET" ? JSON.stringify(requestBodyObj) : undefined,
            headers: req.headers,
            is_generative:
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent")),
            method: req.method,
            path: cleanPath,
            query_params: req.query || {},
            request_id: requestId,
            response_transform: responseTransform,
            streaming_mode: modelStreamingMode || this.config.streamingMode,
        };
    }

    _initializeProxyRequestAttempt(proxyRequest) {
        if (!proxyRequest.request_attempt_number) {
            proxyRequest.request_attempt_number = 1;
        }
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _advanceProxyRequestAttempt(proxyRequest) {
        proxyRequest.request_attempt_number = (proxyRequest.request_attempt_number || 1) + 1;
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _forwardRequest(proxyRequest, authIndex = this.currentAuthIndex) {
        const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
        if (connection) {
            this.logger.debug(
                `[Request] Forwarding request #${proxyRequest.request_id} via connection for authIndex=${authIndex}` +
                    ` (attempt=${proxyRequest.request_attempt_id})`
            );
            connection.send(
                JSON.stringify({
                    event_type: "proxy_request",
                    ...proxyRequest,
                })
            );
        } else {
            throw new Error(`Unable to forward request: No WebSocket connection found for authIndex=${authIndex}`);
        }
    }

    _generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    _generateRequestAttemptId(requestId, attemptNumber) {
        return `${requestId}_attempt_${attemptNumber}_${Math.random().toString(36).substring(2, 8)}`;
    }
}

module.exports = RequestHandler;
