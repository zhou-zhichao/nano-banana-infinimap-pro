import { DEFAULT_MAP_ID } from "./tilemaps/constants";

export type ParentRealtimeTrigger = "generation" | "confirm-edit" | "delete";

export function shouldGenerateRealtimeParentTiles(mapId: string, trigger: ParentRealtimeTrigger) {
  // `default` is bootstrapped from the moon preset, so generation keeps using preset parents.
  if (mapId === DEFAULT_MAP_ID) {
    return trigger === "confirm-edit" || trigger === "delete";
  }
  return true;
}
