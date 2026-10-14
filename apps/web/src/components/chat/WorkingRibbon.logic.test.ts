import { describe, expect, it } from "vitest";

import {
  advanceRibbon,
  collisionMargin,
  createRibbonState,
  directionFromCodes,
  fitRibbonToBounds,
  hasPlayableSpace,
  layoutRibbonGlyphs,
  RIBBON_MAX_CATCHUP,
  RIBBON_PHYSICS,
  RIBBON_STEER_CODES,
  RIBBON_STEP,
  stepRibbon,
  type RibbonGlyphPose,
  type RibbonInput,
  type RibbonPoint,
  type RibbonState,
} from "./WorkingRibbon.logic";

const BIG = { width: 2000, height: 2000 };
const STILL: RibbonInput = { x: 0, y: 0 };
const RIGHT: RibbonInput = { x: 1, y: 0 };

function speedOf(state: RibbonState): number {
  return Math.hypot(state.velocity.x, state.velocity.y);
}

function measuredLength(samples: ReadonlyArray<RibbonPoint>): number {
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) {
    length += Math.hypot(
      samples[index]!.x - samples[index - 1]!.x,
      samples[index]!.y - samples[index - 1]!.y,
    );
  }
  return length;
}

function liveLength(state: RibbonState): number {
  const last = state.samples.at(-1)!;
  return state.samplesLength + Math.hypot(state.head.x - last.x, state.head.y - last.y);
}

function manualState(samples: RibbonPoint[], head: RibbonPoint): RibbonState {
  return {
    head,
    velocity: { x: 0, y: 0 },
    samples,
    samplesLength: measuredLength(samples),
    accumulator: 0,
  };
}

describe("directionFromCodes", () => {
  it("maps every steering code to its direction", () => {
    const expected: Record<string, RibbonInput> = {
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
    };
    for (const [code, direction] of Object.entries(RIBBON_STEER_CODES)) {
      expect(directionFromCodes(new Set([code]))).toEqual(expected[direction]);
    }
    expect(directionFromCodes(new Set(["KeyA"]))).toEqual(
      directionFromCodes(new Set(["ArrowLeft"])),
    );
  });

  it("cancels opposite directions and ignores other keys", () => {
    expect(directionFromCodes(new Set(["ArrowLeft", "KeyD"]))).toEqual({ x: 0, y: 0 });
    expect(directionFromCodes(new Set(["KeyW", "ArrowDown", "ArrowRight"]))).toEqual({
      x: 1,
      y: 0,
    });
    expect(directionFromCodes(new Set(["KeyQ", "Space"]))).toEqual({ x: 0, y: 0 });
  });
});

describe("collisionMargin / hasPlayableSpace", () => {
  it("clears a glyph's diagonal at any rotation", () => {
    expect(collisionMargin(6, 8)).toBe(RIBBON_PHYSICS.edgeGap + 5);
    expect(collisionMargin(10, 10)).toBe(RIBBON_PHYSICS.edgeGap + Math.ceil(Math.SQRT2 * 5));
  });

  it("needs room on both axes", () => {
    expect(hasPlayableSpace({ width: 21, height: 21 }, 10)).toBe(true);
    expect(hasPlayableSpace({ width: 20, height: 400 }, 10)).toBe(false);
    expect(hasPlayableSpace({ width: 400, height: 0 }, 10)).toBe(false);
  });

  it("needs room to lay the text out flat", () => {
    expect(hasPlayableSpace({ width: 160, height: 100 }, 10, 140)).toBe(true);
    expect(hasPlayableSpace({ width: 159, height: 100 }, 10, 140)).toBe(false);
  });
});

describe("createRibbonState", () => {
  it("lays the text flat, ending at the head", () => {
    const state = createRibbonState({ x: 300, y: 100 }, 80, BIG, 12);
    expect(state.head).toEqual({ x: 300, y: 100 });
    expect(state.samples.at(-1)).toEqual({ x: 300, y: 100 });
    expect(state.samples[0]).toEqual({ x: 220, y: 100 });
    expect(state.samplesLength).toBeCloseTo(80, 9);
    expect(measuredLength(state.samples)).toBeCloseTo(80, 9);
    for (let index = 1; index < state.samples.length; index += 1) {
      expect(state.samples[index]!.x - state.samples[index - 1]!.x).toBeLessThanOrEqual(
        RIBBON_PHYSICS.sampleSpacing + 1e-9,
      );
    }
    expect(state.velocity).toEqual({ x: 0, y: 0 });
    expect(state.accumulator).toBe(0);
  });

  it("shifts the head inward so the tail clears the left edge", () => {
    const state = createRibbonState({ x: 5, y: 100 }, 100, BIG, 12);
    expect(state.head.x).toBe(112);
    for (const sample of state.samples) expect(sample.x).toBeGreaterThanOrEqual(12);
  });

  it("clamps the head vertically", () => {
    expect(createRibbonState({ x: 300, y: -50 }, 50, BIG, 12).head.y).toBe(12);
    expect(createRibbonState({ x: 300, y: 5000 }, 50, BIG, 12).head.y).toBe(BIG.height - 12);
  });
});

