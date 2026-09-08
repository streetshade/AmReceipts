// Deciding when the camera is being held still over something worth shooting.
//
// HONEST NOTE ON WHAT THIS IS. The design says auto-capture fires "on edge
// detection". This is not that, and calling it that would be a lie: it measures
// how much the picture is CHANGING, and how much texture is in it. Real
// document detection needs a vision model. What this can tell you is that the
// phone has stopped moving and is pointed at something with writing on it,
// which covers the case the design is really about - a technician holding a
// phone over a receipt - and the shutter covers the rest.
//
// The first version of this failed on real hardware in a way that is worth
// recording, because it is not obvious from a desk:
//
//   It compared one channel against a fixed threshold and demanded that EVERY
//   frame pass. The countdown runs 1.65s, which is about a hundred frames, and
//   a single one over the line reset it. A phone held in a hand produces sensor
//   noise, autofocus hunting and a pulse; on a tripod in good light it worked,
//   and handheld it never fired once - neither on a receipt nor on anything
//   else. It was not too eager or too shy. It was all-or-nothing.
//
// So this one is built around two ideas. The threshold calibrates itself to
// whatever noise the camera is actually producing, and the verdict comes from
// the MEDIAN of a short window rather than the latest frame, so one bad frame
// cannot undo a second of holding still.

/**
 * Frames kept for the median. Two thirds of a second at 30fps, a third at 60.
 *
 * Counted in CAMERA frames, not in time: the caller feeds this from
 * `requestVideoFrameCallback`, so a phone that drops to 15fps in poor light
 * takes longer to reach a verdict rather than reaching a worse one.
 */
const SAMPLE_WINDOW = 20;

/**
 * Frames the camera's own baseline is measured over. About three seconds at 30fps.
 *
 * Long enough to characterise what this camera does, short enough to follow a
 * change in the light.
 */
const BASELINE_WINDOW = 90;



/**
 * How much larger the two-frame change may be than the one-frame change.
 *
 * This is what tells camera noise apart from slow movement. Independent noise
 * is the same size across two frames as across one, so the ratio sits near 1.
 * Movement accumulates: two frames of drift shifts the picture twice as far, so
 * the ratio climbs towards 2.
 *
 * Without it, a threshold that calibrates itself to the quietest recent frame
 * has no way to know that the quietest recent frame was ALSO moving. A hand
 * panning steadily and slowly would set its own floor from its own motion and
 * then be told it was holding still.
 *
 * The two populations were measured; 1.75 is a judgement made from them. They
 * overlap: a still phone
 * with correlated noise - temporal denoising, a drifting exposure, a hunting
 * autofocus - runs from about 1.45 to 1.67, and drift runs from about 1.62
 * upwards. There is no line that separates them cleanly, so it is drawn where
 * every still case measured passes, and slow drift below roughly a quarter of a
 * pixel per frame passes with it.
 *
 * That is the right way round. A quarter of a pixel per frame is the receipt
 * crossing the frame in about twenty seconds; the photograph is sharp, and if
 * it is not the user deletes it in one tap. A phone held perfectly still that
 * refuses to fire is the failure that was actually reported from the field, and
 * it is the one worth being wrong in the other direction to avoid.
 *
 * It is not a complete test on its own. Very fast movement decorrelates the
 * frames and the ratio falls back towards 1; periodic movement can sit under it
 * too. The absolute threshold is what covers those.
 */
const MAX_MOTION_RATIO = 1.75;

/**
 * Movement small enough that the ratio is not consulted at all.
 *
 * A safety valve, and it points the same way as everything else here: when the
 * picture is barely changing in absolute terms the photograph will be sharp
 * whatever the ratio says, and the ratio is the one signal that can be fooled
 * into blocking by a camera's own processing. Below this, stillness is stillness.
 */
const RATIO_EXEMPT_BELOW = 2.5;

/** How far above the camera's own baseline still counts as "not moving". */
const BASELINE_MULTIPLIER = 1.8;
/** Added as well, so a very quiet camera does not get an unusably tight bar. */
const BASELINE_MARGIN = 2;

/**
 * The threshold is clamped between these.
 *
 * The ceiling matters most: without it, a phone that is never held still raises
 * its own floor until any movement counts as stillness, and it fires while
 * being waved about.
 *
 * 24 rather than something tighter because a noisy camera is not a moving one.
 * A phone in poor light produces a mean frame-to-frame change around 20 while
 * sitting perfectly still - a ceiling of 14 refused to fire on a still phone in
 * a dim room, which is exactly the reported failure. Drift large enough to blur
 * is far above this anyway; the ratio above is what catches the slow kind.
 */
