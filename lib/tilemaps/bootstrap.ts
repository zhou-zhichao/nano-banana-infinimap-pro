import fs from "node:fs/promises";
import { DEFAULT_MAP_ID, DEFAULT_MAP_NAME, MOON_HEIGHT, MOON_WIDTH } from "./constants";
import { mapTilesDir, TILEMAPS_PRESET_MOON_TILES_DIR } from "./paths";
import { ensureTilemapDirs, ensureTilemapRootDirs, readTilemapManifest, writeTilemapManifest } from "./service";
import type { TilemapManifest } from "./types";

let bootPromise: Promise<void> | null = null;

async function ensureDefaultTilemapFromMoon() {
  const existing = await readTilemapManifest(DEFAULT_MAP_ID);
  if (existing) {
    await ensureTilemapDirs(DEFAULT_MAP_ID);
    return existing;
  }

  const now = new Date().toISOString();
  const manifest: TilemapManifest = {
    id: DEFAULT_MAP_ID,
    name: DEFAULT_MAP_NAME,
    template: "moon",
    width: MOON_WIDTH,
    height: MOON_HEIGHT,
    createdAt: now,
    updatedAt: now,
  };
  await ensureTilemapDirs(DEFAULT_MAP_ID);
  await writeTilemapManifest(manifest);
  await fs.cp(TILEMAPS_PRESET_MOON_TILES_DIR, mapTilesDir(DEFAULT_MAP_ID), { recursive: true });
  return manifest;
}

async function runBootstrap() {
  await ensureTilemapRootDirs();
  await fs.mkdir(TILEMAPS_PRESET_MOON_TILES_DIR, { recursive: true });
  await ensureDefaultTilemapFromMoon();
}

export async function ensureTilemapsBootstrap() {
  if (!bootPromise) {
    bootPromise = runBootstrap().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  await bootPromise;
}
