import fs from "node:fs/promises";
import { QUEUE_DIR } from "../paths";
import { Queue } from "./queue";
import { withFileLock } from "./lock.file";
import { generateTile } from "../generator";

let ensured = false;
async function ensureQueueDir() {
  if (!ensured) {
    await fs.mkdir(QUEUE_DIR, { recursive: true }).catch(() => {});
    ensured = true;
  }
}

const RUNNING = new Set<string>();

export const fileQueue: Queue = {
  async enqueue(_name, payload) {
    await ensureQueueDir();
    // serialize per-tile; run job right away (in-process)
    const timelineKey = payload.timelineNodeId ?? "base";
    const key = `${timelineKey}/${payload.z}/${payload.x}/${payload.y}`;
    if (RUNNING.has(key)) {
      console.log(`Job already running for tile ${key}, skipping`);
      return; // ignore duplicate bursts
    }
    RUNNING.add(key);
    try {
      await withFileLock(`job_${key.replace(/\//g, '_')}`, async () => {
        const res = await generateTile(payload.z, payload.x, payload.y, payload.prompt, {
          modelVariant: payload.modelVariant,
          timelineNodeId: payload.timelineNodeId,
        });
        return res;
      });
    } catch (error) {
      console.error(`Error processing tile ${key}:`, error);
      throw error;
    } finally {
      RUNNING.delete(key);
    }
  }
};
