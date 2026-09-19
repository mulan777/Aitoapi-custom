const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const AuthSource = require("../../src/auth/AuthSource");

const logger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
};

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitoapi-auth-signature-"));
const authDir = path.join(tempDir, "configs", "auth");
fs.mkdirSync(authDir, { recursive: true });

const authPath = path.join(authDir, "auth-1.json");
const writeAuth = value => fs.writeFileSync(authPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

try {
    writeAuth({
        accountName: "one@example.test",
        cookies: [{ name: "session", value: "first" }],
        origins: [],
    });
    process.chdir(tempDir);
    const source = new AuthSource(logger);

    assert.strictEqual(source.reloadAuthSources(), false, "unchanged files must not reload");

    writeAuth({
        accountName: "one@example.test",
        cookies: [{ name: "session", value: "a-much-longer-refreshed-cookie" }],
        origins: [{ localStorage: [{ name: "token", value: "refreshed" }], origin: "https://example.test" }],
    });
    assert.strictEqual(source.reloadAuthSources(), false, "cookie/origin refresh must not rebalance the pool");

    writeAuth({
        accountName: "one@example.test",
        cookies: [],
        disabled: true,
        disabledAt: "2026-09-19T06:00:00.000Z",
        disabledReason: "manual",
        origins: [],
    });
    assert.strictEqual(source.reloadAuthSources(), true, "disabled metadata must trigger a reload");
    assert.strictEqual(source.isDisabled(1), true, "disabled account must be reflected after reload");

    writeAuth({
        accountName: "renamed@example.test",
        cookies: [],
        origins: [],
    });
    assert.strictEqual(source.reloadAuthSources(), true, "account identity changes must trigger a reload");

    console.log("authSourceOperationalSignature.test.js: PASS");
} finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { force: true, recursive: true });
}
