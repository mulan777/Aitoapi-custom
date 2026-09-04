/**
 * ESLint Configuration
 * Enforces code style consistency across the project
 */

module.exports = {
    env: {
        node: true,
        es2021: true,
    },
    extends: [
        "eslint:recommended",
        "plugin:prettier/recommended", // Enables eslint-plugin-prettier and eslint-config-prettier
    ],
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
    },
    plugins: ["sort-keys-fix", "jsonc", "vue"],
    overrides: [
        {
            // Configuration files - exempt from object key sorting
            files: [".eslintrc.js", ".prettierrc.js", ".stylelintrc.js", "*.config.js"],
            rules: {
                "sort-keys-fix/sort-keys-fix": "off",
            },
        },
        {
            // Vue Single File Components
            files: ["ui/**/*.vue"],
            extends: [
                "eslint:recommended",
                "plugin:vue/vue3-recommended",
                "plugin:prettier/recommended", // Must be last
            ],
            parser: "vue-eslint-parser",
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
            globals: {
                __APP_VERSION__: "readonly",
            },
            rules: {
                // Vue-specific rules for component naming
                "vue/component-name-in-template-casing": ["error", "PascalCase"],
                "vue/component-definition-name-casing": ["error", "PascalCase"],
                // Allow single-word component names for pages
                "vue/multi-word-component-names": "off",

                // Disable Vue formatting rules (Prettier handles these)
                "vue/html-indent": "off",
                "vue/script-indent": "off",
                "vue/max-attributes-per-line": "off",
                "vue/first-attribute-linebreak": "off",
                "vue/html-closing-bracket-newline": "off",
                "vue/singleline-html-element-content-newline": "off",
                "vue/multiline-html-element-content-newline": "off",
                "vue/html-self-closing": "off",
            },
        },
        {
            // JSON files in locales directory - enforce sorted keys
            files: ["ui/locales/*.json"],
            extends: [
                "plugin:jsonc/recommended-with-json",
                "plugin:prettier/recommended", // Must be last
            ],
            parser: "jsonc-eslint-parser",
            rules: {
                "jsonc/sort-keys": [
                    "error",
                    "asc",
                    {
                        caseSensitive: false,
                        natural: true,
                    },
                ],
                "jsonc/indent": ["error", 4],
                "jsonc/key-spacing": [
                    "error",
                    {
                        beforeColon: false,
                        afterColon: true,
                    },
                ],
                "jsonc/comma-dangle": ["error", "never"],
            },
        },
        {
            // All JSON files - enforce 4-space indentation and sorting
            files: ["**/*.json"],
            extends: [
                "plugin:jsonc/recommended-with-json",
                "plugin:prettier/recommended", // Must be last
            ],
            parser: "jsonc-eslint-parser",
            rules: {
                "jsonc/indent": ["error", 4],
                "jsonc/key-spacing": [
                    "error",
                    {
                        beforeColon: false,
                        afterColon: true,
                    },
                ],
                "jsonc/comma-dangle": ["error", "never"],
                // Sort keys in all JSON files except package.json (dependencies shouldn't be sorted)
                "jsonc/sort-keys": [
                    "error",
                    "asc",
                    {
                        caseSensitive: false,
                        natural: true,
                        minKeys: 2,
                    },
                ],
            },
        },
        {
            // package.json, package-lock.json, nodemon.json - don't sort these files
            files: ["package.json", "package-lock.json", "nodemon.json"],
            extends: ["plugin:jsonc/recommended-with-json", "plugin:prettier/recommended"],
            parser: "jsonc-eslint-parser",
            rules: {
                "jsonc/indent": ["error", 4],
                "jsonc/sort-keys": "off", // Don't sort package.json, lock files, etc.
            },
        },
        {
            // Browser environment for client-side scripts
            files: ["src/browser/*.js"],
            env: {
                browser: true,
                es2021: true,
            },
        },
        {
            // Frontend JavaScript files - enforce single quotes
            files: ["ui/**/*.js"],
            env: {
                browser: true,
                es2021: true,
            },
            globals: {
                Vue: "readonly",
                ElementPlus: "readonly",
                toggleLanguage: "readonly",
                switchSpecificAccount: "readonly",
                updateContent: "readonly",
                handleLogout: "readonly",
            },
            rules: {
                quotes: [
                    "error",
                    "single",
                    {
                        avoidEscape: true,
                        allowTemplateLiterals: true,
                    },
                ],
                "no-unused-vars": [
                    "error",
                    {
                        vars: "all",
                        args: "after-used",
                        ignoreRestSiblings: true,
                        varsIgnorePattern: "^(toggleLanguage|switchSpecificAccount|updateContent|handleLogout)$",
                    },
                ],
            },
        },
    ],
    rules: {
        // ==================== Code Quality ====================
        // Warn about unused variables to prevent dead code
        "no-unused-vars": [
            "error",
            {
                vars: "all",
                args: "after-used",
                ignoreRestSiblings: true,
            },
        ],

        // Allow console statements (project uses custom logger)
        "no-console": "off",

        // Disallow var declarations, prefer const/let
        "no-var": "error",
        "prefer-const": [
            "error",
            {
                destructuring: "any",
                ignoreReadBeforeAssign: false,
            },
        ],

        // ==================== Code Style ====================
        // Prefer arrow functions for callbacks
        "prefer-arrow-callback": [
            "error",
            {
                allowNamedFunctions: false,
                allowUnboundThis: true,
            },
        ],

        // Prefer concise arrow function syntax when possible
        "arrow-body-style": ["error", "as-needed"],

        // Prefer object shorthand notation (which uses arrow functions for methods)
        "object-shorthand": ["error", "always"],

        // Disallow padding within blocks
        "padded-blocks": ["error", "never"],

        // Enforce sorted object keys (fixable), run `npx eslint --fix .`
        // Exempt configuration files from sorting to maintain logical grouping
        "sort-keys-fix/sort-keys-fix": [
            "error",
            "asc",
            {
                caseSensitive: false,
                natural: true,
            },
        ],

        // ==================== Disabled Rules (Prettier Handles These) ====================
        // Formatting rules disabled because Prettier handles them better
        // This prevents conflicts between ESLint and Prettier
        indent: "off",
        quotes: "off",
        semi: "off",
        "comma-dangle": "off",
        "arrow-parens": "off",
        "object-curly-spacing": "off",
        "array-bracket-spacing": "off",
        "keyword-spacing": "off",
        "space-before-blocks": "off",
        "space-before-function-paren": "off",
        "space-infix-ops": "off",
        "no-multiple-empty-lines": "off",
        "no-trailing-spaces": "off",
        "eol-last": "off",
        "operator-linebreak": "off",
        "newline-per-chained-call": "off",
        "max-len": "off",
    },
};
