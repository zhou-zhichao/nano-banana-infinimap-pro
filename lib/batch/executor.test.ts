import assert from "node:assert/strict";
import test from "node:test";
import { startBatchRun, type StartBatchRunInput } from "./executor";
import { anchorsOverlap3x3 } from "./plan";
import type { AnchorTask, BatchRunState, TileCoord } from "./types";

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000, pollMs = 10) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(pollMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function testJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createDefaultFetchImpl(): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/batch/lock")) {
      return testJsonResponse({});
    }
    if (url.startsWith("/api/parents/refresh-region")) {
      return testJsonResponse({ parentTiles: [] });
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  };
}

function createBaseInput(overrides: Partial<StartBatchRunInput> = {}): StartBatchRunInput {
  return {
    mapId: "test-map",
    timelineIndex: 1,
    z: 2,
    originX: 20,
    originY: 20,
    mapWidth: 64,
    mapHeight: 64,
    layers: 2,
    prompt: "batch test",
    maxParallel: 4,
    fetchImpl: createDefaultFetchImpl(),
    ...overrides,
  };
}

test("parallel wave never schedules overlapping 3x3 anchors", async () => {
  const handle = startBatchRun(
    createBaseInput({
      executeAnchor: async () => {
        await delay(5);
      },
      refreshParentLevel: async () => ({ parentTiles: [] as TileCoord[] }),
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");

  for (const wave of finalState.waves) {
    const anchors = wave.taskIds.map((id) => finalState.anchors[id]).filter(Boolean);
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        assert.equal(
          anchorsOverlap3x3(anchors[i], anchors[j]),
          false,
          `wave ${wave.waveIndex} has overlapping anchors: ${anchors[i].id} vs ${anchors[j].id}`,
        );
      }
    }
  }
});

test("rolling_fill starts a new anchor after one in-flight task completes", async () => {
  const started: string[] = [];
  const centerGate = createDeferred();
  const firstTwoGates = [createDeferred(), createDeferred()];
  let blockedNonCenter = 0;

  const handle = startBatchRun(
    createBaseInput({
      maxParallel: 2,
      schedulingMode: "rolling_fill",
      executeAnchor: async (anchor: AnchorTask) => {
        started.push(anchor.id);
        if (anchor.id === "u:0,v:0") {
          await centerGate.promise;
          return;
        }
        if (blockedNonCenter < 2) {
          const gate = firstTwoGates[blockedNonCenter];
          blockedNonCenter += 1;
          await gate.promise;
        }
      },
      refreshParentLevel: async () => ({ parentTiles: [] as TileCoord[] }),
    }),
  );

  try {
    await waitForCondition(() => started.includes("u:0,v:0"));
    centerGate.resolve();
    await waitForCondition(() => blockedNonCenter === 2 && started.length >= 3);

    firstTwoGates[0].resolve();
    await waitForCondition(() => started.length >= 4);

    firstTwoGates[1].resolve();
    const finalState = await handle.done;
    assert.equal(finalState.status, "COMPLETED");
  } finally {
    centerGate.resolve();
    firstTwoGates[0].resolve();
    firstTwoGates[1].resolve();
  }
});

test("wave_barrier waits for all anchors in the wave before scheduling next ones", async () => {
  const started: string[] = [];
  const centerGate = createDeferred();
  const firstTwoGates = [createDeferred(), createDeferred()];
  let blockedNonCenter = 0;

  const handle = startBatchRun(
    createBaseInput({
      maxParallel: 2,
      schedulingMode: "wave_barrier",
      executeAnchor: async (anchor: AnchorTask) => {
        started.push(anchor.id);
        if (anchor.id === "u:0,v:0") {
          await centerGate.promise;
          return;
        }
        if (blockedNonCenter < 2) {
          const gate = firstTwoGates[blockedNonCenter];
          blockedNonCenter += 1;
          await gate.promise;
        }
      },
      refreshParentLevel: async () => ({ parentTiles: [] as TileCoord[] }),
    }),
  );

  try {
    await waitForCondition(() => started.includes("u:0,v:0"));
    centerGate.resolve();
    await waitForCondition(() => blockedNonCenter === 2 && started.length >= 3);

    firstTwoGates[0].resolve();
    await delay(180);
    assert.equal(started.length, 3, "wave_barrier should not schedule the next anchor until the full wave is done");

    firstTwoGates[1].resolve();
    await waitForCondition(() => started.length >= 4);

    const finalState = await handle.done;
    assert.equal(finalState.status, "COMPLETED");
  } finally {
    centerGate.resolve();
    firstTwoGates[0].resolve();
    firstTwoGates[1].resolve();
  }
});

test("wave N+1 can start while wave N parent refresh is still running", async () => {
  const handle = startBatchRun(
    createBaseInput({
      maxParallel: 1,
      parentDebounceMs: 0,
      parentWaveBatchSize: 1,
      executeAnchor: async () => {
        await delay(20);
      },
      refreshParentLevel: async () => {
        await delay(180);
        return { parentTiles: [] as TileCoord[] };
      },
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");
  assert.ok(finalState.waves.length >= 2, "need at least two waves");

  const firstJob = finalState.parentJobs[0];
  assert.ok(firstJob?.finishedAt, "first parent job should finish");
  assert.ok(finalState.waves[1].startedAt < (firstJob?.finishedAt ?? 0));
});

test("debounced parent refresh batches multiple waves into fewer jobs", async () => {
  const handle = startBatchRun(
    createBaseInput({
      maxParallel: 1,
      parentDebounceMs: 60_000,
      parentWaveBatchSize: 64,
      parentLeafBatchSize: 10_000,
      executeAnchor: async () => {
        await delay(1);
      },
      refreshParentLevel: async () => ({ parentTiles: [] as TileCoord[] }),
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");
  assert.ok(finalState.waves.length > 1, "need multiple waves to validate batching");
  assert.ok(finalState.parentJobs.length < finalState.waves.length);
});

test("parent cascade depth defers deeper levels to final catch-up", async () => {
  const observedChildZ: number[] = [];
  const handle = startBatchRun(
    createBaseInput({
      z: 6,
      layers: 1,
      maxParallel: 1,
      parentDebounceMs: 0,
      parentWaveBatchSize: 1,
      parentCascadeDepth: 1,
      executeAnchor: async () => {
        await delay(1);
      },
      refreshParentLevel: async (_job, request) => {
        observedChildZ.push(request.childZ);
        return { parentTiles: [{ x: 0, y: 0 }] as TileCoord[] };
      },
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");
  assert.ok(observedChildZ.length > 0);
  assert.equal(observedChildZ.includes(6), true);
  assert.equal(observedChildZ.some((childZ) => childZ < 6), true);
});

test("batch completion waits for parent queue drain after generation is done", async () => {
  const snapshots: BatchRunState[] = [];
  const handle = startBatchRun(
    createBaseInput({
      layers: 1,
      executeAnchor: async () => {
        await delay(5);
      },
      refreshParentLevel: async () => {
        await delay(120);
        return { parentTiles: [] as TileCoord[] };
      },
      onState: (state: BatchRunState) => snapshots.push(state),
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");

  const foundIntermediate = snapshots.some(
    (state) =>
      state.generate.pending === 0 &&
      state.generate.running === 0 &&
      (state.parents.runningJobs > 0 || state.parents.queueLength > 0) &&
      state.status !== "COMPLETED",
  );
  assert.equal(foundIntermediate, true);
});

test("failed anchor blocks downstream dependents", async () => {
  const handle = startBatchRun(
    createBaseInput({
      maxGenerateRetries: 0,
      executeAnchor: async (anchor: AnchorTask) => {
        if (anchor.id === "u:1,v:0") {
          throw new Error("intentional failure");
        }
      },
      refreshParentLevel: async () => ({ parentTiles: [] as TileCoord[] }),
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.anchors["u:1,v:0"]?.status, "FAILED");
  assert.equal(finalState.anchors["u:2,v:0"]?.status, "BLOCKED");
});

test("failed run performs final parent cleanup cascade for touched leaves", async () => {
  const cleanupChildZs: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/batch/lock")) {
      return testJsonResponse({});
    }
    if (url.startsWith("/api/parents/refresh-region")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { childZ?: unknown };
      const childZ = Number(body.childZ);
      cleanupChildZs.push(childZ);
      return testJsonResponse({
        parentTiles: childZ > 1 ? [{ x: 0, y: 0 }] : [],
      });
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  };

  const handle = startBatchRun(
    createBaseInput({
      z: 3,
      layers: 1,
      maxParallel: 1,
      parentCascadeDepth: 1,
      parentDebounceMs: 0,
      parentWaveBatchSize: 1,
      parentJobRetries: 0,
      fetchImpl,
      executeAnchor: async () => {
        await delay(1);
      },
      refreshParentLevel: async () => {
        throw new Error("parent refresh failure");
      },
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "FAILED");
  assert.deepEqual(cleanupChildZs, [3, 2, 1]);
});

test("parent refresh hard failure transitions batch to FAILED after retries", async () => {
  const handle = startBatchRun(
    createBaseInput({
      layers: 1,
      parentJobRetries: 0,
      executeAnchor: async () => {
        await delay(1);
      },
      refreshParentLevel: async () => {
        throw new Error("parent refresh failure");
      },
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "FAILED");
  assert.ok(finalState.parents.failedWaves >= 1);
});

test("parent refresh can recover on retry", async () => {
  let transientFailed = false;
  const handle = startBatchRun(
    createBaseInput({
      layers: 1,
      parentJobRetries: 1,
      executeAnchor: async () => {
        await delay(1);
      },
      refreshParentLevel: async () => {
        if (!transientFailed) {
          transientFailed = true;
          throw new Error("transient parent refresh failure");
        }
        return { parentTiles: [] as TileCoord[] };
      },
    }),
  );
  const finalState = await handle.done;
  assert.equal(finalState.status, "COMPLETED");
  assert.ok(finalState.parentJobs.some((job) => job.attempts >= 2));
});
