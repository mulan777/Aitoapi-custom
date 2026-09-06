/**
 * File: src/auth/AuthSource.js
 * Description: Authentication source manager that loads and validates authentication data from config files
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

/**
 * Authentication Source Management Module
 * Responsible for loading and managing authentication information from the file system
 */
class AuthSource {
    constructor(logger) {
        this.logger = logger;
        this.authMode = "file";
        this.availableIndices = [];
        // Indices used for rotation/switching (deduplicated by email, keeping the latest index per account)
        this.rotationIndices = [];
        // Duplicate auth indices detected (valid JSON but skipped from rotation due to same email)
        this.duplicateIndices = [];
        // Expired auth indices (valid JSON but marked as expired, excluded from rotation)
        this.expiredIndices = [];
        // Disabled auth indices (manual or automatic status-code quarantine)
        this.disabledIndices = [];
        this.initialIndices = [];
        this.accountNameMap = new Map();
        this.accountStatusMap = new Map();
        // Map any valid index -> canonical (latest) index for the same account email
        this.canonicalIndexMap = new Map();
        // Duplicate groups (email -> kept + duplicates)
        this.duplicateGroups = [];
        this.lastScannedIndices = "[]"; // Cache to track changes
        this.lastScannedSignature = "[]";
        this.currentScanSignature = "[]";

        this.logger.info('[Auth] Using files in "configs/auth/" directory for authentication.');

        this.reloadAuthSources(true); // Initial load

        if (this.availableIndices.length === 0) {
            this.logger.warn(
                `[Auth] No valid authentication sources found in 'file' mode. The server will start in account binding mode.`
            );
        }
    }

    reloadAuthSources(isInitialLoad = false) {
        const oldSignature = this.lastScannedSignature;
        this._discoverAvailableIndices();
        const newIndices = JSON.stringify(this.initialIndices);
        const newSignature = this.currentScanSignature;

        // Reload when a file is added/removed or replaced in place.
        if (isInitialLoad || oldSignature !== newSignature) {
            this.logger.info(`[Auth] Auth file scan detected changes. Reloading and re-validating...`);
            this._preValidateAndFilter();
            this.logger.info(
                `[Auth] Reload complete. ${this.availableIndices.length} valid sources available: [${this.availableIndices.join(", ")}]`
            );
            this.lastScannedIndices = newIndices;
            this.lastScannedSignature = newSignature;
            return true; // Changes detected
        }
        return false; // No changes
    }

    removeAuth(index) {
        if (!Number.isInteger(index)) {
            throw new Error("Invalid account index.");
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        if (!fs.existsSync(authFilePath)) {
            throw new Error(`Auth file for account #${index} does not exist.`);
        }

        try {
            fs.unlinkSync(authFilePath);
        } catch (error) {
            throw new Error(`Failed to delete auth file for account #${index}: ${error.message}`);
        }

        return {
            remainingAccounts: this.availableIndices.length,
            removedIndex: index,
        };
    }

    _discoverAvailableIndices() {
        let indices = [];
        const configDir = path.join(process.cwd(), "configs", "auth");
        if (!fs.existsSync(configDir)) {
            this.availableIndices = [];
            this.initialIndices = [];
            this.currentScanSignature = "[]";
            return;
        }
        try {
            const files = fs.readdirSync(configDir);
            const authFiles = files.filter(file => /^auth-\d+\.json$/.test(file)).sort();
            indices = authFiles.map(file => parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10));
            this.currentScanSignature = JSON.stringify(
                authFiles.map(file => {
                    const stat = fs.statSync(path.join(configDir, file));
                    return [file, stat.size, Math.trunc(stat.mtimeMs)];
                })
            );
        } catch (error) {
            this.logger.error(`[Auth] Failed to scan "configs/auth/" directory: ${error.message}`);
            this.availableIndices = [];
            this.initialIndices = [];
            this.currentScanSignature = "[]";
            return;
        }

        this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    }

