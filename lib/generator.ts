import sharp from "sharp";
import { TILE, ZMAX } from "./coords";
import { writeTileFile, readTileFile } from "./storage";
import { db } from "./adapters/db.file";
import { blake2sHex, hashTilePayload } from "./hashing";
import { loadStyleControl } from "./style";
import { generateGridImage } from "./pythonImageService";

type NeighborDir = "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW";

const dirs: [NeighborDir, number, number][] = [
  ["N", 0, -1],
  ["S", 0, 1],
  ["E", 1, 0],
  ["W", -1, 0],
  ["NE", 1, -1],
  ["NW", -1, -1],
  ["SE", 1, 1],
  ["SW", -1, 1],
];

const GRID_SIZE = TILE * 3;
const CHECKER_SIZE = 16;
const DEBUG_MODE = process.env.DEBUG_GENERATION === "1";
const ALLOW_STUB_FALLBACK = process.env.ALLOW_STUB_FALLBACK === "1";
const CHECKER_LIGHT = { r: 200, g: 200, b: 200 };
const CHECKER_WHITE = { r: 255, g: 255, b: 255 };

const neighborPositions: Record<NeighborDir, { x: number; y: number }> = {
  NW: { x: 0, y: 0 },
  N: { x: TILE, y: 0 },
  NE: { x: TILE * 2, y: 0 },
  W: { x: 0, y: TILE },
  E: { x: TILE * 2, y: TILE },
  SW: { x: 0, y: TILE * 2 },
  S: { x: TILE, y: TILE * 2 },
  SE: { x: TILE * 2, y: TILE * 2 },
};

type ModelInput = {
  prompt: string;
  styleName: string;
  neighbors: { dir: NeighborDir; buf: Buffer | null }[];
  seedHex: string;
};

async function getNeighbors(z: number, x: number, y: number) {
  const out: { dir: NeighborDir; buf: Buffer | null }[] = [];
  for (const [dir, dx, dy] of dirs) {
    out.push({ dir, buf: await readTileFile(z, x + dx, y + dy) });
  }
  return out;
}

async function buildGridContextImage(neighbors: { dir: NeighborDir; buf: Buffer | null }[]): Promise<Buffer> {
  const checkerboardSvg = `
    <svg width="${GRID_SIZE}" height="${GRID_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="checkerboard" x="0" y="0" width="${CHECKER_SIZE * 2}" height="${CHECKER_SIZE * 2}" patternUnits="userSpaceOnUse">
          <rect x="0" y="0" width="${CHECKER_SIZE}" height="${CHECKER_SIZE}" fill="rgb(${CHECKER_WHITE.r},${CHECKER_WHITE.g},${CHECKER_WHITE.b})" />
          <rect x="${CHECKER_SIZE}" y="0" width="${CHECKER_SIZE}" height="${CHECKER_SIZE}" fill="rgb(${CHECKER_LIGHT.r},${CHECKER_LIGHT.g},${CHECKER_LIGHT.b})" />
          <rect x="0" y="${CHECKER_SIZE}" width="${CHECKER_SIZE}" height="${CHECKER_SIZE}" fill="rgb(${CHECKER_LIGHT.r},${CHECKER_LIGHT.g},${CHECKER_LIGHT.b})" />
          <rect x="${CHECKER_SIZE}" y="${CHECKER_SIZE}" width="${CHECKER_SIZE}" height="${CHECKER_SIZE}" fill="rgb(${CHECKER_WHITE.r},${CHECKER_WHITE.g},${CHECKER_WHITE.b})" />
        </pattern>
      </defs>
      <rect width="${GRID_SIZE}" height="${GRID_SIZE}" fill="url(#checkerboard)" />
    </svg>
  `;

  const overlays: sharp.OverlayOptions[] = [];
  for (const neighbor of neighbors) {
    if (!neighbor.buf) continue;
    const pos = neighborPositions[neighbor.dir];
    const resized = await sharp(neighbor.buf).resize(TILE, TILE, { fit: "fill" }).toBuffer();
    overlays.push({ input: resized, left: pos.x, top: pos.y });
  }

  return sharp(Buffer.from(checkerboardSvg)).composite(overlays).png().toBuffer();
}

async function writeDebugImage(path: string, image: Buffer) {
  if (!DEBUG_MODE) return;
  await sharp(image).toFile(path);
  console.log(`  Saved debug image: ${path}`);
}

