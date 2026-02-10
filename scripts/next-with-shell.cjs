#!/usr/bin/env node
const { spawn } = require("node:child_process");

const nextArg = process.argv[2];
if (!nextArg) {
  console.error("Usage: node scripts/next-with-shell.cjs <dev|build|start> [args...]");
  process.exit(1);
}

const rawArgs = process.argv.slice(3);
const nextArgs = [nextArg, ...rawArgs];

const needsHostnameDefault = nextArg === "dev" || nextArg === "start";
if (needsHostnameDefault) {
  const hasHostnameArg = rawArgs.some((arg) =>
    arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname=")
  );

  if (!hasHostnameArg) {
    nextArgs.push("--hostname", process.env.NEXT_HOST || "0.0.0.0");
  }
}

if (process.platform === "win32") {
  process.env.SHELL = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
