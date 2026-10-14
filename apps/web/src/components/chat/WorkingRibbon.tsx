import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { isKeyboardEventComposing } from "~/lib/keyboardComposition";
import { WORKING_RIBBON_SLOT } from "~/lib/workingRibbon";
import {
  advanceRibbon,
  collisionMargin,
  createRibbonState,
  directionFromCodes,
  fitRibbonToBounds,
  hasPlayableSpace,
  isRibbonSteerCode,
  layoutRibbonGlyphs,
  RIBBON_PHYSICS,
  RIBBON_STEP,
  type RibbonBounds,
  type RibbonGlyphPose,
  type RibbonInput,
  type RibbonPoint,
  type RibbonState,
} from "./WorkingRibbon.logic";

export type WorkingRibbonReleaseReason = "escape" | "blur" | "no-space" | "invalid";

export interface WorkingRibbonProps {
  text: string;
  /** Client coordinates of the label's right edge, at its vertical centre. */
  origin: RibbonPoint;
  onRelease: (reason: WorkingRibbonReleaseReason) => void;
  /** The ribbon unmounted for an outside reason while it held focus. */
  onOrphanedFocus: () => void;
}

interface RibbonSimulation {
  state: RibbonState | null;
  bounds: RibbonBounds;
  margin: number;
  textWidth: number;
  maxTrailLength: number;
  advances: number[];
  widths: number[];
  heights: number[];
  poses: RibbonGlyphPose[];
  time: number;
}

const STILL: RibbonInput = { x: 0, y: 0 };

/**
 * The working label, picked up and steerable: an homage to the "Now Loading"
 * text of Castlevania: Symphony of the Night. Arrow keys or WASD steer the
 * last glyph; the rest follow its path. Glyph transforms are written straight
 * to the DOM each frame, so React only renders when the text changes.
 */