/** Generate tile using Python FastAPI + Vertex model */
async function runModel(input: ModelInput): Promise<Buffer> {
  console.log("Starting tile generation via Python service");
  console.log("  Prompt:", input.prompt);
  console.log("  Style:", input.styleName);
  console.log("  Seed:", input.seedHex);

  try {
    const gridImage = await buildGridContextImage(input.neighbors);
    await writeDebugImage(`.debug/debug-grid-${input.seedHex}.png`, gridImage);

    const generated = await generateGridImage({
      prompt: input.prompt,
      styleName: input.styleName,
      gridPng: gridImage,
    });
    console.log(`  Python service model: ${generated.model}`);
    console.log(`  Python service latency: ${generated.latencyMs}ms`);
    console.log(`  Python service mime type: ${generated.mimeType}`);

    let imageBuffer = generated.imageBuffer;
    const metadata = await sharp(imageBuffer).metadata();
    console.log(`  Returned image dimensions: ${metadata.width}x${metadata.height}`);

    if (metadata.width !== GRID_SIZE || metadata.height !== GRID_SIZE) {
      console.log(`  Warning: expected ${GRID_SIZE}x${GRID_SIZE}; resizing model output`);
      imageBuffer = await sharp(imageBuffer).resize(GRID_SIZE, GRID_SIZE, { fit: "fill" }).toBuffer();
    }
    await writeDebugImage(`.debug/debug-response-${input.seedHex}.png`, imageBuffer);

    const centerTile = await sharp(imageBuffer)
      .extract({ left: TILE, top: TILE, width: TILE, height: TILE })
      .resize(TILE, TILE, { kernel: "lanczos3" })
      .webp({ quality: 90 })
      .toBuffer();

    console.log(`  Extracted center tile: ${centerTile.length} bytes`);
    return centerTile;
  } catch (error) {
    console.error("Python service generation error:", error);
    if (ALLOW_STUB_FALLBACK) {
      console.log("  Falling back to stub generator");
      return runModelStub(input);
    }
    throw error;
  }
}

/** Stub generator for fallback */
async function runModelStub(input: ModelInput): Promise<Buffer> {
  const base = sharp({
    create: {
      width: TILE,
      height: TILE,
      channels: 3,
      background: {
        r: parseInt(input.seedHex.slice(0, 2), 16),
        g: parseInt(input.seedHex.slice(2, 4), 16),
        b: (input.prompt.length * 19) % 255,
      },
    },
  }).png();

  let img = await base.toBuffer();

  const overlays: Buffer[] = [];
  for (const n of input.neighbors) {
    if (!n.buf) continue;
    const line = Buffer.from(
      `<svg width="${TILE}" height="${TILE}"><rect ${edgeRect(n.dir)} fill="#ffffff" fill-opacity="0.15"/></svg>`,
    );
    overlays.push(await sharp(line).png().toBuffer());
  }

  if (overlays.length) {
    img = await sharp(img).composite(overlays.map((o) => ({ input: o }))).toBuffer();
  }
  return sharp(img).webp({ quality: 90 }).toBuffer();
}

function edgeRect(dir: NeighborDir): string {
  if (dir === "N") return `x="0" y="0" width="${TILE}" height="1"`;
  if (dir === "S") return `x="0" y="${TILE - 1}" width="${TILE}" height="1"`;
  if (dir === "W") return `x="0" y="0" width="1" height="${TILE}"`;
  if (dir === "E") return `x="${TILE - 1}" y="0" width="1" height="${TILE}"`;
  if (dir === "NE") return `x="${TILE - 1}" y="0" width="1" height="1"`;
  if (dir === "NW") return `x="0" y="0" width="1" height="1"`;
  if (dir === "SE") return `x="${TILE - 1}" y="${TILE - 1}" width="1" height="1"`;
  return `x="0" y="${TILE - 1}" width="1" height="1"`;
}

/** Generate a tile preview without saving to disk */
export async function generateTilePreview(z: number, x: number, y: number, prompt: string): Promise<Buffer> {
  console.log(`\ngenerateTilePreview called for z:${z} x:${x} y:${y}`);
  console.log(`  User prompt: "${prompt}"`);

  if (z !== ZMAX) throw new Error("Generation only at max zoom");

  const { name: styleName } = await loadStyleControl();
  const seedHex = blake2sHex(Buffer.from(`${z}:${x}:${y}:${styleName}:${prompt}`)).slice(0, 8);

  const neighbors = await getNeighbors(z, x, y);
  const buf = await runModel({ prompt, styleName, neighbors, seedHex });

  console.log(`  Tile preview generated for z:${z} x:${x} y:${y}\n`);
  return buf;
}

/**
 * Generate a full 3x3 grid preview image (768x768 WebP) containing
 * the model's predicted content for the neighborhood.
 */
