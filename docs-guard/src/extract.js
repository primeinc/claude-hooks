/**
 * AST-based extraction of library imports and feature usage from TS/JS code.
 * Uses ts-morph (TypeScript compiler wrapper) for accurate parsing.
 *
 * @see {@link https://ts-morph.com/details/imports} for import declaration API
 * @see {@link https://ts-morph.com/details/expressions} for call expression traversal
 */

const { Project, SyntaxKind, ScriptTarget } = require("ts-morph");
const { debug } = require("./debug");

// Singleton project with in-memory FS — no disk IO, reusable across calls
const project = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: {
    target: ScriptTarget.Latest,
    allowJs: true,
  },
});

/**
 * Node built-in modules that never need doc lookup.
 */
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "crypto", "http", "https", "net", "url", "util",
  "stream", "events", "buffer", "child_process", "cluster", "dgram",
  "dns", "domain", "module", "querystring", "readline", "repl",
  "string_decoder", "tls", "tty", "v8", "vm", "worker_threads", "zlib",
  "assert", "async_hooks", "console", "constants", "inspector",
  "perf_hooks", "process", "timers", "trace_events", "wasi",
  "node:fs", "node:path", "node:os", "node:crypto", "node:http",
  "node:https", "node:net", "node:url", "node:util", "node:stream",
  "node:events", "node:buffer", "node:child_process", "node:cluster",
  "node:dgram", "node:dns", "node:module", "node:querystring",
  "node:readline", "node:string_decoder", "node:tls", "node:tty",
  "node:v8", "node:vm", "node:worker_threads", "node:zlib",
  "node:assert", "node:async_hooks", "node:console", "node:constants",
  "node:inspector", "node:perf_hooks", "node:process", "node:timers",
  "node:trace_events", "node:test",
]);

/**
 * Determine if a module specifier is a third-party library (not relative, not builtin).
 */
function isThirdParty(specifier) {
  if (!specifier) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (NODE_BUILTINS.has(specifier)) return false;
  if (specifier.startsWith("node:")) return false;
  // Path aliases: @/ ~/ #/ are project-internal, not npm scoped packages
  // Real scoped packages always have two segments: @scope/package
  if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) return false;
  return true;
}

/**
 * Get the bare package name from a module specifier.
 * Handles scoped packages: "@foo/bar/baz" -> "@foo/bar"
 * Handles deep imports: "lodash/merge" -> "lodash"
 */
function getPackageName(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

/**
 * Extract the call chain from a CallExpression node.
 * e.g., `router.push(...)` -> "router.push"
 * e.g., `useOptimistic(...)` -> "useOptimistic"
 * e.g., `prisma.user.findMany(...)` -> "prisma.user.findMany"
 */
function getCallName(callExpr) {
  const expr = callExpr.getExpression();

  if (expr.getKind() === SyntaxKind.Identifier) {
    return expr.getText();
  }

  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    return expr.getText();
  }

  // Fallback: just get the text
  return expr.getText();
}

/**
 * Parse code and extract library imports + feature usage.
 *
 * @param {string} code - The source code to analyze
 * @param {string} [filename] - Optional filename hint for language detection
 * @returns {{ libraries: Array<{ name: string, imports: string[], features: string[] }> }}
 */
function extract(code, filename) {
  // Determine virtual filename for correct parser mode
  const ext = filename
    ? filename.slice(filename.lastIndexOf("."))
    : ".tsx";
  const virtualPath = `/__input__${ext}`;

  // Clean up previous file if it exists
  const existing = project.getSourceFile(virtualPath);
  if (existing) {
    project.removeSourceFile(existing);
  }

  const sourceFile = project.createSourceFile(virtualPath, code, { overwrite: true });

  // 1. Extract imports
  const importDecls = sourceFile.getImportDeclarations();
  const libraryMap = new Map(); // packageName -> { imports: Set, features: Set }

  for (const decl of importDecls) {
    const specifier = decl.getModuleSpecifierValue();
    if (!isThirdParty(specifier)) continue;

    const pkgName = getPackageName(specifier);
    if (!libraryMap.has(pkgName)) {
      libraryMap.set(pkgName, { imports: new Set(), features: new Set() });
    }
    const entry = libraryMap.get(pkgName);

    // Default import
    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
      entry.imports.add(defaultImport.getText());
    }

    // Named imports
    for (const named of decl.getNamedImports()) {
      entry.imports.add(named.getName());
    }

    // Namespace import
    const nsImport = decl.getNamespaceImport();
    if (nsImport) {
      entry.imports.add(`* as ${nsImport.getText()}`);
    }
  }

  // 2. Extract call expressions and map to libraries
  const callExprs = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  // Build a lookup: imported name -> package name
  const importedNameToPackage = new Map();
  for (const [pkgName, entry] of libraryMap) {
    for (const imp of entry.imports) {
      // Handle "* as React" -> "React"
      const cleanName = imp.startsWith("* as ") ? imp.slice(5) : imp;
      importedNameToPackage.set(cleanName, pkgName);
    }
  }

  for (const callExpr of callExprs) {
    const callName = getCallName(callExpr);
    // Direct call: useOptimistic() -> check if "useOptimistic" was imported
    // Member call: router.push() -> check if "router" was imported

    const rootName = callName.split(".")[0];
    const pkgName = importedNameToPackage.get(rootName);
    if (pkgName) {
      libraryMap.get(pkgName).features.add(callName);
    }
  }

  // 3. Also check PropertyAccessExpressions that aren't calls (e.g., React.StrictMode)
  const propAccesses = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
  for (const prop of propAccesses) {
    // Skip if parent is a call expression (already captured above)
    if (prop.getParent()?.getKind() === SyntaxKind.CallExpression) continue;

    const text = prop.getText();
    const rootName = text.split(".")[0];
    const pkgName = importedNameToPackage.get(rootName);
    if (pkgName) {
      libraryMap.get(pkgName).features.add(text);
    }
  }

  // Convert to output format
  const libraries = [];
  for (const [name, entry] of libraryMap) {
    libraries.push({
      name,
      imports: [...entry.imports],
      features: [...entry.features],
    });
  }

  // Cleanup
  project.removeSourceFile(sourceFile);

  debug(`Extracted ${libraries.length} libraries from ${virtualPath}:`,
    libraries.map(l => `${l.name} (${l.features.length} features)`));

  return { libraries };
}

module.exports = { extract, isThirdParty, getPackageName, getCallName };