describe("fitRibbonToBounds", () => {
  const advances = Array.from({ length: 14 }, () => 10);
  const textWidth = 140;
  const margin = 20;

  function expectPosesInside(state: RibbonState, bounds: { width: number; height: number }) {
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, advances, 0.7, out);
    const slack = RIBBON_PHYSICS.wobbleAmplitude + 1e-6;
    for (const pose of out) {
      expect(pose.x).toBeGreaterThanOrEqual(margin - slack);
      expect(pose.x).toBeLessThanOrEqual(bounds.width - margin + slack);
      expect(pose.y).toBeGreaterThanOrEqual(margin - slack);
      expect(pose.y).toBeLessThanOrEqual(bounds.height - margin + slack);
    }
  }

  it("lays a path that clamping collapsed out flat again", () => {
    // A vertical trail at x=40, then the stage shrinks to 400×120.
    const samples: RibbonPoint[] = [];
    for (let y = 20; y < 160; y += 2) samples.push({ x: 40, y });
    const state = manualState(samples, { x: 40, y: 160 });
    const bounds = { width: 400, height: 120 };
    fitRibbonToBounds(state, bounds, margin, textWidth);
    expect(liveLength(state)).toBeGreaterThanOrEqual(textWidth - 1e-6);
    expect(state.samplesLength).toBeCloseTo(measuredLength(state.samples), 9);
    expectPosesInside(state, bounds);
  });

  it("lengthens a path that a longer label outgrew", () => {
    const state = createRibbonState({ x: 300, y: 60 }, 60, BIG, margin);
    fitRibbonToBounds(state, BIG, margin, textWidth);
    expect(liveLength(state)).toBeGreaterThanOrEqual(textWidth - 1e-6);
    expectPosesInside(state, BIG);
  });

  it("keeps a long enough path that only needed clamping", () => {
    const samples: RibbonPoint[] = [];
    for (let x = 100; x <= 300; x += 2) samples.push({ x, y: 150 });
    const state = manualState(samples, { x: 302, y: 150 });
    const bounds = { width: 600, height: 120 };
    fitRibbonToBounds(state, bounds, margin, textWidth);
    expect(state.samples[0]).toEqual({ x: 100, y: 100 });
    expect(state.head).toEqual({ x: 302, y: 100 });
    expectPosesInside(state, bounds);
  });
});