export async function generateGridPreview(z: number, x: number, y: number, prompt: string): Promise<Buffer> {
  if (z !== ZMAX) throw new Error("Generation only at max zoom");

  const { name: styleName } = await loadStyleControl();
  const seedHex = blake2sHex(Buffer.from(`${z}:${x}:${y}:${styleName}:${prompt}`)).slice(0, 8);
  const neighbors = await getNeighbors(z, x, y);

  try {
    const gridContext = await buildGridContextImage(neighbors);
    await writeDebugImage(`.debug/debug-grid-preview-${seedHex}.png`, gridContext);

    const generated = await generateGridImage({
      prompt,
      styleName,
      gridPng: gridContext,
    });
    let imageBuffer = generated.imageBuffer;
    const metadata = await sharp(imageBuffer).metadata();
    if (metadata.width !== GRID_SIZE || metadata.height !== GRID_SIZE) {
      imageBuffer = await sharp(imageBuffer).resize(GRID_SIZE, GRID_SIZE, { fit: "fill" }).toBuffer();
    }
    await writeDebugImage(`.debug/debug-grid-preview-response-${seedHex}.png`, imageBuffer);
    return sharp(imageBuffer).webp({ quality: 90 }).toBuffer();
  } catch (err) {
    if (!ALLOW_STUB_FALLBACK) {
      throw err;
    }

    const center = await runModelStub({ prompt, styleName, neighbors, seedHex });

    const composites: sharp.OverlayOptions[] = [];
    const pos = [
      [0, 0, "NW"],
      [1, 0, "N"],
      [2, 0, "NE"],
      [0, 1, "W"],
      [1, 1, "C"],
      [2, 1, "E"],
      [0, 2, "SW"],
      [1, 2, "S"],
      [2, 2, "SE"],
    ] as const;

    for (const [cx, cy, key] of pos) {
      if (key === "C") {
        composites.push({ input: center, left: cx * TILE, top: cy * TILE });
        continue;
      }
      const n = neighbors.find((nn) => nn.dir === key);
      if (n?.buf) {
        const resized = await sharp(n.buf).resize(TILE, TILE).toBuffer();
        composites.push({ input: resized, left: cx * TILE, top: cy * TILE });
      }
    }

    return sharp({
      create: {
        width: TILE * 3,
        height: TILE * 3,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .webp({ quality: 90 })
      .toBuffer();
  }
}

export async function generateTile(z: number, x: number, y: number, prompt: string) {
  console.log(`\ngenerateTile called for z:${z} x:${x} y:${y}`);
  console.log(`  User prompt: "${prompt}"`);

  if (z !== ZMAX) throw new Error("Generation only at max zoom");

  const rec = await db.upsertTile({ z, x, y, status: "PENDING" });
  console.log("  Tile marked as PENDING");

  const { name: styleName } = await loadStyleControl();
  const seedHex = blake2sHex(Buffer.from(`${z}:${x}:${y}:${styleName}:${prompt}`)).slice(0, 8);

  const neighbors = await getNeighbors(z, x, y);
  const buf = await runModel({ prompt, styleName, neighbors, seedHex });

  const bytesHash = blake2sHex(buf).slice(0, 16);
  const contentVer = (rec.contentVer ?? 0) + 1;
  const hash = hashTilePayload({
    algorithmVersion: 1,
    contentVer,
    bytesHash,
    seed: seedHex,
  });

  await writeTileFile(z, x, y, buf);
  console.log("  Tile file written to disk");

  const updated = await db.updateTile(z, x, y, {
    status: "READY",
    hash,
    contentVer,
    seed: seedHex,
  });
  console.log(`  Tile marked as READY with hash: ${updated.hash}`);
  console.log(`  Tile generation complete for z:${z} x:${x} y:${y}\n`);

  generateParentTilesForChild(z, x, y).catch((err) => console.error(`Failed to generate parent tiles: ${err}`));

  return { hash: updated.hash!, contentVer: updated.contentVer! };
}

async function generateParentTilesForChild(z: number, x: number, y: number) {
  const { generateParentTile } = await import("./parentTiles");
  const { parentOf } = await import("./coords");

  console.log(`  Generating parent tiles for z:${z} x:${x} y:${y}`);

  let currentZ = z;
  let currentX = x;
  let currentY = y;

  while (currentZ > 0) {
    const parent = parentOf(currentZ, currentX, currentY);
    await generateParentTile(parent.z, parent.x, parent.y);

    currentZ = parent.z;
    currentX = parent.x;
    currentY = parent.y;
  }
}