    _preValidateAndFilter() {
        if (this.initialIndices.length === 0) {
            this.availableIndices = [];
            this.rotationIndices = [];
            this.duplicateIndices = [];
            this.expiredIndices = [];
            this.disabledIndices = [];
            this.accountNameMap.clear();
            this.accountStatusMap.clear();
            this.canonicalIndexMap.clear();
            this.duplicateGroups = [];
            return;
        }

        const validIndices = [];
        const invalidSourceDescriptions = [];
        this.accountNameMap.clear(); // Clear old names before re-validating
        this.accountStatusMap.clear();
        this.canonicalIndexMap.clear();
        this.duplicateGroups = [];
        this.expiredIndices = [];
        this.disabledIndices = [];

        for (const index of this.initialIndices) {
            // Iterate over initial to check all, not just previously available
            const authContent = this._getAuthContent(index);
            if (authContent) {
                try {
                    const authData = JSON.parse(authContent);
                    validIndices.push(index);
                    this.accountNameMap.set(index, authData.accountName || null);
                    this.accountStatusMap.set(index, {
                        disabledAt: authData.disabledAt || null,
                        disabledReason: authData.disabledReason || null,
                        disabledStatus: Number.isFinite(Number(authData.disabledStatus))
                            ? Number(authData.disabledStatus)
                            : null,
                    });
                    // Track expired status from auth file
                    if (authData.expired === true) {
                        this.expiredIndices.push(index);
                    }
                    if (authData.disabled === true) {
                        this.disabledIndices.push(index);
                    }
                } catch (e) {
                    invalidSourceDescriptions.push(`auth-${index} (parse error)`);
                }
            } else {
                invalidSourceDescriptions.push(`auth-${index} (unreadable)`);
            }
        }

        if (invalidSourceDescriptions.length > 0) {
            this.logger.warn(
                `⚠️ [Auth] Pre-validation found ${
                    invalidSourceDescriptions.length
                } authentication sources with format errors or unreadable: [${invalidSourceDescriptions.join(
                    ", "
                )}], will be removed from available list.`
            );
        }

        this.availableIndices = validIndices.sort((a, b) => a - b);
        this._buildRotationIndices();
    }

