/**
 * Model-pool routing helpers.
 *
 * The server can optionally partition request traffic by model family.  A
 * routing group is deliberately configuration-only: it does not create a
 * second browser pool by itself, but it constrains which READY accounts may
 * receive a request.  This keeps the feature backwards compatible while
 * allowing separate server instances (or explicit account lists) to own
 * different model families.
 */

function normalizeModelName(modelName) {
    if (modelName === undefined || modelName === null) return null;
    const value = String(modelName)
        .trim()
        .replace(/^models\//i, "")
        .replace(/^\/+/, "")
        .toLowerCase();
    return value || null;
}

function escapeRegExp(value) {
    return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function patternToRegExp(pattern) {
    const normalized = normalizeModelName(pattern);
    if (!normalized) return null;
    const source = normalized.split("*").map(escapeRegExp).join(".*").split("?").join(".");
    return new RegExp(`^${source}$`, "i");
}

function sanitizePatterns(patterns) {
    const values = Array.isArray(patterns) ? patterns : patterns == null ? [] : [patterns];
    return [...new Set(values.map(normalizeModelName).filter(Boolean))];
}

function sanitizeAuthIndices(values) {
    if (!Array.isArray(values)) return null;
    return [...new Set(values.map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 0))];
}

function normalizeModelRouting(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawGroups = Array.isArray(source.groups) ? source.groups : [];
    const groups = [];
    const ids = new Set();

    for (const entry of rawGroups) {
        if (!entry || typeof entry !== "object") continue;
        const patterns = sanitizePatterns(entry.patterns ?? entry.models ?? entry.modelPatterns);
        if (patterns.length === 0) continue;
        const fallbackId = patterns[0].replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
        let id = String((entry.id ?? fallbackId) || `group-${groups.length + 1}`)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "");
        if (!id) id = `group-${groups.length + 1}`;
        let uniqueId = id;
        let suffix = 2;
        while (ids.has(uniqueId)) uniqueId = `${id}-${suffix++}`;
        ids.add(uniqueId);
        groups.push({
            authIndices: sanitizeAuthIndices(entry.authIndices ?? entry.accounts),
            id: uniqueId,
            label: String(entry.label ?? entry.name ?? uniqueId).trim() || uniqueId,
            patterns,
        });
    }

    const allowlist = sanitizePatterns(source.allowlist ?? source.patterns ?? source.models);
    const enabled = source.enabled === undefined ? groups.length > 0 || allowlist.length > 0 : Boolean(source.enabled);
    const defaultGroupId = source.defaultGroupId ? String(source.defaultGroupId).trim().toLowerCase() : null;
    return {
        allowlist,
        defaultGroupId,
        enabled,
        groups,
        strict: Boolean(source.strict),
    };
}

function matchModelRoutingGroup(modelName, routing) {
    const normalized = normalizeModelName(modelName);
    if (!normalized) return null;
    const config = normalizeModelRouting(routing);
    for (const group of config.groups) {
        if (group.patterns.some(pattern => patternToRegExp(pattern)?.test(normalized))) return group;
    }
    // A server-level allowlist without named groups still behaves as one
    // implicit pool.  This is useful for deployments dedicated to one model.
    if (config.allowlist.some(pattern => patternToRegExp(pattern)?.test(normalized))) {
        return {
            authIndices: null,
            id: "__allowlist__",
            label: "allowlist",
            patterns: config.allowlist,
        };
    }
    if (config.defaultGroupId) return config.groups.find(group => group.id === config.defaultGroupId) || null;
    return null;
}

function isModelAllowed(modelName, routing) {
    const config = normalizeModelRouting(routing);
    if (!config.enabled) return { allowed: true, group: null, model: normalizeModelName(modelName) };
    const model = normalizeModelName(modelName);
    if (!model) {
        return { allowed: !config.strict, group: null, model: null, reason: "model_required" };
    }
    const group = matchModelRoutingGroup(model, config);
    if (group) return { allowed: true, group, model };
    return {
        allowed: !config.strict,
        group: null,
        model,
        reason: "model_not_in_pool",
    };
}

function getAccountGroupNames(authSource, authIndex) {
    const groups = authSource?.getModelGroups?.(authIndex);
    return Array.isArray(groups) ? groups.map(value => String(value).trim().toLowerCase()).filter(Boolean) : [];
}

function isAccountEligibleForGroup(authIndex, group, authSource) {
    if (!group) return true;
    if (group.id === "__allowlist__") return true;
    if (Array.isArray(group.authIndices) && group.authIndices.length > 0) {
        return group.authIndices.includes(authIndex);
    }
    const accountGroups = getAccountGroupNames(authSource, authIndex);
    return accountGroups.length === 0 || accountGroups.includes(String(group.id).toLowerCase());
}

function routingKey(modelName, routing) {
    const result = isModelAllowed(modelName, routing);
    if (!result.model) return null;
    // A compact allowlist has no named group boundary. Keep its breaker
    // state per concrete model so a 429 on 3.7-flash does not quarantine
    // 3.8-flash on the same credential.
    if (result.group?.id === "__allowlist__") return result.model;
    return result.group?.id || result.model;
}

module.exports = {
    getAccountGroupNames,
    isAccountEligibleForGroup,
    isModelAllowed,
    matchModelRoutingGroup,
    normalizeModelName,
    normalizeModelRouting,
    patternToRegExp,
    routingKey,
    sanitizePatterns,
};
