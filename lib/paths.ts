import path from "node:path";
export const ROOT = process.cwd();

export const TILEMAPS_ROOT = path.join(ROOT, ".tilemaps");
export const TILEMAPS_MAPS_DIR = path.join(TILEMAPS_ROOT, "maps");
export const TILEMAPS_PRESETS_DIR = path.join(TILEMAPS_ROOT, "presets");
