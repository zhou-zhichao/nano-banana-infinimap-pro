import { NextResponse } from "next/server";
import { generateAllParentTiles } from "@/lib/parentTiles";
import { ensureTilemapsBootstrap } from "@/lib/tilemaps/bootstrap";
import { listTilemaps } from "@/lib/tilemaps/service";

async function regenerateParentsForAllTilemaps(mapIds: string[]) {
  for (const mapId of mapIds) {
    try {
      await generateAllParentTiles(mapId);
    } catch (error) {
      console.error(`Failed to regenerate parents for tilemap "${mapId}"`, error);
    }
  }
}

export async function POST() {
  try {
    await ensureTilemapsBootstrap();
    const tilemaps = await listTilemaps();
    const mapIds = tilemaps.map((item) => item.id);

    void regenerateParentsForAllTilemaps(mapIds);

    return NextResponse.json({
      ok: true,
      count: mapIds.length,
      mapIds,
      message: `Parent regeneration started for ${mapIds.length} tilemap(s)`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start parent regeneration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
