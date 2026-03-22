const { extract } = require("../src/extract");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual, null, 2);
  const e = JSON.stringify(expected, null, 2);
  if (a !== e) throw new Error(`${msg || "Mismatch"}\n  Expected: ${e}\n  Actual:   ${a}`);
}

console.log("\n--- extract() tests ---\n");

test("ignores relative imports", () => {
  const result = extract(`
    import { foo } from "./utils";
    import bar from "../lib/bar";
    foo();
  `);
  assert(result.libraries.length === 0, `Expected 0 libraries, got ${result.libraries.length}`);
});

test("ignores path aliases (@/, ~/, #)", () => {
  const result = extract(`
    import { Button } from "@/components/ui/button";
    import { useIsMobile } from "@/hooks/use-mobile";
    import { cn } from "@/lib/utils";
    import config from "~/config";
    import { schema } from "#shared/schema";
    Button();
  `);
  assert(result.libraries.length === 0, `Expected 0 libraries, got ${result.libraries.length}`);
});

test("ignores node builtins", () => {
  const result = extract(`
    import fs from "fs";
    import { join } from "path";
    import { createServer } from "node:http";
    fs.readFileSync("x");
  `);
  assert(result.libraries.length === 0, `Expected 0 libraries, got ${result.libraries.length}`);
});

test("extracts named imports from a library", () => {
  const result = extract(`
    import { useState, useEffect } from "react";
    useState(0);
    useEffect(() => {}, []);
  `);
  assert(result.libraries.length === 1, `Expected 1 library, got ${result.libraries.length}`);
  assert(result.libraries[0].name === "react", `Expected "react", got "${result.libraries[0].name}"`);
  assert(result.libraries[0].imports.includes("useState"), "Missing useState import");
  assert(result.libraries[0].imports.includes("useEffect"), "Missing useEffect import");
  assert(result.libraries[0].features.includes("useState"), "Missing useState feature");
  assert(result.libraries[0].features.includes("useEffect"), "Missing useEffect feature");
});

test("extracts default import + member access", () => {
  const result = extract(`
    import React from "react";
    const el = React.createElement("div");
  `);
  assert(result.libraries.length === 1);
  assert(result.libraries[0].imports.includes("React"), "Missing React default import");
  assert(result.libraries[0].features.includes("React.createElement"), "Missing React.createElement feature");
});

test("extracts namespace import", () => {
  const result = extract(`
    import * as lodash from "lodash";
    lodash.merge({}, {});
  `);
  assert(result.libraries.length === 1);
  assert(result.libraries[0].name === "lodash");
  assert(result.libraries[0].features.includes("lodash.merge"), "Missing lodash.merge feature");
});

test("handles scoped packages", () => {
  const result = extract(`
    import { PrismaClient } from "@prisma/client";
    const prisma = new PrismaClient();
  `);
  assert(result.libraries.length === 1);
  assert(result.libraries[0].name === "@prisma/client", `Expected "@prisma/client", got "${result.libraries[0].name}"`);
  assert(result.libraries[0].imports.includes("PrismaClient"), "Missing PrismaClient import");
});

test("handles deep imports", () => {
  const result = extract(`
    import merge from "lodash/merge";
    merge({}, {});
  `);
  assert(result.libraries.length === 1);
  assert(result.libraries[0].name === "lodash", `Expected "lodash", got "${result.libraries[0].name}"`);
});

test("handles multiple libraries", () => {
  const result = extract(`
    import { useState } from "react";
    import express from "express";
    import { z } from "zod";

    const app = express();
    app.get("/", (req, res) => {});
    const schema = z.object({ name: z.string() });
    useState(null);
  `);
  assert(result.libraries.length === 3, `Expected 3 libraries, got ${result.libraries.length}`);
  const names = result.libraries.map(l => l.name).sort();
  assertDeep(names, ["express", "react", "zod"]);
});

test("handles TypeScript syntax (interfaces, generics, type annotations)", () => {
  const result = extract(`
    import { z } from "zod";
    import type { InferType } from "zod";

    interface Config {
      name: string;
    }

    const schema = z.object({ name: z.string() });
    type SchemaType = z.infer<typeof schema>;
  `, "config.ts");
  assert(result.libraries.length === 1);
  assert(result.libraries[0].name === "zod");
  assert(result.libraries[0].features.includes("z.object"), "Missing z.object feature");
  assert(result.libraries[0].features.includes("z.string"), "Missing z.string feature");
});

test("handles chained member expressions", () => {
  const result = extract(`
    import { Router } from "express";
    const router = Router();
    router.get("/api", handler);
    router.post("/api", handler);
  `);
  assert(result.libraries.length === 1);
  assert(result.libraries[0].features.includes("Router"), "Missing Router call");
});

test("property access without call (e.g., React.StrictMode)", () => {
  const result = extract(`
    import React from "react";
    const app = <React.StrictMode><App /></React.StrictMode>;
  `);
  assert(result.libraries.length === 1);
  // React.StrictMode is a property access, not a call
  const features = result.libraries[0].features;
  assert(features.some(f => f.includes("React.StrictMode")), `Missing React.StrictMode, got: ${features}`);
});

test("empty code returns no libraries", () => {
  const result = extract("");
  assert(result.libraries.length === 0);
});

test("code with no imports returns no libraries", () => {
  const result = extract(`
    const x = 1 + 2;
    console.log(x);
    function hello() { return "world"; }
  `);
  assert(result.libraries.length === 0);
});

// --- CommonJS require() tests ---

test("extracts simple require", () => {
  const result = extract(`
    const express = require("express");
    const app = express();
  `, "app.js");
  assert(result.libraries.length === 1, `Expected 1, got ${result.libraries.length}`);
  assert(result.libraries[0].name === "express");
  assert(result.libraries[0].imports.includes("express"));
  assert(result.libraries[0].features.includes("express"));
});

test("extracts destructured require", () => {
  const result = extract(`
    const { useState, useEffect } = require("react");
    useState(0);
    useEffect(() => {});
  `, "app.js");
  assert(result.libraries.length === 1);
  assert(result.libraries[0].name === "react");
  assert(result.libraries[0].imports.includes("useState"));
  assert(result.libraries[0].imports.includes("useEffect"));
  assert(result.libraries[0].features.includes("useState"));
});

test("ignores require of node builtins", () => {
  const result = extract(`
    const fs = require("fs");
    const path = require("path");
    fs.readFileSync("x");
  `, "app.js");
  assert(result.libraries.length === 0);
});

test("handles mixed ESM imports and require", () => {
  const result = extract(`
    import { z } from "zod";
    const express = require("express");
    z.string();
    express();
  `, "app.ts");
  assert(result.libraries.length === 2);
  const names = result.libraries.map(l => l.name).sort();
  assert(names[0] === "express" && names[1] === "zod", `Got: ${names}`);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
