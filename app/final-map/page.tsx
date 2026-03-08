import { Suspense } from "react";
import { notFound } from "next/navigation";
import MapClient from "@/components/MapClient";
import { getTilemapManifest } from "@/lib/tilemaps/service";

const FINAL_MAP_ID = "final-map";

export default async function FinalMapPage() {
  const map = await getTilemapManifest(FINAL_MAP_ID);
  if (!map) notFound();

  return (
    <main className="final-map-route w-screen h-screen overflow-hidden">
      <Suspense fallback={<div>Loading final map...</div>}>
        <MapClient mapId={map.id} mapWidth={map.width} mapHeight={map.height} mode="final" />
      </Suspense>
    </main>
  );
}