const MIN_THRESHOLD = 1.5;
const MAX_THRESHOLD = 24;

/**
 * How much CONTRAST the picture needs before this will call it a subject.
 *
 * Measured as the spread of brightness across the frame, not as a gradient
 * between neighbouring pixels. That distinction was found by testing: a bare
 * table under a noisy camera has a per-pixel gradient as high as printed text,
 * because uncorrelated sensor noise IS high-frequency detail. Spread is immune
 * to it - noise of a few levels barely moves a figure that ink and paper drive
 * to eighty or more.
 *
 * Measured, and the two populations overlap here as well. Crisp black on white
 * gives about 79. A thermal receipt faded until ink and paper are 25 levels
 * apart gives 10.7. A bare surface gives 3.5 at ordinary sensor noise, 8.5 in a
 * dim room, and 11.6 in near-darkness.
 *
 * 9 admits the faded receipt and refuses the bare surface up to a dim room. In
 * near-darkness a blank wall would pass it - and that is the direction to be
 * wrong in, because a stray photograph is one tap to delete and a receipt that
 * will not photograph is the failure that was actually reported. This gate
 * exists to stop the phone shooting the dashboard it is sitting on, not to
 * judge whether something is a receipt.
 */
const MIN_DETAIL = 9;

export interface StabilityReading {
  /** The picture has stopped changing, by its own camera's standards. */
  steady: boolean;
  /** There is enough texture in view to be something worth photographing. */
  hasDetail: boolean;
  /** Both of the above, and enough frames seen to mean it. */
  ready: boolean;
  /** This frame's mean absolute change in brightness, per pixel. */
  diff: number;
  /** The median of the recent window - what `steady` is actually judged on. */
  median: number;
  /** What that median is being compared against, right now. */
  threshold: number;
  /**
   * What this camera typically does between frames, lately.
   *
   * The MEDIAN of the recent window, not its minimum, and the distinction was
   * measured. A still camera's frame-to-frame change is tightly distributed -
   * at plain sensor noise the tenth and ninetieth percentiles are 3.95 and 4.08.
   * A still camera whose processing correlates one frame with the next is wide:
   * a tenth percentile of 0 and a ninetieth of 6. Anchoring to the low end
   * therefore set an unreachable bar for exactly the cameras that need the most
   * slack, and a perfectly still phone would not fire.
   */
  baseline: number;
  /** Spread of brightness across the frame: how much contrast is in view. */
  detail: number;
  /**
   * How much bigger the two-frame change is than the one-frame change.
   *
   * Near 1 is noise; climbing towards 2 is drift. See MAX_MOTION_RATIO.
   */
  motionRatio: number;
}