export const WorkingRibbon = memo(function WorkingRibbon(props: WorkingRibbonProps) {
  const { text } = props;
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const statusId = useId();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const glyphRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const simulationRef = useRef<RibbonSimulation>({
    state: null,
    bounds: { width: 0, height: 0 },
    margin: 0,
    textWidth: 0,
    maxTrailLength: 0,
    advances: [],
    widths: [],
    heights: [],
    poses: [],
    time: 0,
  });
  const pressedRef = useRef(new Set<string>());
  const inputRef = useRef<RibbonInput>(STILL);
  const releasedRef = useRef(false);
  const [measureVersion, setMeasureVersion] = useState(0);
  const glyphs = Array.from(text);

  const release = (reason: WorkingRibbonReleaseReason) => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    pressedRef.current.clear();
    inputRef.current = STILL;
    latestPropsRef.current.onRelease(reason);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  const writeFrame = () => {
    const simulation = simulationRef.current;
    if (!simulation.state) return;
    layoutRibbonGlyphs(simulation.state, simulation.advances, simulation.time, simulation.poses);
    for (let index = 0; index < simulation.poses.length; index += 1) {
      const glyph = glyphRefs.current[index];
      const pose = simulation.poses[index];
      if (!glyph || !pose) continue;
      const left = pose.x - (simulation.widths[index] ?? 0) / 2;
      const top = pose.y - (simulation.heights[index] ?? 0) / 2;
      glyph.style.transform = `translate(${left}px, ${top}px) rotate(${pose.angle}rad)`;
    }
  };
  const writeFrameRef = useRef(writeFrame);
  writeFrameRef.current = writeFrame;

  // After the stage or the text changed size: keep every glyph inside the
  // stage, or drop the ribbon when the text no longer fits.
  const fitToStage = () => {
    const simulation = simulationRef.current;
    if (!simulation.state) return;
    if (!hasPlayableSpace(simulation.bounds, simulation.margin, simulation.textWidth)) {
      release("no-space");
      return;
    }
    fitRibbonToBounds(simulation.state, simulation.bounds, simulation.margin, simulation.textWidth);
    writeFrame();
  };
  const fitToStageRef = useRef(fitToStage);
  fitToStageRef.current = fitToStage;

  // Measure glyph boxes (offset sizes ignore transforms). Re-runs when the text
  // gains or loses glyphs, and when fonts or appearance settings change.
  useLayoutEffect(() => {
    const glyphCount = Array.from(text).length;
    glyphRefs.current.length = glyphCount;
    const simulation = simulationRef.current;
    const widths: number[] = [];
    const heights: number[] = [];
    for (let index = 0; index < glyphCount; index += 1) {
      const glyph = glyphRefs.current[index];
      const width = glyph?.offsetWidth ?? 0;
      const height = glyph?.offsetHeight ?? 0;
      if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
        releaseRef.current("invalid");
        return;
      }
      widths.push(width);
      heights.push(height);
    }
    simulation.widths = widths;
    simulation.heights = heights;
    simulation.advances = widths;
    simulation.margin = collisionMargin(Math.max(0, ...widths), Math.max(0, ...heights));
    simulation.textWidth = widths.reduce((total, width) => total + width, 0);
    simulation.maxTrailLength = simulation.textWidth + RIBBON_PHYSICS.trailSlack;
    // Fits synchronously so glyphs added mid-flight never paint at the
    // stage's corner, and a longer label never trails out of the stage.
    fitToStageRef.current();
  }, [text, measureVersion]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Per run, so a Strict Mode replay cannot revive the first run's callbacks.
    let disposed = false;
    const simulation = simulationRef.current;
    const pressed = pressedRef.current;
    if (
      typeof ResizeObserver === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      releaseRef.current("invalid");
      return;
    }
    if (releasedRef.current) return;

    const rect = stage.getBoundingClientRect();
    simulation.bounds = { width: rect.width, height: rect.height };
    if (!hasPlayableSpace(simulation.bounds, simulation.margin, simulation.textWidth)) {
      releaseRef.current("no-space");
      return;
    }
    const { origin } = latestPropsRef.current;
    simulation.state = createRibbonState(
      { x: origin.x - rect.left, y: origin.y - rect.top },
      simulation.textWidth,
      simulation.bounds,
      simulation.margin,
    );
    simulation.time = 0;
    writeFrameRef.current();
    stage.focus({ preventScroll: true });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      simulation.bounds = { width: stage.clientWidth, height: stage.clientHeight };
      fitToStageRef.current();
    });
    resizeObserver.observe(stage);

    const remeasure = () => {
      if (!disposed) setMeasureVersion((version) => version + 1);
    };
    // Appearance settings (font family, size) are written to the root's style.
    const appearanceObserver = new MutationObserver(remeasure);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    const fonts = typeof document.fonts === "undefined" ? null : document.fonts;
    fonts?.addEventListener("loadingdone", remeasure);
    void fonts?.ready.then(remeasure, () => {});

    const onWindowBlur = () => releaseRef.current("blur");
    const onVisibilityChange = () => {
      if (document.hidden) releaseRef.current("blur");
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    let lastFrameAt: number | null = null;
    let frame = window.requestAnimationFrame(function tick(now) {
      if (disposed) return;
      frame = window.requestAnimationFrame(tick);
      const elapsed = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      if (!simulation.state) return;
      const ticks = advanceRibbon(
        simulation.state,
        inputRef.current,
        elapsed,
        simulation.bounds,
        simulation.margin,
        simulation.maxTrailLength,
      );
      simulation.time += ticks * RIBBON_STEP;
      writeFrameRef.current();
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      fonts?.removeEventListener("loadingdone", remeasure);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pressed.clear();
      inputRef.current = STILL;
      if (!releasedRef.current && stage.contains(document.activeElement)) {
        latestPropsRef.current.onOrphanedFocus();
      }
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // macOS drops keyups while Cmd is held, so a modifier forgets held keys.
    if (event.key === "Meta" || event.key === "Control" || event.key === "Alt") {
      pressedRef.current.clear();
      inputRef.current = STILL;
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.defaultPrevented ||
      isKeyboardEventComposing(event.nativeEvent)
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      release("escape");
      return;
    }
    if (!isRibbonSteerCode(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    pressedRef.current.add(event.code);
    inputRef.current = directionFromCodes(pressedRef.current);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    pressedRef.current.delete(event.code);
    inputRef.current = directionFromCodes(pressedRef.current);
  };

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      role="application"
      aria-label="Steerable working indicator"
      aria-describedby={`${statusId} ${hintId}`}
      data-slot={WORKING_RIBBON_SLOT}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden outline-none"
      style={{ bottom: "var(--composer-dock-height, 0px)" }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => release("blur")}
    >
      <span id={statusId} className="sr-only">
        {text}
      </span>
      {glyphs.map((glyph, index) => (
        <span
          // Glyphs are positional: index keys keep transforms stable as the
          // timer's digits change.
          key={index}
          ref={(node) => {
            glyphRefs.current[index] = node;
          }}
          aria-hidden="true"
          data-ribbon-glyph=""
          className="absolute left-0 top-0 inline-block select-none whitespace-pre text-lg font-semibold tabular-nums text-muted-foreground will-change-transform"
        >
          {glyph}
        </span>
      ))}
      <p
        id={hintId}
        className="absolute inset-x-0 bottom-2 text-center text-2xs text-faint-foreground"
      >
        Arrow keys or WASD to steer · Esc to drop
      </p>
    </div>
  );
});
