export type TimelineTileStatus = "EMPTY" | "PENDING" | "READY";

export interface TimelineNode {
  id: string;
  createdAt: string;
}

export interface TimelineManifest {
  version: 1;
  createdAt: string;
  updatedAt: string;
  nodes: TimelineNode[];
}

export interface TimelineTileMeta {
  z: number;
  x: number;
  y: number;
  status: TimelineTileStatus;
  hash?: string;
  seed?: string;
  contentVer?: number;
  tombstone?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TimelineContext {
  requestedIndex: number;
  index: number;
  node: TimelineNode;
  manifest: TimelineManifest;
}

