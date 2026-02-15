const fs = require("node:fs");
const path = require("node:path");

require("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
    target: "es2020",
  },
});
require("tsconfig-paths").register({
  baseUrl: process.cwd(),
  paths: { "@/*": ["./*"] },
});

const { shouldGenerateRealtimeParentTiles } = require("../lib/parentGenerationPolicy.ts");

const failures = [];

const policyCases = [
  { mapId: "default", trigger: "generation", expected: false },
  { mapId: "default", trigger: "confirm-edit", expected: true },
  { mapId: "default", trigger: "delete", expected: true },
  { mapId: "custom-map", trigger: "generation", expected: true },
  { mapId: "custom-map", trigger: "confirm-edit", expected: true },
  { mapId: "custom-map", trigger: "delete", expected: true },
];

for (const testCase of policyCases) {
  const actual = shouldGenerateRealtimeParentTiles(testCase.mapId, testCase.trigger);
  if (actual !== testCase.expected) {
    failures.push(
      `Policy mismatch: mapId="${testCase.mapId}" trigger="${testCase.trigger}" expected=${testCase.expected} actual=${actual}`,
    );
  }
}

const sourceChecks = [
  {
    label: "confirm-edit trigger usage",
    file: path.join(process.cwd(), "app", "api", "confirm-edit", "[z]", "[x]", "[y]", "route.ts"),
    pattern: /shouldGenerateRealtimeParentTiles\s*\(\s*mapId\s*,\s*["']confirm-edit["']\s*\)/,
  },
  {
    label: "delete trigger usage",
    file: path.join(process.cwd(), "app", "api", "delete", "[z]", "[x]", "[y]", "route.ts"),
    pattern: /shouldGenerateRealtimeParentTiles\s*\(\s*mapId\s*,\s*["']delete["']\s*\)/,
  },
  {
    label: "generation trigger usage",
    file: path.join(process.cwd(), "lib", "generator.ts"),
    pattern: /shouldGenerateRealtimeParentTiles\s*\(\s*mapId\s*,\s*["']generation["']\s*\)/,
  },
];

for (const check of sourceChecks) {
  let content = "";
  try {
    content = fs.readFileSync(check.file, "utf8");
  } catch (error) {
    failures.push(`Failed to read ${check.label}: ${check.file} (${error.message})`);
    continue;
  }

  if (!check.pattern.test(content)) {
    failures.push(`Missing ${check.label} in ${check.file}`);
  }
}

if (failures.length > 0) {
  console.error("Parent policy check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Parent policy check passed.");
