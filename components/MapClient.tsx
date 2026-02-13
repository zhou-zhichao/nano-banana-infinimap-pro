"use client";

import "leaflet/dist/leaflet.css";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const TileControls = dynamic(() => import("./TileControls"), { ssr: false });
const MAX_Z = Number(process.env.NEXT_PUBLIC_ZMAX ?? 8);
const DEFAULT_INITIAL_ZOOM = 2;

type Props = {
  mapId: string;
  mapWidth: number;
  mapHeight: number;
};

type TilePoint = { x: number; y: number; screenX: number; screenY: number };

function withMapId(path: string, mapId: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}mapId=${encodeURIComponent(mapId)}`;
}

function parseInitialView() {
  const params = new URLSearchParams(window.location.search);
  const parsedZoom = Number(params.get("z"));
  const zoom = Number.isFinite(parsedZoom)
    ? Math.max(0, Math.min(MAX_Z, Math.round(parsedZoom)))
    : DEFAULT_INITIAL_ZOOM;

  const parsedLat = Number(params.get("lat"));
  const parsedLng = Number(params.get("lng"));
  const hasCenter = Number.isFinite(parsedLat) && Number.isFinite(parsedLng);

  return {
    zoom,
    lat: hasCenter ? parsedLat : null,
    lng: hasCenter ? parsedLng : null,
    hasZoomParam: params.has("z"),
  };
}

export default function MapClient({ mapId, mapWidth, mapHeight }: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);
  const mapSessionRef = useRef(0);
  const [hoveredTile, setHoveredTile] = useState<TilePoint | null>(null);
  const hoveredTileRef = useRef<TilePoint | null>(null);
  const [selectedTile, setSelectedTile] = useState<TilePoint | null>(null);
  const selectedTileRef = useRef<TilePoint | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const suppressOpenUntil = useRef<number>(0);
  const [tileExists, setTileExists] = useState<Record<string, boolean>>({});
  const tileExistsRef = useRef<Record<string, boolean>>({});
  const updateTimeoutRef = useRef<any>(undefined);

  useEffect(() => {
    selectedTileRef.current = selectedTile;
  }, [selectedTile]);

  useEffect(() => {
    hoveredTileRef.current = hoveredTile;
  }, [hoveredTile]);

  useEffect(() => {
    tileExistsRef.current = tileExists;
  }, [tileExists]);

  const isMaxZoomTileInBounds = useCallback(
    (x: number, y: number) => x >= 0 && y >= 0 && x < mapWidth && y < mapHeight,
    [mapHeight, mapWidth],
  );

  const updateURL = useCallback(
    (mapInstance: any, sessionId: number) => {
      if (sessionId !== mapSessionRef.current || typeof window === "undefined") {
        return;
      }
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
      updateTimeoutRef.current = window.setTimeout(() => {
        if (sessionId !== mapSessionRef.current || mapRef.current !== mapInstance) return;
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        const params = new URLSearchParams(window.location.search);
        params.set("mapId", mapId);
        params.set("z", String(zoom));
        params.set("lat", center.lat.toFixed(6));
        params.set("lng", center.lng.toFixed(6));
        window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
      }, 250);
    },
    [mapId],
  );

  const checkTileExists = useCallback(
    async (x: number, y: number) => {
      if (!isMaxZoomTileInBounds(x, y)) return false;
      try {
        const response = await fetch(withMapId(`/api/meta/${MAX_Z}/${x}/${y}`, mapId));
        const data = await response.json();
        const exists = data.status === "READY";
        setTileExists((prev) => ({ ...prev, [`${x},${y}`]: exists }));
        return exists;
      } catch {
        return false;
      }
    },
    [isMaxZoomTileInBounds, mapId],
  );

  const refreshVisibleTiles = useCallback(async () => {
    if (!mapRef.current) return;
    const sessionId = mapSessionRef.current;
    const tileLayer = tileLayerRef.current;
    const ts = Date.now();
    const nextUrl = withMapId(`/api/tiles/{z}/{x}/{y}?v=${ts}`, mapId);

    if (sessionId !== mapSessionRef.current) return;
    tileLayer?.setUrl?.(nextUrl);
  }, [mapId]);

  const pollTileStatus = useCallback(
    async (x: number, y: number, sessionId: number) => {
      let attempts = 0;
      const maxAttempts = 30;
      while (attempts < maxAttempts) {
        if (sessionId !== mapSessionRef.current || !mapRef.current) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (sessionId !== mapSessionRef.current || !mapRef.current) return;
        const response = await fetch(withMapId(`/api/meta/${MAX_Z}/${x}/${y}`, mapId)).catch(() => null);
        if (!response) {
          attempts += 1;
          continue;
        }
        const data = await response.json().catch(() => null);
        if (data?.status === "READY") {
          if (sessionId !== mapSessionRef.current || !mapRef.current) return;
          const tileLayer = tileLayerRef.current;
          tileLayer?.setUrl?.(withMapId(`/api/tiles/{z}/{x}/{y}?v=${Date.now()}`, mapId));
          return;
        }
        attempts += 1;
      }
    },
    [mapId],
  );

  const handleGenerate = useCallback(
    async (x: number, y: number, prompt: string) => {
      const response = await fetch(withMapId(`/api/claim/${MAX_Z}/${x}/${y}`, mapId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) {
        throw new Error("Failed to generate tile");
      }
      setTileExists((prev) => ({ ...prev, [`${x},${y}`]: true }));
      if (mapRef.current) {
        void pollTileStatus(x, y, mapSessionRef.current);
      }
    },
    [mapId, pollTileStatus],
  );

  const handleRegenerate = useCallback(
    async (x: number, y: number, prompt: string) => {
      const response = await fetch(withMapId(`/api/invalidate/${MAX_Z}/${x}/${y}`, mapId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) {
        throw new Error("Failed to regenerate tile");
      }
      if (mapRef.current) {
        void pollTileStatus(x, y, mapSessionRef.current);
      }
    },
    [mapId, pollTileStatus],
  );

  const handleDelete = useCallback(
    async (x: number, y: number) => {
      const response = await fetch(withMapId(`/api/delete/${MAX_Z}/${x}/${y}`, mapId), { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Failed to delete tile");
      }
      setTileExists((prev) => ({ ...prev, [`${x},${y}`]: false }));
      await refreshVisibleTiles();
    },
    [mapId, refreshVisibleTiles],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!selectedTileRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest("[data-dialog-root]") ||
          target.closest("[data-radix-popper-content-wrapper]") ||
          target.closest('[role="dialog"]'))
      ) {
        return;
      }
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return;
      setSelectedTile(null);
      selectedTileRef.current = null;
      suppressOpenUntil.current = performance.now() + 250;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;

    let cancelled = false;
    const sessionId = mapSessionRef.current + 1;
    mapSessionRef.current = sessionId;

    void import("leaflet").then((L) => {
      if (cancelled || sessionId !== mapSessionRef.current || !mapElementRef.current) return;

      const initialView = parseInitialView();

      const mapInstance: any = L.map(mapElementRef.current, {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: MAX_Z,
        zoom: initialView.zoom,
      });
      mapRef.current = mapInstance;

      const worldWidth = mapWidth * 256;
      const worldHeight = mapHeight * 256;
      const southWest = mapInstance.unproject([0, worldHeight] as any, MAX_Z);
      const northEast = mapInstance.unproject([worldWidth, 0] as any, MAX_Z);
      const bounds = new L.LatLngBounds(southWest, northEast);
      mapInstance.setMaxBounds(bounds);

      if (initialView.lat != null && initialView.lng != null) mapInstance.setView([initialView.lat, initialView.lng], initialView.zoom);
      else mapInstance.fitBounds(bounds);

      const url = withMapId(`/api/tiles/{z}/{x}/{y}?v=${Date.now()}`, mapId);
      const tileLayer = L.tileLayer(url, {
        tileSize: 256,
        minZoom: 0,
        maxZoom: MAX_Z,
        noWrap: true,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 0,
      });
      tileLayer.addTo(mapInstance);
      tileLayerRef.current = tileLayer;

      mapInstance.on("moveend", () => updateURL(mapInstance, sessionId));
      mapInstance.on("zoomend", () => updateURL(mapInstance, sessionId));

      const updateSelectedPosition = () => {
        const current = selectedTileRef.current;
        if (!current) return;
        const tileCenterWorld = L.point((current.x + 0.5) * 256, (current.y + 0.5) * 256);
        const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
        const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile((prev) => (prev ? { ...prev, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y } : prev));
      };
      mapInstance.on("move", updateSelectedPosition);
      mapInstance.on("zoomend", updateSelectedPosition);

      mapInstance.on("mousemove", (event: any) => {
        if (mapInstance.getZoom() !== mapInstance.getMaxZoom()) {
          setHoveredTile(null);
          mapInstance.getContainer().style.cursor = "";
          return;
        }

        const projected = mapInstance.project(event.latlng, mapInstance.getZoom());
        const x = Math.floor(projected.x / 256);
        const y = Math.floor(projected.y / 256);
        if (!isMaxZoomTileInBounds(x, y)) {
          setHoveredTile(null);
          mapInstance.getContainer().style.cursor = "";
          return;
        }

        const currentHovered = hoveredTileRef.current;
        if (!currentHovered || currentHovered.x !== x || currentHovered.y !== y) {
          const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
          const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
          const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
          setHoveredTile({ x, y, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y });
          mapInstance.getContainer().style.cursor = "pointer";
          const key = `${x},${y}`;
          if (!(key in tileExistsRef.current)) void checkTileExists(x, y);
        }
      });

      mapInstance.on("mouseleave", () => {
        setHoveredTile(null);
        mapInstance.getContainer().style.cursor = "";
      });

      mapInstance.on("zoomstart", () => {
        setHoveredTile(null);
        setSelectedTile(null);
      });

      mapInstance.on("click", (event: any) => {
        if (mapInstance.getZoom() !== mapInstance.getMaxZoom()) return;
        if (performance.now() < suppressOpenUntil.current) return;

        const projected = mapInstance.project(event.latlng, mapInstance.getZoom());
        const x = Math.floor(projected.x / 256);
        const y = Math.floor(projected.y / 256);
        if (!isMaxZoomTileInBounds(x, y)) return;

        if (selectedTileRef.current) {
          setSelectedTile(null);
          selectedTileRef.current = null;
          return;
        }

        const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
        const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
        const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile({ x, y, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y });
        const key = `${x},${y}`;
        if (!(key in tileExistsRef.current)) void checkTileExists(x, y);
      });

      if (!initialView.hasZoomParam) updateURL(mapInstance, sessionId);
    });

    return () => {
      cancelled = true;
      mapSessionRef.current += 1;
      if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
      tileLayerRef.current = null;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      hoveredTileRef.current = null;
      selectedTileRef.current = null;
    };
  }, [checkTileExists, isMaxZoomTileInBounds, mapHeight, mapId, mapWidth, updateURL]);

  return (
    <div className="w-full h-full relative">
      <div className="p-3 z-10 absolute top-2 left-2 bg-white/90 rounded-xl shadow-lg flex flex-col gap-2">
        <div className="text-sm text-gray-600">
          {mapRef.current && mapRef.current.getZoom() === MAX_Z ? "Hover to highlight, click to open menu" : "Zoom to max level"}
        </div>
        <div className="text-xs text-gray-400">
          map={mapId} size={mapWidth}x{mapHeight}
        </div>
      </div>

      {hoveredTile && !selectedTile && mapRef.current && mapRef.current.getZoom() === MAX_Z && (
        <div
          className="absolute"
          style={{
            left: hoveredTile.screenX - 128,
            top: hoveredTile.screenY - 128,
            width: 256,
            height: 256,
            background: "rgba(255,255,255,0.12)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        />
      )}

      {selectedTile && mapRef.current && mapRef.current.getZoom() === MAX_Z && (
        <div
          className="absolute pointer-events-none"
          style={{ left: selectedTile.screenX, top: selectedTile.screenY, transform: "translate(-50%, -50%)", zIndex: 500 }}
        >
          <div
            ref={menuRef}
            className="pointer-events-auto bg-white rounded-lg shadow-xl p-2 border border-gray-200"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-xs text-gray-500 mb-1">
              Tile ({selectedTile.x}, {selectedTile.y})
            </div>
            <TileControls
              mapId={mapId}
              x={selectedTile.x}
              y={selectedTile.y}
              z={MAX_Z}
              exists={tileExists[`${selectedTile.x},${selectedTile.y}`] || false}
              onGenerate={(prompt) => handleGenerate(selectedTile.x, selectedTile.y, prompt)}
              onRegenerate={(prompt) => handleRegenerate(selectedTile.x, selectedTile.y, prompt)}
              onDelete={() => handleDelete(selectedTile.x, selectedTile.y)}
              onRefreshTiles={() => {
                setTimeout(() => {
                  void refreshVisibleTiles();
                  setTileExists((prev) => ({ ...prev, [`${selectedTile.x},${selectedTile.y}`]: true }));
                }, 50);
              }}
            />
          </div>
        </div>
      )}

      <div ref={mapElementRef} className="w-full h-full" />
    </div>
  );
}