const BLIND: StabilityReading = {
  steady: false,
  hasDetail: false,
  ready: false,
  diff: 0,
  median: 0,
  threshold: MAX_THRESHOLD,
  baseline: 0,
  detail: 0,
  motionRatio: 1,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class StabilityDetector {
  private previous: Uint8Array | null = null;
  private previousWidth = 0;
  private previousHeight = 0;
  private beforePrevious: Uint8Array | null = null;
  private recent: number[] = [];
  private ratios: number[] = [];
  private baselineSamples: number[] = [];
  private last: StabilityReading = BLIND;

  /** Forget everything - after a shot, or when the camera restarts. */
  reset(): void {
    this.previous = null;
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.beforePrevious = null;
    this.recent = [];
    this.ratios = [];
    this.baselineSamples = [];
    this.last = BLIND;
  }

  /**
   * Feed one frame of RGBA pixels and get a verdict.
   *
   * Brightness rather than a single channel: red alone made a white receipt
   * under a warm light look noisier than it was.
   */
  push(rgba: Uint8ClampedArray, width: number, height: number): StabilityReading {
    const count = width * height;
    if (count === 0 || rgba.length < count * 4) return BLIND;

    // A change of frame size starts again from nothing.
    //
    // Comparing a frame against one of a different size reads past the end of
    // the previous array, and `undefined` propagates: the difference becomes
    // NaN, every comparison against it is false, and the poisoned sample sits
    // in the baseline window for the next three seconds - during which nothing
    // can fire. It is the never-fires signature exactly, and a camera
    // renegotiating its resolution at startup, or a phone being turned on its
    // side, is enough to cause it.
    if (width !== this.previousWidth || height !== this.previousHeight) {
      this.reset();
      this.previousWidth = width;
      this.previousHeight = height;
    }

    const luma = new Uint8Array(count);
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      // A cheap approximation of Rec. 601 luma; the exact weights do not matter
      // when the answer is "did this change".
      luma[p] = (rgba[i] + 2 * rgba[i + 1] + rgba[i + 2]) >> 2;
    }

    // Standard deviation of brightness. Ink against paper drives this a long
    // way up - about 79 for crisp print - while a uniform surface stays much
    // lower: 3.5 at ordinary sensor noise, though heavy noise in near-darkness
    // can lift it to 11 or so and past the gate. A neighbouring-pixel gradient
    // could not tell the two apart at all, because noise IS high-frequency
    // detail.
    let total = 0;
    for (let p = 0; p < count; p++) total += luma[p];
    const mean = total / count;
    let variance = 0;
    for (let p = 0; p < count; p++) {
      const d = luma[p] - mean;
      variance += d * d;
    }
    const detail = Math.sqrt(variance / count);
    const hasDetail = detail >= MIN_DETAIL;

    const previous = this.previous;
    if (!previous) {
      this.previous = luma;
      this.last = { ...BLIND, detail, hasDetail };
      return this.last;
    }

    // Duplicate frames are the CALLER's problem: it waits on
    // `requestVideoFrameCallback`, or on the media clock advancing, so what
    // arrives here is a frame the camera has actually presented. Discarding
    // luma-identical frames here as well was worse than useless - a very clean
    // camera, or aggressive denoising, produces genuinely identical frames, and
    // dropping them meant the window never filled and nothing ever fired. A
    // frame that really did not change is a change of zero, which is true.
    let sum = 0;
    for (let p = 0; p < count; p++) {
      const d = luma[p] - previous[p];
      sum += d < 0 ? -d : d;
    }

    const diff = sum / count;

    // The change across TWO frames, which is what makes noise distinguishable
    // from drift. See MAX_MOTION_RATIO.
    let ratio = 1;
    const before = this.beforePrevious;
    if (before) {
      let twoSum = 0;
      for (let p = 0; p < count; p++) {
        const d = luma[p] - before[p];
        twoSum += d < 0 ? -d : d;
      }
      const twoFrame = twoSum / count;
      // Guarded: a perfectly quiet frame pair would otherwise divide by zero
      // and report an infinite ratio, i.e. call stillness movement.
      ratio = diff > 0.05 ? twoFrame / diff : 1;
    }

    this.beforePrevious = previous;
    this.previous = luma;

    this.recent.push(diff);
    if (this.recent.length > SAMPLE_WINDOW) this.recent.shift();
    this.ratios.push(ratio);
    if (this.ratios.length > SAMPLE_WINDOW) this.ratios.shift();
    this.baselineSamples.push(diff);
    if (this.baselineSamples.length > BASELINE_WINDOW) this.baselineSamples.shift();

    const baseline = median(this.baselineSamples);
    const threshold = Math.min(
      MAX_THRESHOLD,
      Math.max(MIN_THRESHOLD, baseline * BASELINE_MULTIPLIER, baseline + BASELINE_MARGIN),
    );
    const mid = median(this.recent);
    const midRatio = median(this.ratios);

    // Three parts, and it is worth being plain about which does what.
    //
    // The median rather than the latest frame, so one spike in a second of
    // holding still - a heartbeat, an autofocus hunt - cannot undo it.
    //
    // The threshold is calibrated to this camera, which means a camera that is
    // ALWAYS moving largely satisfies its own bar; its real teeth are the
    // ceiling, which catches anything moving enough to blur whatever the camera
    // has talked itself into. That is deliberate. Calibrating tightly enough to
    // catch drift by magnitude alone is what stopped noisy cameras firing.
    //
    // The ratio is what actually separates slow coherent drift from a still
    // camera's own noise, and it is skipped when the picture is barely changing
    // at all, because there it can only cost a photograph and cannot save one.
    const steady =
      this.recent.length >= SAMPLE_WINDOW &&
      mid < threshold &&
      (mid < RATIO_EXEMPT_BELOW || midRatio < MAX_MOTION_RATIO);

    this.last = {
      steady,
      hasDetail,
      ready: steady && hasDetail,
      diff,
      median: mid,
      threshold,
      baseline,
      detail,
      motionRatio: midRatio,
    };
    return this.last;
  }
}
