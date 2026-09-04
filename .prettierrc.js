/**
 * Prettier Configuration
 * Formats code consistently across the project
 * Works in conjunction with ESLint via eslint-plugin-prettier
 */

module.exports = {
    // ==================== Basic Formatting ====================
    // Use 4 spaces for indentation (default for most files)
    tabWidth: 4,
    useTabs: false,

    // Line endings
    endOfLine: "lf",

    // ==================== String & Quotes ====================
    // Use double quotes for JS (matches ESLint config)
    singleQuote: false,
    quoteProps: "as-needed",

    // ==================== Semicolons & Commas ====================
    semi: true,
    trailingComma: "es5", // Trailing commas where valid in ES5 (objects, arrays, etc.)

    // ==================== Line Length ====================
    printWidth: 120,

    // ==================== Spacing ====================
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: "avoid", // Omit parens when possible (a => a)

    // ==================== HTML/Vue Specific ====================
    htmlWhitespaceSensitivity: "css",
    vueIndentScriptAndStyle: false,

    // ==================== File-specific Overrides ====================
    overrides: [
        {
            // All JSON files - use 4 spaces
            files: "*.json",
            options: {
                tabWidth: 4,
                trailingComma: "none",
            },
        },
        {
            // All LESS files - use 4 spaces
            files: "**/*.less",
            options: {
                tabWidth: 4,
            },
        },
        {
            // All HTML files - use 4 spaces
            files: "**/*.html",
            options: {
                tabWidth: 4,
            },
        },
        {
            // Vue files - use 4 spaces, double quotes for HTML attributes
            files: "ui/**/*.vue",
            options: {
                tabWidth: 4,
                singleQuote: false,
                htmlWhitespaceSensitivity: "css",
            },
        },
        {
            // Frontend JavaScript - use single quotes
            files: "ui/**/*.js",
            options: {
                tabWidth: 4,
                singleQuote: true,
            },
        },
        {
            // Backend JavaScript - use double quotes and 4 spaces
            files: ["src/**/*.js", "scripts/**/*.js", "main.js", "*.config.js", ".*.js"],
            options: {
                tabWidth: 4,
                singleQuote: false,
            },
        },
        {
            // Markdown files
            files: ["*.md"],
            options: {
                tabWidth: 2,
                proseWrap: "preserve",
            },
        },
        {
            // YAML files
            files: ["*.{yml,yaml}"],
            options: {
                tabWidth: 2,
            },
        },
    ],
};
