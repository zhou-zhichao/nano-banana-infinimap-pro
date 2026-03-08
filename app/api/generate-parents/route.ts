import { NextRequest, NextResponse } from "next/server";
import { generateAllParentTilesAtNode } from "@/lib/parentTiles";
import {
  beginParentGeneration,
  completeParentGeneration,
  failParentGeneration,
  getParentGenerationStatus,
  updateParentGenerationProgress,
} from "@/lib/parentGenerationRegistry";
import { MapContextError, resolveMapContext } from "@/lib/tilemaps/context";
import { parseTimelineIndexFromRequest, resolveTimelineContext } from "@/lib/timeline/context";

async function resolveParentGenerationTarget(req: NextRequest) {
  const { mapId } = await resolveMapContext(req);
  const requestedTimelineIndex = parseTimelineIndexFromRequest(req);
  const timeline = await resolveTimelineContext(mapId, requestedTimelineIndex);
  return {
    timeline,
    target: {
      mapId,
      timelineIndex: timeline.index,
      timelineNodeId: timeline.node.id,
    },
  };
}

export async function GET(req: NextRequest) {
  try {
    const { target } = await resolveParentGenerationTarget(req);
    return NextResponse.json({ ok: true, status: getParentGenerationStatus(target), timelineIndex: target.timelineIndex });
  } catch (error) {
    if (error instanceof MapContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error: "Failed to load parent generation status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { timeline, target } = await resolveParentGenerationTarget(req);
    const { started, status } = beginParentGeneration(target);

    if (started) {
      void generateAllParentTilesAtNode(timeline, {
        onProgress: (progress) => {
          updateParentGenerationProgress(target, progress);
        },
      })
        .then(() => {
          completeParentGeneration(target);
        })
        .catch((error) => {
          failParentGeneration(target, error);
          console.error(error);
        });
    }

    return NextResponse.json(
      {
        ok: true,
        alreadyRunning: !started,
        message: started
          ? `Parent tile generation started for "${target.mapId}" (timeline ${target.timelineIndex})`
          : `Parent tile generation already running for "${target.mapId}" (timeline ${target.timelineIndex})`,
        status: started ? getParentGenerationStatus(target) : status,
        timelineIndex: target.timelineIndex,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof MapContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error: "Failed to start parent generation",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