describe("stepRibbon", () => {
  it("accelerates to the speed limit and never beyond", () => {
    const state = createRibbonState({ x: 100, y: 1000 }, 50, { width: 100000, height: 2000 }, 10);
    let previous = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      stepRibbon(state, RIGHT, RIBBON_STEP, { width: 100000, height: 2000 }, 10, 200);
      const speed = speedOf(state);
      expect(speed).toBeLessThanOrEqual(RIBBON_PHYSICS.maxSpeed + 1e-9);
      expect(speed).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = speed;
    }
    expect(previous).toBeCloseTo(RIBBON_PHYSICS.maxSpeed, 6);
  });

  it("decays toward rest without input", () => {
    const state = createRibbonState({ x: 1000, y: 1000 }, 50, BIG, 10);
    state.velocity = { x: 300, y: -200 };
    let previous = speedOf(state);
    for (let tick = 0; tick < 240; tick += 1) {
      stepRibbon(state, STILL, RIBBON_STEP, BIG, 10, 200);
      expect(speedOf(state)).toBeLessThan(previous);
      previous = speedOf(state);
    }
    expect(previous).toBeLessThan(1);
  });

  it("gives diagonal input the same pull as a single axis", () => {
    const straight = createRibbonState({ x: 1000, y: 1000 }, 50, BIG, 10);
    const diagonal = createRibbonState({ x: 1000, y: 1000 }, 50, BIG, 10);
    stepRibbon(straight, RIGHT, RIBBON_STEP, BIG, 10, 200);
    stepRibbon(diagonal, { x: 1, y: 1 }, RIBBON_STEP, BIG, 10, 200);
    expect(speedOf(diagonal)).toBeCloseTo(speedOf(straight), 9);
  });

  it("clamps at the margin and bounces with restitution", () => {
    const bounds = { width: 400, height: 300 };
    const state = createRibbonState({ x: 380, y: 150 }, 50, bounds, 20);
    state.velocity = { x: 400, y: 0 };
    stepRibbon(state, STILL, RIBBON_STEP, bounds, 20, 200);
    expect(state.head.x).toBe(380);
    const damped = 400 * Math.exp(-RIBBON_PHYSICS.drag * RIBBON_STEP);
    expect(state.velocity.x).toBeCloseTo(-damped * RIBBON_PHYSICS.restitution, 9);

    state.head = { x: 200, y: 21 };
    state.velocity = { x: 0, y: -300 };
    stepRibbon(state, STILL, RIBBON_STEP, bounds, 20, 200);
    expect(state.head.y).toBe(20);
    expect(state.velocity.y).toBeGreaterThan(0);
  });

  it("samples a slow curve every ~2px along the real path", () => {
    const radius = 60;
    const center = { x: 500, y: 500 };
    const start = { x: center.x + radius, y: center.y };
    const state = createRibbonState(start, 40, BIG, 10);
    const seeded = state.samples.length;
    // 0.8px per frame along a quarter circle.
    const angleStep = 0.8 / radius;
    for (let frame = 1; frame <= 120; frame += 1) {
      const angle = Math.min(Math.PI / 2, frame * angleStep);
      state.head = {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      };
      stepRibbon(state, STILL, RIBBON_STEP, BIG, 10, 10000);
    }
    const committed = state.samples.slice(seeded);
    expect(committed.length).toBeGreaterThan(40);
    let previous = state.samples[seeded - 1]!;
    for (const sample of committed) {
      expect(Math.hypot(sample.x - previous.x, sample.y - previous.y)).toBeCloseTo(
        RIBBON_PHYSICS.sampleSpacing,
        9,
      );
      expect(
        Math.abs(Math.hypot(sample.x - center.x, sample.y - center.y) - radius),
      ).toBeLessThanOrEqual(0.5);
      previous = sample;
    }
  });

  it("commits several samples for a fast move", () => {
    const state = createRibbonState({ x: 500, y: 500 }, 40, BIG, 10);
    const before = state.samples.length;
    state.head = { x: 517, y: 500 };
    stepRibbon(state, STILL, RIBBON_STEP, BIG, 10, 10000);
    expect(state.samples.length - before).toBe(8);
  });

  it("keeps the trail within one sample of its target length", () => {
    const maxTrailLength = 120;
    const state = createRibbonState({ x: 100, y: 1000 }, 60, BIG, 10);
    let traveled = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      const input: RibbonInput = tick % 200 < 120 ? RIGHT : { x: 0, y: tick % 2 === 0 ? 1 : -1 };
      const before = { ...state.head };
      stepRibbon(state, input, RIBBON_STEP, BIG, 10, maxTrailLength);
      traveled += Math.hypot(state.head.x - before.x, state.head.y - before.y);
      expect(state.samplesLength).toBeCloseTo(measuredLength(state.samples), 6);
      if (traveled > maxTrailLength) {
        expect(liveLength(state)).toBeGreaterThanOrEqual(maxTrailLength - 1e-6);
        expect(liveLength(state)).toBeLessThanOrEqual(
          maxTrailLength + RIBBON_PHYSICS.sampleSpacing + 1e-6,
        );
      }
    }
  });

  it("stays finite in bounds smaller than its margin", () => {
    const bounds = { width: 5, height: 5 };
    const state = createRibbonState({ x: 2, y: 2 }, 30, bounds, 10);
    for (let tick = 0; tick < 30; tick += 1) {
      stepRibbon(state, { x: 1, y: -1 }, RIBBON_STEP, bounds, 10, 60);
    }
    for (const value of [state.head.x, state.head.y, state.velocity.x, state.velocity.y]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const sample of state.samples) {
      expect(Number.isFinite(sample.x) && Number.isFinite(sample.y)).toBe(true);
    }
  });
});

