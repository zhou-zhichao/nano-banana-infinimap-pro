import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { generateGridPreview } from "@/lib/generator";
import { PythonImageServiceError } from "@/lib/pythonImageService";
import { DEFAULT_MODEL_VARIANT, MODEL_VARIANTS } from "@/lib/modelVariant";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";

const requestSchema = z.object({
  prompt: z.string().min(1),
  modelVariant: z.enum(MODEL_VARIANTS).optional(),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  try {
    const params = await context.params;
    const z = parseInt(params.z, 10);
    const x = parseInt(params.x, 10);
    const y = parseInt(params.y, 10);
    const timeline = await resolveTimelineContextFromRequest(req);

    const body = await req.json();
    const { prompt, modelVariant = DEFAULT_MODEL_VARIANT } = requestSchema.parse(body);

    const finalComposite = await generateGridPreview(z, x, y, prompt, {
      modelVariant,
      timelineNodeId: timeline.node.id,
    });

    const tempDir = path.join(process.cwd(), ".temp");
    await fs.mkdir(tempDir, { recursive: true });

    const previewId = `preview-${z}-${x}-${y}-${Date.now()}`;
    const previewPath = path.join(tempDir, `${previewId}.webp`);
    await fs.writeFile(previewPath, finalComposite);

    return NextResponse.json({ previewUrl: `/api/preview/${previewId}`, previewId, timelineIndex: timeline.index });
  } catch (error) {
    console.error("Edit tile error:", error);
    let status = 500;
    const headers: Record<string, string> = {};
    if (error instanceof z.ZodError) {
      status = 400;
    } else if (error instanceof PythonImageServiceError && error.statusCode) {
      status = error.statusCode;
      if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
        headers["Retry-After"] = String(error.retryAfterSeconds);
      }
    } else if (error instanceof Error && /python image service\s+(\d{3})/i.test(error.message)) {
      const match = error.message.match(/python image service\s+(\d{3})/i);
      if (match) status = Number(match[1]);
    }

    const message = error instanceof Error ? error.message : "Failed to edit tile";
    return NextResponse.json(
      { error: message },
      { status, headers },
    );
  }
}

