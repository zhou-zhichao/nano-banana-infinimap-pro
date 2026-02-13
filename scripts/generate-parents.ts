/* Regenerate all parent tiles from existing max-zoom tiles.
 * Usage: yarn regen:parents [mapId]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ZMAX } from "../lib/coords";
import { generateAllParentTiles } from "../lib/parentTiles";
import { ensureTilemapsBootstrap } from "../lib/tilemaps/bootstrap";
import { DEFAULT_MAP_ID } from "../lib/tilemaps/constants";
import { mapTilesDir } from "../lib/tilemaps/paths";
import { getTilemapManifest } from "../lib/tilemaps/service";

const mapId = process.argv[2] || process.env.TILEMAP_ID || DEFAULT_MAP_ID;

async function backupParentTiles() {
  const tileDir = mapTilesDir(mapId);
  await fs.mkdir(tileDir, { recursive: true });

  const ts = new Date();
  const stamp =
    `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")}` +
    `_${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`;
  const bakBase = path.join(tileDir, ".bak");
  const bakDir = path.join(bakBase, stamp);
  await fs.mkdir(bakDir, { recursive: true });

  const entries = await fs.readdir(tileDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".webp")) continue;
    const match = entry.name.match(/^(\d+)_([0-9]+)_([0-9]+)\.webp$/);
    if (!match) continue;
    const z = Number(match[1]);
    if (z >= ZMAX) continue;

    const src = path.join(tileDir, entry.name);
    const dst = path.join(bakDir, entry.name);
    try {
      await fs.rename(src, dst);
    } catch {
      const buf = await fs.readFile(src);
      await fs.writeFile(dst, buf);
      await fs.unlink(src);
    }
  }
}

async function main() {
  const started = Date.now();
  try {
    await ensureTilemapsBootstrap();
    const manifest = await getTilemapManifest(mapId);
    if (!manifest) {
      throw new Error(`Tilemap "${mapId}" not found`);
    }
    await backupParentTiles();
    await generateAllParentTiles(mapId);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`Parent regeneration complete for "${mapId}" in ${elapsed}s`);
  } catch (err) {
    console.error("Failed to regenerate parent tiles:", err);
    process.exitCode = 1;
  }
}

main();