describe("advanceRibbon", () => {
  function runAt(hz: number) {
    const state = createRibbonState({ x: 100, y: 1000 }, 60, BIG, 10);
    let ticks = 0;
    for (let frame = 0; frame < hz; frame += 1) {
      ticks += advanceRibbon(state, RIGHT, 1 / hz, BIG, 10, 200);
    }
    return { state, ticks };
  }

  it("runs the same simulation at any refresh rate", () => {
    const reference = runAt(60);
    expect(reference.ticks).toBe(60);
    for (const hz of [30, 120, 240]) {
      const run = runAt(hz);
      expect(run.ticks).toBe(60);
      expect(run.state.head.x).toBeCloseTo(reference.state.head.x, 6);
      expect(run.state.head.y).toBeCloseTo(reference.state.head.y, 6);
    }
  });

  it("caps catch-up after a long frame", () => {
    const state = createRibbonState({ x: 100, y: 1000 }, 60, BIG, 10);
    const ticks = advanceRibbon(state, RIGHT, 0.5, BIG, 10, 200);
    expect(ticks).toBeLessThanOrEqual(Math.round(RIBBON_MAX_CATCHUP / RIBBON_STEP));
    expect(advanceRibbon(state, RIGHT, Number.NaN, BIG, 10, 200)).toBe(0);
  });
});

describe("layoutRibbonGlyphs", () => {
  it("places glyphs along a straight trail at their cumulative offsets", () => {
    const state = createRibbonState({ x: 300, y: 100 }, 30, BIG, 10);
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, [10, 10, 10], 0, out);
    expect(out.map((pose) => pose.x)).toEqual([275, 285, 295].map((x) => expect.closeTo(x, 6)));
    for (const pose of out) {
      expect(pose.angle).toBeCloseTo(0, 9);
      expect(Math.abs(pose.y - 100)).toBeLessThanOrEqual(RIBBON_PHYSICS.wobbleAmplitude);
    }
  });

  it("turns the text upside down heading left", () => {
    const samples: RibbonPoint[] = [];
    for (let x = 300; x >= 200; x -= 2) samples.push({ x, y: 100 });
    const state = manualState(samples, { x: 198, y: 100 });
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, [10, 10, 10], 0, out);
    for (const pose of out) expect(Math.abs(pose.angle)).toBeCloseTo(Math.PI, 9);
    expect(out[2]!.x).toBeCloseTo(203, 6);
    expect(out[0]!.x).toBeGreaterThan(out[2]!.x);
  });

  it("follows the path around a corner", () => {
    const samples: RibbonPoint[] = [];
    for (let x = 100; x <= 200; x += 2) samples.push({ x, y: 100 });
    for (let y = 102; y < 200; y += 2) samples.push({ x: 200, y });
    const state = manualState(samples, { x: 200, y: 200 });
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, [20, 20, 20, 20, 20, 20, 20], 0, out);
    // Centres sit 10, 30, …, 130px behind the head; the corner is 100px back.
    for (const index of [2, 3, 4, 5, 6]) expect(out[index]!.angle).toBeCloseTo(Math.PI / 2, 9);
    for (const index of [0, 1]) expect(out[index]!.angle).toBeCloseTo(0, 9);
    expect(out[0]!.x).toBeCloseTo(170, 6);
    expect(out[0]!.y).toBeCloseTo(100, 0);
  });

  it("extrapolates when the trail is shorter than the text", () => {
    const state = manualState(
      [
        { x: 100, y: 100 },
        { x: 102, y: 100 },
      ],
      { x: 104, y: 100 },
    );
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, [10, 10, 10, 10], 1.3, out);
    for (const pose of out) {
      expect(Number.isFinite(pose.x) && Number.isFinite(pose.y)).toBe(true);
      expect(pose.angle).toBeCloseTo(0, 9);
    }
    expect(out[0]!.x).toBeCloseTo(69, 6);

    const still = manualState([{ x: 50, y: 50 }], { x: 50, y: 50 });
    layoutRibbonGlyphs(still, [10, 10], 0, out);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ x: 35, angle: 0 });
  });

  it("reuses the output array and its poses", () => {
    const state = createRibbonState({ x: 300, y: 100 }, 30, BIG, 10);
    const out: RibbonGlyphPose[] = [];
    layoutRibbonGlyphs(state, [10, 10, 10], 0, out);
    const firstPose = out[0];
    layoutRibbonGlyphs(state, [10, 10, 10], 0.5, out);
    expect(out[0]).toBe(firstPose);
    layoutRibbonGlyphs(state, [10, 10], 0.5, out);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(firstPose);
  });
});
