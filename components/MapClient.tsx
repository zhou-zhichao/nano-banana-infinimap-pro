"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams as useSearchParamsHook } from "next/navigation";
import dynamic from "next/dynamic";
import TimelineBar from "./TimelineBar";

const TileControls = dynamic(() => import("./TileControls"), { ssr: false });

const MAX_Z = Number(process.env.NEXT_PUBLIC_ZMAX ?? 8);

type TimelineNodeItem = {
  index: number;
  id: string;
  createdAt: string;
};

function parsePositiveInt(input: string | null, fallback: number) {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export default function MapClient() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [map, setMap] = useState<any>(null);
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const [selectedTile, setSelectedTile] = useState<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const selectedTileRef = useRef<typeof selectedTile>(null);
  const hoveredTileRef = useRef<typeof hoveredTile>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const suppressOpenUntil = useRef<number>(0);
  const [tileExists, setTileExists] = useState<Record<string, boolean>>({});
  const tileExistsRef = useRef<Record<string, boolean>>({});
  const searchParams = useSearchParamsHook();
  const updateTimeoutRef = useRef<any>(undefined);

  const [timelineNodes, setTimelineNodes] = useState<TimelineNodeItem[]>([]);
  const [minTimelineNodes, setMinTimelineNodes] = useState(1);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [activeTimelineIndex, setActiveTimelineIndex] = useState(() => parsePositiveInt(searchParams?.get("t") ?? null, 1));
  const activeTimelineRef = useRef(activeTimelineIndex);

  const timelineKey = useCallback((timelineIndex: number, x: number, y: number) => `${timelineIndex}:${x},${y}`, []);

  const withTimelineQuery = useCallback((url: string, timelineIndex = activeTimelineRef.current) => {
    return `${url}${url.includes("?") ? "&" : "?"}t=${timelineIndex}`;
  }, []);

  const writeUrlState = useCallback((m: any | null, timelineIndex = activeTimelineRef.current) => {
    const params = new URLSearchParams(window.location.search);
    if (m) {
      const center = m.getCenter();
      const zoom = m.getZoom();
      params.set("z", String(zoom));
      params.set("lat", center.lat.toFixed(6));
      params.set("lng", center.lng.toFixed(6));
    }
    params.set("t", String(timelineIndex));
    const newURL = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, "", newURL);
  }, []);

  useEffect(() => {
    selectedTileRef.current = selectedTile;
  }, [selectedTile]);

  useEffect(() => {
    hoveredTileRef.current = hoveredTile;
  }, [hoveredTile]);

  useEffect(() => {
    tileExistsRef.current = tileExists;
  }, [tileExists]);

  useEffect(() => {
    activeTimelineRef.current = activeTimelineIndex;
  }, [activeTimelineIndex]);

  useEffect(() => {
    mapRef.current = map;
  }, [map]);

  const applyTimelineSelection = useCallback((nextTimelineIndex: number) => {
    activeTimelineRef.current = nextTimelineIndex;
    setActiveTimelineIndex(nextTimelineIndex);
    setTileExists({});
    tileExistsRef.current = {};
    setHoveredTile(null);
    hoveredTileRef.current = null;
    setSelectedTile(null);
    selectedTileRef.current = null;
    writeUrlState(mapRef.current, nextTimelineIndex);
  }, [writeUrlState]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!selectedTileRef.current) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (
          target.closest("[data-dialog-root]") ||
          target.closest("[data-radix-popper-content-wrapper]") ||
          target.closest("[role='dialog']")
        )
      ) return;
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setSelectedTile(null);
      selectedTileRef.current = null;
      suppressOpenUntil.current = performance.now() + 250;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const updateURL = useCallback((m: any, timelineIndex = activeTimelineRef.current) => {
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }
    updateTimeoutRef.current = window.setTimeout(() => {
      writeUrlState(m, timelineIndex);
    }, 300);
  }, [writeUrlState]);

  const checkTileExists = useCallback(async (x: number, y: number, timelineIndex = activeTimelineRef.current) => {
    try {
      const response = await fetch(withTimelineQuery(`/api/meta/${MAX_Z}/${x}/${y}`, timelineIndex));
      const data = await response.json();
      const exists = data.status === "READY";
      if (activeTimelineRef.current === timelineIndex) {
        setTileExists((prev) => ({ ...prev, [timelineKey(timelineIndex, x, y)]: exists }));
      }
      return exists;
    } catch {
      return false;
    }
  }, [timelineKey, withTimelineQuery]);

  const refreshVisibleTiles = useCallback(async (timelineIndex = activeTimelineRef.current) => {
    if (!map) return;
    const tileLayer = (map as any)?._tileLayer;
    const ts = Date.now();
    const template = withTimelineQuery(`/api/tiles/{z}/{x}/{y}?v=${ts}`, timelineIndex);
    if (tileLayer?.setUrl) {
      tileLayer.setUrl(template);
    } else if (tileLayer) {
      const L = await import("leaflet");
      (map as any).removeLayer(tileLayer);
      const newTileLayer = L.tileLayer(template, {
        tileSize: 256,
        minZoom: 0,
        maxZoom: MAX_Z,
        noWrap: true,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 0,
      });
      newTileLayer.addTo(map as any);
      (map as any)._tileLayer = newTileLayer;
    }
  }, [map, withTimelineQuery]);

  const pollTileStatus = useCallback((x: number, y: number, m: any, timelineIndex: number) => {
    let attempts = 0;
    const maxAttempts = 30;

    const checkStatus = async () => {
      try {
        const response = await fetch(withTimelineQuery(`/api/meta/${MAX_Z}/${x}/${y}`, timelineIndex));
        const data = await response.json();

        if (data.status === "READY") {
          if (activeTimelineRef.current === timelineIndex) {
            await refreshVisibleTiles(timelineIndex);
            setTileExists((prev) => ({ ...prev, [timelineKey(timelineIndex, x, y)]: true }));
          }
          return;
        }

        if (data.status === "PENDING" && attempts < maxAttempts) {
          attempts += 1;
          setTimeout(checkStatus, 1000);
        }
      } catch (error) {
        console.error("Error checking tile status:", error);
      }
    };

    if (m) {
      setTimeout(checkStatus, 1000);
    }
  }, [refreshVisibleTiles, timelineKey, withTimelineQuery]);

  const handleGenerate = useCallback(async (x: number, y: number, prompt: string) => {
    const timelineIndex = activeTimelineRef.current;
    try {
      const response = await fetch(withTimelineQuery(`/api/claim/${MAX_Z}/${x}/${y}`, timelineIndex), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (response.ok) {
        if (map) {
          pollTileStatus(x, y, map, timelineIndex);
        }
      }
    } catch (error) {
      console.error("Failed to generate tile:", error);
      throw error;
    }
  }, [map, pollTileStatus, withTimelineQuery]);

  const handleRegenerate = useCallback(async (x: number, y: number, prompt: string) => {
    const timelineIndex = activeTimelineRef.current;
    try {
      const response = await fetch(withTimelineQuery(`/api/invalidate/${MAX_Z}/${x}/${y}`, timelineIndex), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (response.ok && map) {
        pollTileStatus(x, y, map, timelineIndex);
      }
    } catch (error) {
      console.error("Failed to regenerate tile:", error);
      throw error;
    }
  }, [map, pollTileStatus, withTimelineQuery]);

  const handleDelete = useCallback(async (x: number, y: number) => {
    const timelineIndex = activeTimelineRef.current;
    try {
      const response = await fetch(withTimelineQuery(`/api/delete/${MAX_Z}/${x}/${y}`, timelineIndex), {
        method: "DELETE",
      });

      if (response.ok) {
        await refreshVisibleTiles(timelineIndex);
        setTileExists((prev) => ({ ...prev, [timelineKey(timelineIndex, x, y)]: false }));
      }
    } catch (error) {
      console.error("Failed to delete tile:", error);
      throw error;
    }
  }, [refreshVisibleTiles, timelineKey, withTimelineQuery]);

  const reloadTimeline = useCallback(async (fallbackIndex = activeTimelineRef.current) => {
    const response = await fetch("/api/timeline");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load timeline");
    }

    const nodes = Array.isArray(data.nodes) ? data.nodes as TimelineNodeItem[] : [];
    const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
    setTimelineNodes(nodes);
    setMinTimelineNodes(minNodes);

    const maxIndex = Math.max(1, nodes.length);
    const clamped = Math.min(Math.max(fallbackIndex, 1), maxIndex);
    return { nodes, minNodes, clamped };
  }, []);

  const handleAddTimelineNode = useCallback(async () => {
    const afterIndex = activeTimelineRef.current;
    setTimelineLoading(true);
    try {
      const response = await fetch("/api/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ afterIndex }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to add node");
      }

      const nodes = Array.isArray(data.nodes) ? data.nodes as TimelineNodeItem[] : [];
      const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
      setTimelineNodes(nodes);
      setMinTimelineNodes(minNodes);
      const nextIndex = parsePositiveInt(String(data.insertedIndex ?? afterIndex + 1), afterIndex + 1);
      const clamped = Math.min(nextIndex, Math.max(1, nodes.length));
      applyTimelineSelection(clamped);
      await refreshVisibleTiles(clamped);
    } catch (error) {
      console.error(error);
    } finally {
      setTimelineLoading(false);
    }
  }, [applyTimelineSelection, refreshVisibleTiles]);

  const handleDeleteTimelineNode = useCallback(async () => {
    const index = activeTimelineRef.current;
    setTimelineLoading(true);
    try {
      const response = await fetch("/api/timeline", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete node");
      }

      const nodes = Array.isArray(data.nodes) ? data.nodes as TimelineNodeItem[] : [];
      const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
      setTimelineNodes(nodes);
      setMinTimelineNodes(minNodes);
      const fallback = parsePositiveInt(String(data.activeIndex ?? index), Math.max(1, Math.min(index, nodes.length)));
      const nextIndex = Math.min(fallback, Math.max(1, nodes.length));
      applyTimelineSelection(nextIndex);
      await refreshVisibleTiles(nextIndex);
    } catch (error) {
      console.error(error);
    } finally {
      setTimelineLoading(false);
    }
  }, [applyTimelineSelection, refreshVisibleTiles]);

  useEffect(() => {
    let cancelled = false;
    setTimelineLoading(true);
    reloadTimeline(activeTimelineRef.current)
      .then(({ clamped }) => {
        if (cancelled) return;
        applyTimelineSelection(clamped);
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => { cancelled = true; };
  }, [applyTimelineSelection, reloadTimeline]);

  useEffect(() => {
    if (map) {
      void refreshVisibleTiles(activeTimelineRef.current);
      updateURL(map, activeTimelineRef.current);
    }
  }, [map, refreshVisibleTiles, updateURL]);

  useEffect(() => {
    if (!ref.current || map) return;

    import("leaflet").then((L) => {
      const initialZoom = searchParams?.get("z") ? parseInt(searchParams.get("z")!, 10) : 2;
      const initialLat = searchParams?.get("lat") ? parseFloat(searchParams.get("lat")!) : null;
      const initialLng = searchParams?.get("lng") ? parseFloat(searchParams.get("lng")!) : null;

      const m = L.map(ref.current!, {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: MAX_Z,
        zoom: initialZoom,
      });

      const world = (1 << MAX_Z) * 256;
      const sw = m.unproject([0, world] as any, MAX_Z);
      const ne = m.unproject([world, 0] as any, MAX_Z);
      const bounds = new L.LatLngBounds(sw, ne);
      m.setMaxBounds(bounds);

      if (initialLat !== null && initialLng !== null) {
        m.setView([initialLat, initialLng], initialZoom);
      } else {
        m.fitBounds(bounds);
      }

      const template = withTimelineQuery(`/api/tiles/{z}/{x}/{y}?v=${Date.now()}`, activeTimelineRef.current);
      const tileLayer = L.tileLayer(template, {
        tileSize: 256,
        minZoom: 0,
        maxZoom: MAX_Z,
        noWrap: true,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 0,
      });
      tileLayer.addTo(m);
      (m as any)._tileLayer = tileLayer;

      m.on("moveend", () => updateURL(m));
      m.on("zoomend", () => updateURL(m));

      const updateSelectedPosition = () => {
        const current = selectedTileRef.current;
        if (!current) return;
        const tileCenterWorld = L.point((current.x + 0.5) * 256, (current.y + 0.5) * 256);
        const tileCenterLatLng = m.unproject(tileCenterWorld, m.getZoom());
        const tileCenterScreen = m.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile((prev) => prev ? ({ ...prev, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y }) : prev);
      };
      m.on("move", updateSelectedPosition);
      m.on("zoomend", updateSelectedPosition);

      m.on("mousemove", async (e: any) => {
        if (m.getZoom() !== m.getMaxZoom()) {
          setHoveredTile(null);
          m.getContainer().style.cursor = "";
          return;
        }

        const p = m.project(e.latlng, m.getZoom());
        const x = Math.floor(p.x / 256);
        const y = Math.floor(p.y / 256);
        const currentHover = hoveredTileRef.current;
        if (!currentHover || currentHover.x !== x || currentHover.y !== y) {
          const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
          const tileCenterLatLng = m.unproject(tileCenterWorld, m.getZoom());
          const tileCenterScreen = m.latLngToContainerPoint(tileCenterLatLng);

          setHoveredTile({
            x,
            y,
            screenX: tileCenterScreen.x,
            screenY: tileCenterScreen.y,
          });
          m.getContainer().style.cursor = "pointer";

          const timelineIndex = activeTimelineRef.current;
          const key = timelineKey(timelineIndex, x, y);
          if (!(key in tileExistsRef.current)) {
            void checkTileExists(x, y, timelineIndex);
          }
        }
      });

      m.on("mouseleave", () => {
        setHoveredTile(null);
        m.getContainer().style.cursor = "";
      });

      m.on("zoomstart", () => {
        setHoveredTile(null);
        setSelectedTile(null);
      });

      m.on("click", (e: any) => {
        if (m.getZoom() !== m.getMaxZoom()) {
          return;
        }
        if (selectedTileRef.current) {
          setSelectedTile(null);
          selectedTileRef.current = null;
          const pNow = m.project(e.latlng, m.getZoom());
          const hx = Math.floor(pNow.x / 256);
          const hy = Math.floor(pNow.y / 256);
          const centerWorld = L.point((hx + 0.5) * 256, (hy + 0.5) * 256);
          const centerLatLng = m.unproject(centerWorld, m.getZoom());
          const centerScreen = m.latLngToContainerPoint(centerLatLng);
          setHoveredTile({ x: hx, y: hy, screenX: centerScreen.x, screenY: centerScreen.y });
          return;
        }
        if (performance.now() < suppressOpenUntil.current) {
          return;
        }
        const p = m.project(e.latlng, m.getZoom());
        const x = Math.floor(p.x / 256);
        const y = Math.floor(p.y / 256);
        const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
        const tileCenterLatLng = m.unproject(tileCenterWorld, m.getZoom());
        const tileCenterScreen = m.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile({ x, y, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y });

        const timelineIndex = activeTimelineRef.current;
        const key = timelineKey(timelineIndex, x, y);
        if (!(key in tileExistsRef.current)) {
          void checkTileExists(x, y, timelineIndex);
        }
      });

      setMap(m);
      writeUrlState(m, activeTimelineRef.current);
    });
  }, [checkTileExists, map, searchParams, timelineKey, updateURL, withTimelineQuery, writeUrlState]);

  return (
    <div className="w-full h-full relative">
      <div className="p-3 z-10 absolute top-2 left-2 bg-white/90 rounded-xl shadow-lg flex flex-col gap-2">
        <div className="text-sm text-gray-600">
          {map && map.getZoom() === MAX_Z
            ? "Hover to highlight, click to open menu"
            : "Zoom to max level to interact with tiles"}
        </div>
        <div className="text-xs text-gray-400">
          Timeline: {activeTimelineIndex}
        </div>
        {searchParams.get("z") && (
          <div className="text-xs text-gray-400">
            Position: z={searchParams.get("z")}, lat={searchParams.get("lat")}, lng={searchParams.get("lng")}
          </div>
        )}
      </div>

      {hoveredTile && !selectedTile && map && map.getZoom() === MAX_Z && (
        <div
          className="absolute"
          style={{
            left: hoveredTile.screenX - 128,
            top: hoveredTile.screenY - 128,
            width: 256,
            height: 256,
            background: "rgba(255,255,255,0.1)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        />
      )}

      {selectedTile && map && map.getZoom() === MAX_Z && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selectedTile.screenX,
            top: selectedTile.screenY,
            transform: "translate(-50%, -50%)",
            zIndex: 500,
          }}
        >
          <div
            ref={menuRef}
            className="pointer-events-auto bg-white rounded-lg shadow-xl p-2 border border-gray-200"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs text-gray-500 mb-1">
              Tile ({selectedTile.x}, {selectedTile.y})
            </div>
            <TileControls
              x={selectedTile.x}
              y={selectedTile.y}
              z={MAX_Z}
              timelineIndex={activeTimelineIndex}
              exists={tileExists[timelineKey(activeTimelineIndex, selectedTile.x, selectedTile.y)] || false}
              onGenerate={(prompt) => handleGenerate(selectedTile.x, selectedTile.y, prompt)}
              onRegenerate={(prompt) => handleRegenerate(selectedTile.x, selectedTile.y, prompt)}
              onDelete={() => handleDelete(selectedTile.x, selectedTile.y)}
              onRefreshTiles={() => {
                const timelineIndex = activeTimelineRef.current;
                setTimeout(() => {
                  void refreshVisibleTiles(timelineIndex);
                  setTileExists((prev) => ({
                    ...prev,
                    [timelineKey(timelineIndex, selectedTile.x, selectedTile.y)]: true,
                  }));
                }, 50);
              }}
            />
          </div>
        </div>
      )}

      {timelineNodes.length > 0 && (
        <TimelineBar
          nodes={timelineNodes}
          activeIndex={activeTimelineIndex}
          minNodes={minTimelineNodes}
          loading={timelineLoading}
          onSelect={(idx) => {
            if (idx === activeTimelineRef.current) return;
            applyTimelineSelection(idx);
            void refreshVisibleTiles(idx);
          }}
          onAddAfterActive={() => { void handleAddTimelineNode(); }}
          onDeleteActive={() => { void handleDeleteTimelineNode(); }}
        />
      )}

      <div ref={ref} className="w-full h-full" />
    </div>
  );
}