    _normalizeEmailKey(accountName) {
        if (typeof accountName !== "string") return null;
        const trimmed = accountName.trim();
        if (!trimmed) return null;
        // Conservative: only deduplicate when the name looks like an email address.
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(trimmed)) return null;
        return trimmed.toLowerCase();
    }

    _buildRotationIndices() {
        this.rotationIndices = [];
        this.duplicateIndices = [];
        this.duplicateGroups = [];
        this.canonicalIndexMap.clear();

        const emailKeyToIndices = new Map();

        // Only process usable accounts for rotation and deduplication
        const nonExpiredIndices = this.availableIndices.filter(
            idx => !this.expiredIndices.includes(idx) && !this.disabledIndices.includes(idx)
        );

        for (const index of nonExpiredIndices) {
            const accountName = this.accountNameMap.get(index);
            const emailKey = this._normalizeEmailKey(accountName);

            if (!emailKey) {
                this.rotationIndices.push(index);
                this.canonicalIndexMap.set(index, index);
                continue;
            }

            const list = emailKeyToIndices.get(emailKey) || [];
            list.push(index);
            emailKeyToIndices.set(emailKey, list);
        }

        for (const [emailKey, indices] of emailKeyToIndices.entries()) {
            indices.sort((a, b) => a - b);
            const keptIndex = indices[indices.length - 1];
            this.rotationIndices.push(keptIndex);

            const duplicateIndices = [];
            for (const index of indices) {
                this.canonicalIndexMap.set(index, keptIndex);
                if (index !== keptIndex) {
                    duplicateIndices.push(index);
                }
            }

            if (duplicateIndices.length > 0) {
                this.duplicateIndices.push(...duplicateIndices);
                this.duplicateGroups.push({
                    email: emailKey,
                    keptIndex,
                    removedIndices: duplicateIndices,
                });
            }
        }

        this.rotationIndices = [...new Set(this.rotationIndices)].sort((a, b) => a - b);
        this.duplicateIndices = [...new Set(this.duplicateIndices)].sort((a, b) => a - b);

        if (this.duplicateIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.duplicateIndices.length} duplicate auth files (same email). ` +
                    `Rotation will only use latest index per account: [${this.rotationIndices.join(", ")}].`
            );
        }

        if (this.expiredIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.expiredIndices.length} expired auth files: [${this.expiredIndices.join(", ")}]. ` +
                    `These accounts are excluded from automatic rotation.`
            );
        }
        if (this.disabledIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.disabledIndices.length} disabled auth files: [${this.disabledIndices.join(", ")}]. ` +
                    `These accounts are excluded from automatic rotation.`
            );
        }
    }

    _getAuthContent(index) {
        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        if (!fs.existsSync(authFilePath)) return null;
        try {
            return fs.readFileSync(authFilePath, "utf-8");
        } catch (e) {
            return null;
        }
    }

    getAuth(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.error(`[Auth] Requested invalid or non-existent authentication index: ${index}`);
            return null;
        }

        const jsonString = this._getAuthContent(index);
        if (!jsonString) {
            this.logger.error(`[Auth] Unable to retrieve content for authentication source #${index} during read.`);
            return null;
        }

        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.error(`[Auth] Failed to parse JSON content from authentication source #${index}: ${e.message}`);
            return null;
        }
    }

    getStatusMetadata(index) {
        return this.accountStatusMap.get(index) || { disabledAt: null, disabledReason: null, disabledStatus: null };
    }

    getRotationIndices() {
        return this.rotationIndices;
    }

    getCanonicalIndex(index) {
        if (!Number.isInteger(index)) return null;
        if (!this.availableIndices.includes(index)) return null;
        return this.canonicalIndexMap.get(index) ?? index;
    }

    getDuplicateGroups() {
        return this.duplicateGroups;
    }

    /**
     * Mark an auth as expired
     *
     * Side effects:
     * - Adds "expired": true to the auth file (configs/auth/auth-{index}.json)
     * - Adds index to this.expiredIndices array
     * - Rebuilds rotation indices (calls this._buildRotationIndices()) to exclude the expired account from rotation
     * - Updates canonicalIndexMap to reflect the new rotation state
     *
     * @param {number} index - Auth index to mark as expired
     * @returns {Promise<boolean>} True if successfully marked as expired, false if auth doesn't exist, is already expired, or file operation fails
     */
    async markAsExpired(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.warn(`[Auth] Cannot mark non-existent auth #${index} as expired`);
            return false;
        }

        if (this.expiredIndices.includes(index)) {
            if (!this.disabledIndices.includes(index)) {
                return this.disableAuth(index, { reason: "expired" });
            }
            this.logger.debug(`[Auth] Auth #${index} is already marked as expired`);
            return false;
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        try {
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            authData.expired = true;
            authData.disabled = true;
            authData.disabledReason = authData.disabledReason || "expired";
            authData.disabledAt = authData.disabledAt || new Date().toISOString();
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            if (!this.expiredIndices.includes(index)) this.expiredIndices.push(index);
            if (!this.disabledIndices.includes(index)) this.disabledIndices.push(index);
            this.accountStatusMap.set(index, {
                disabledAt: authData.disabledAt,
                disabledReason: authData.disabledReason,
                disabledStatus: authData.disabledStatus || null,
            });

            // Rebuild rotation indices to exclude this unavailable account
            // This will properly rebuild canonicalIndexMap and handle duplicate relationships
            this._buildRotationIndices();

            this.logger.warn(`[Auth] ⏰ Marked auth #${index} as expired`);
            return true;
        } catch (error) {
            this.logger.error(`[Auth] Failed to mark auth #${index} as expired: ${error.message}`);
            return false;
        }
    }

    /**
     * Unmark an auth as expired (restore it to active status)
     *
     * Side effects:
     * - Removes "expired" field from the auth file (configs/auth/auth-{index}.json)
     * - Removes index from this.expiredIndices array
     * - Rebuilds rotation indices (calls this._buildRotationIndices()) to include the restored account in rotation
     * - Updates canonicalIndexMap to reflect the new rotation state
     *
     * @param {number} index - Auth index to restore
     * @returns {Promise<boolean>} True if successfully restored, false if auth doesn't exist, is not expired, or file operation fails
     */
    async unmarkAsExpired(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.warn(`[Auth] Cannot unmark non-existent auth #${index}`);
            return false;
        }

        if (!this.expiredIndices.includes(index)) {
            this.logger.debug(`[Auth] Auth #${index} is not marked as expired`);
            return false;
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        try {
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            delete authData.expired;
            if (authData.disabledReason === "expired") {
                delete authData.disabled;
                delete authData.disabledReason;
                delete authData.disabledAt;
                delete authData.disabledStatus;
            }
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.expiredIndices = this.expiredIndices.filter(idx => idx !== index);
            this.disabledIndices = this.disabledIndices.filter(idx => idx !== index);
            this.accountStatusMap.set(index, {
                disabledAt: null,
                disabledReason: null,
                disabledStatus: null,
            });

            // Rebuild rotation indices to include this restored account
            this._buildRotationIndices();

            this.logger.info(`[Auth] ✅ Restored auth #${index} from expired status`);
            return true;
        } catch (error) {
            this.logger.error(`[Auth] Failed to restore auth #${index}: ${error.message}`);
            return false;
        }
    }

    /**
     * Disable an auth source and persist the reason. Disabled accounts remain
     * visible in the UI but are excluded from automatic rotation.
     */
    async disableAuth(index, metadata = {}) {
        if (!this.availableIndices.includes(index)) return false;
        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        const wasDisabled = this.disabledIndices.includes(index);
        if (!wasDisabled) {
            this.disabledIndices.push(index);
            this._buildRotationIndices();
        }
        try {
            const authData = JSON.parse(await fsPromises.readFile(authFilePath, "utf-8"));
            authData.disabled = true;
            authData.disabledReason = String(metadata.reason || authData.disabledReason || "manual");
            if (authData.disabledReason === "expired") authData.expired = true;
            if (metadata.status !== undefined) authData.disabledStatus = Number(metadata.status);
            authData.disabledAt = new Date().toISOString();
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));
            if (!this.disabledIndices.includes(index)) this.disabledIndices.push(index);
            this.accountStatusMap.set(index, {
                disabledAt: authData.disabledAt,
                disabledReason: authData.disabledReason,
                disabledStatus: authData.disabledStatus || null,
            });
            this._buildRotationIndices();
            this.logger.warn(
                `[Auth] Disabled auth #${index} (${authData.disabledReason}${authData.disabledStatus ? `, status ${authData.disabledStatus}` : ""})`
            );
            return true;
        } catch (error) {
            if (!wasDisabled) {
                this.disabledIndices = this.disabledIndices.filter(idx => idx !== index);
                this._buildRotationIndices();
            }
            this.logger.error(`[Auth] Failed to disable auth #${index}: ${error.message}`);
            return false;
        }
    }

    /** Re-enable an auth source after the operator has fixed/replaced it. */
    async enableAuth(index) {
        if (!this.availableIndices.includes(index)) return false;
        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        try {
            const authData = JSON.parse(await fsPromises.readFile(authFilePath, "utf-8"));
            delete authData.disabled;
            delete authData.disabledReason;
            delete authData.disabledAt;
            delete authData.disabledStatus;
            delete authData.expired;
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));
            this.disabledIndices = this.disabledIndices.filter(idx => idx !== index);
            this.expiredIndices = this.expiredIndices.filter(idx => idx !== index);
            this.accountStatusMap.set(index, { disabledAt: null, disabledReason: null, disabledStatus: null });
            this._buildRotationIndices();
            this.logger.info(`[Auth] Enabled auth #${index}`);
            return true;
        } catch (error) {
            this.logger.error(`[Auth] Failed to enable auth #${index}: ${error.message}`);
            return false;
        }
    }

    isDisabled(index) {
        return this.disabledIndices.includes(index);
    }

    isUnavailable(index) {
        return this.isExpired(index) || this.isDisabled(index);
    }

    /**
     * Check if an auth is expired
     * @param {number} index - Auth index to check
     * @returns {boolean}
     */
    isExpired(index) {
        return this.expiredIndices.includes(index);
    }
}

module.exports = AuthSource;
