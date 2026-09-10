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
 * pixel per frame passes with it. "Every still case measured" is the synthetic
 * set in `scripts/stability-check.ts`, not a survey of phones.
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
 * Measured on rendered scenes, and the two populations overlap here as well.
 * Crisp black on white gives about 79. A thermal receipt faded until ink and paper are 25 levels
 * apart gives 10.7. A bare surface gives 3.5 at ordinary sensor noise, 8.5 in a
 * dim room, and 11.6 in near-darkness.
 *
 * Lowered from 9 once the ink measurement above existed to do this job
 * properly. Standard deviation confounds contrast with density - it is roughly
 * contrast times the square root of p(1-p) - so a receipt that is BOTH faded
 * and sparsely printed scored 8.4 and was refused, while each fault on its own
 * passed. That interaction is invisible if the two are only ever tested
 * separately.
 *
 * What is left is a floor against a frame with nothing in it at all. In
 * near-darkness a blank wall would pass it - and that is the direction to be
 * wrong in, because a stray photograph is one tap to delete and a receipt that
 * will not photograph is the failure that was actually reported. This gate
 * exists to stop the phone shooting the dashboard it is sitting on, not to
 * judge whether something is a receipt.
 */
const MIN_DETAIL = 5;

/**
 * How solid the bright band has to be before it counts as a document.
 *
 * The contrast gate above cannot tell a receipt from a wooden desk - both have
 * plenty of contrast - and in the field it duly photographed the desk. See
 * `paperShapeOf` for what this measures and why it takes two figures rather
 * than one.
 */
const MIN_PAPER_FILL = 0.66;



/**
 * How solid a single row must be to count as part of the sheet.
 *
 * Paper is solid; texture is scattered. On a workbench the wood's own bright
 * ridges reach past the split, and without this every background row counted
 * as part of the sheet - the "longest continuous band" swallowed the frame and
 * its half-covered rows rejected the receipt lying in the middle of it. Which
 * is where receipts are.
 */
const MIN_ROW_COVERAGE = 0.6;

/**
 * How much of the sheet must be ink, and how dark that ink must be against it.
 *
 * This is the measurement the field asked for. Five false captures in an
 * ordinary room - a monitor, a laptop screen, a keyboard on a desk, a laptop on
 * the ground, a couch - and what they have in common is that nothing is written
 * on them. Everything before this measured the SHAPE of a bright region, and a
 * room is full of bright rectangles.
 *
 * Measured inside the band and against the band's own brightness, which matters
 * twice. An earlier attempt used the median row coverage as a stand-in and was
 * wrong in two ways that would have refused real receipts: a receipt with
 * ordinary line spacing has more blank rows than printed ones, so the median
 * row is solid paper and the figure reads as blank; and a faded receipt on a
 * dark background splits globally into "background" and "receipt", putting ink
 * and paper together on the bright side. Both were reproduced before this
 * replaced it.
 *
 * The two bars do different work, and the measurements say which:
 *
 *   CONTRAST stops a uniform surface. Split the pixels of a blank screen and
 *   the halves differ by 5 to 10 levels of noise; ink and paper differ by 170,
 *   and by 30 even on a receipt faded to the edge of legibility.
 *
 *   AMOUNT stops a two-tone object. Print covers a MINORITY of a receipt - 1%
 *   to 25% across everything measured here. In the rendered room scenes a
 *   monitor, a keyboard, a mug and a couch all split much more evenly.
 *
 * What neither refuses is a bright screen inside a darker bezel: a laptop
 * measures 0.071/35 against a receipt's 0.072/48, because by these two numbers
 * that is what a receipt looks like. Distribution was tried and does not
 * separate them either.
 *
 * The lower bound is deliberately tiny. It is not what rejects a blank surface
 * - contrast does that, and does it better - it is only there so a band with
 * literally nothing in it does not qualify. Set any higher, it refuses a small
 * receipt on a pale desk, where the band spreads into the surroundings and
 * dilutes the print to one percent.
 */
const MIN_INK = 0.005;
const MAX_INK = 0.33;
const MIN_INK_CONTRAST = 20;

/**
 * How far the bright band may wander from row to row, as a fraction of the frame.
 *
 * Measured. A receipt lying square wanders 0.000; held at 11 degrees, 0.032; at
 * 31 degrees, 0.090. A wooden desk 0.053, a dashboard 0.074, a hand 0.221 - but
 * a mug sits at 0.097, in among the angled receipts.
 *
 * So 0.12, which takes every angle a person holds a phone at and lets a mug
 * through with them. The alternative refuses a receipt held at a slant, and the
 * complaint that started this was a phone photographing the DESK it was lying
 * on - which this rejects with room to spare, along with walls, dashboards,
 * keyboards and hands.
 */
const MAX_PAPER_SPREAD = 0.12;

/**
 * What fraction of the recent window must look like paper.
 *
 * Not all of it. A single-frame test wired straight into the countdown is an
 * all-or-nothing gate, and an all-or-nothing gate is precisely how this feature
 * came to never fire at all - a hundred consecutive frames had to agree, and a
 * hand-held camera never gives you a hundred of anything.
 */
const MIN_PAPER_VOTES = 0.6;

export interface StabilityReading {
  /** The picture has stopped changing, by its own camera's standards. */
  steady: boolean;
  /**
   * There is something paper-shaped, with print on it, in view.
   *
   * One verdict rather than two, and taken over a window rather than from this
   * frame - which is why the raw `detail`, `paperFill` and `paperSpread` below
   * can disagree with it. They are what this frame measured; this is what the
   * last twenty frames voted.
   */
  hasSubject: boolean;
  /**
   * How solid the bright band is, 0 to 1.
   *
   * Near 1 is a sheet of paper. Around 0.5 is speckle - a textured surface
   * whose bright pixels are scattered across the whole width.
   */
  paperFill: number;
  /** How much that band wanders from row to row. Near 0 is a rectangle. */
  paperSpread: number;
  /**
   * What fraction of the sheet falls in the SMALLER of its two brightness
   * populations, after the lighting has been flattened out.
   *
   * Print is a minority of a receipt, so this is usually the print - but it is
   * a minority-population figure, not a measurement of ink, and it can pick up
   * a lighting or boundary artefact instead.
   */
  ink: number;
  /** How far ink and paper are apart in brightness. Noise on a blank surface is a few levels. */
  inkContrast: number;
  /**
   * Fine structure: how much the picture differs from a blurred copy of itself.
   *
   * MEASURED AND REPORTED, NOT GATED ON. It is here because the couch that
   * fired in the field was not separable by anything else at the time - it
   * scores 3.8 against a receipt's 24.7 - but the same figure puts a faded
   * receipt at 6.0, below a monitor's 8.2, and a keyboard at 24.7, level with a
   * receipt. So on its own it is useless, and as a ratio against contrast it
   * looks promising on synthetic scenes and would be a fifth way to refuse a
   * real receipt if it is wrong. It is reported by `?tune=1` so the decision
   * can be made from receipts rather than from fixtures.
   */
  print: number;
  /** All of the above, and enough frames seen to mean it. */
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
  hasSubject: false,
  paperFill: 0,
  paperSpread: 1,
  ink: 0,
  inkContrast: 0,
  print: 0,
  ready: false,
  diff: 0,
  median: 0,
  threshold: MAX_THRESHOLD,
  baseline: 0,
  detail: 0,
  motionRatio: 1,
};

/**
 * Otsu's threshold: the brightness that best separates the picture into two
 * groups. A receipt splits cleanly into ink and paper; a uniform surface has no
 * real split at all, and `valid` says which happened.
 *
 * `valid` comes from the between-class variance being positive, NOT from the
 * threshold's value. A guard on `split === 0` looked equivalent and was not: a
 * strongly exposed receipt whose ink is genuinely black legitimately splits at
 * 0, so the best-contrast receipt of all was the one being thrown away.
 */
function brightnessSplit(histogram: Uint32Array, count: number): { split: number; valid: boolean } {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];
  let sumBack = 0;
  let weightBack = 0;
  let best = 0;
  let bestVariance = -1;
  for (let v = 0; v < 256; v++) {
    weightBack += histogram[v];
    if (weightBack === 0) continue;
    const weightFore = count - weightBack;
    if (weightFore === 0) break;
    sumBack += v * histogram[v];
    const meanBack = sumBack / weightBack;
    const meanFore = (sum - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) * (meanBack - meanFore);
    if (between > bestVariance) {
      bestVariance = between;
      best = v;
    }
  }
  return { split: best, valid: bestVariance > 0 };
}

/**
 * Whether the bright part of the picture is shaped like a sheet of paper.
 *
 * Two things, measured per row of the downscaled frame, and both are needed:
 *
 *   COVERAGE - between its first and last bright pixel, is the row mostly
 *   bright? Paper is solid. A wooden desk, foliage or a printed dashboard
 *   scatter bright pixels across the whole width and cover about half of it.
 *
 *   CONSISTENCY - do those rows start and end in the same place? A receipt is a
 *   band of constant width; a hand, a mug or a face is a blob whose width
 *   changes from row to row.
 *
 * Neither alone is enough, and the measurements say so: a desk is consistent
 * (every row spans the full width) but not covered, and a hand is covered but
 * not consistent.
 *
 * It is still not document recognition. A book, a napkin, a sheet of A4 or a
 * white van door would all pass, and nothing short of a vision model would tell
 * them from a receipt. What it does is answer "is something paper-shaped in
 * view", which is what was being got wrong.
 */
function paperShapeOf(
  luma: Uint8Array,
  width: number,
  height: number,
): { fill: number; spread: number; ink: number; inkContrast: number } {
  const count = width * height;
  const histogram = new Uint32Array(256);
  for (let p = 0; p < count; p++) histogram[luma[p]]++;
  // A frame with no bright/dark boundary at all - a blank wall, a lens flat
  // against a desk - has nothing to find. Reported as "not paper" rather than
  // as a perfect sheet, which is what the diagnostics used to say about it.
  const { split, valid } = brightnessSplit(histogram, count);
  if (!valid) return BLANK_SHAPE;

  // Per-row spans, with a marker for rows that do not qualify, so the longest
  // continuous band can be found and then MEASURED - rather than admitted on
  // continuity and then measured over every stray bright row in the frame,
  // which let unrelated bands rescue a weak region or spoil a good one.
  const lefts = new Int32Array(height).fill(-1);
  const widths = new Int32Array(height);
  const coverages = new Float64Array(height);

  // Bright pixel positions for the row being examined, reused each row.
  const positions = new Int32Array(width);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let bright = 0;
    for (let x = 0; x < width; x++) {
      if (luma[row + x] > split) positions[bright++] = x;
    }
    if (bright === 0) continue;

    // The band's edges come from the tenth and ninetieth percentile of its
    // bright pixels, not from the first and last.
    //
    // A receipt on a workbench was the case that forced this. The wood's bright
    // ridges reach past the split, so a few of them at each end of every row
    // stretched the span across the whole frame and halved the coverage - and
    // the sheet in the middle was rejected. Trimming a tenth from each end
    // discards that scatter and leaves the solid block.
    const loIndex = Math.floor((bright - 1) * 0.1);
    const hiIndex = Math.ceil((bright - 1) * 0.9);
    const lo = positions[loIndex];
    const hi = positions[hiIndex];
    const span = hi - lo + 1;
    // A row so thin it cannot be part of a sheet, or so sparse that it is
    // texture rather than paper, tells us nothing either way.
    if (span < width * 0.1) continue;
    // The pixels actually retained, counted rather than assumed to be four
    // fifths. Rounding keeps more than that - ten bright pixels give indices 0
    // and 9, so all ten - and calling it 0.8 understated every row's coverage,
    // which is the wrong direction: it rejects marginal receipts.
    const coverage = (hiIndex - loIndex + 1) / span;
    if (coverage < MIN_ROW_COVERAGE) continue;
    lefts[y] = lo;
    widths[y] = span;
    coverages[y] = coverage;
  }

  // The longest continuous band, which is the only part measured.
  let runStart = 0;
  let runLength = 0;
  let bestStart = 0;
  let bestLength = 0;
  for (let y = 0; y < height; y++) {
    if (lefts[y] < 0) {
      runLength = 0;
      continue;
    }
    if (runLength === 0) runStart = y;
    runLength++;
    if (runLength > bestLength) {
      bestLength = runLength;
      bestStart = runStart;
    }
  }

  // Too little of the frame is a continuous band to call it a sheet.
  //
  // Roughly a sixth, down from a quarter. A till receipt held a little further
  // away, or lying across the corner of the frame, occupies less than a quarter
  // and was refused for it. Note this is the longest UNBROKEN run of qualifying
  // rows, not the sheet's total height, so a sheet whose rows fragment can
  // still fall short of it.
  if (bestLength < height * 0.16) return BLANK_SHAPE;

  const bandLefts: number[] = [];
  const bandWidths: number[] = [];
  const bandCoverage: number[] = [];
  for (let y = bestStart; y < bestStart + bestLength; y++) {
    bandLefts.push(lefts[y]);
    bandWidths.push(widths[y]);
    bandCoverage.push(coverages[y]);
  }

  const fill = median(bandCoverage);
  // How much the band wanders, as a fraction of the frame. Zero is a perfect
  // rectangle.
  const midLeft = median(bandLefts);
  const midWidth = median(bandWidths);
  let wander = 0;
  for (let i = 0; i < bandLefts.length; i++) {
    wander += Math.abs(bandLefts[i] - midLeft) + Math.abs(bandWidths[i] - midWidth);
  }
  const spread = wander / (bandLefts.length * width);

  // Now the question the shape cannot answer: is anything WRITTEN on it.
  //
  // Measured on a FLAT-FIELDED copy of the band: each pixel minus a local
  // average of its neighbours. That subtracts whatever varies slowly across the
  // sheet, which is mostly the lighting, and leaves what varies quickly, which
  // is mostly the print. It is not a refinement - without it the
  // split follows the light rather than the print. A hand's shadow across half
  // a receipt, a desk lamp from one side, glare on one edge: each puts half the
  // sheet in one class and half in the other, so a plainly printed receipt
  // reads as a two-tone object and is refused. All three were reproduced.
  //
  // The window is wide compared to a stroke of text and narrow compared to a
  // shadow, which is what lets it tell them apart.
  // A separable box blur over the band, done with running sums: two passes of
  // O(n) rather than one of O(n x 81). At the resolution the subject frame now
  // needs, the naive version would be two million operations per camera frame.
  const RADIUS = 4;
  const bandW = width;
  const bandH = bestLength;
  const src = new Float64Array(bandW * bandH);
  const inBand = new Uint8Array(bandW * bandH);
  for (let i = 0; i < bandH; i++) {
    const y = bestStart + i;
    const from = lefts[y];
    if (from < 0) continue;
    const to = from + widths[y] - 1;
    const row = y * width;
    for (let x = from; x <= to; x++) {
      src[i * bandW + x] = luma[row + x];
      inBand[i * bandW + x] = 1;
    }
  }

  // Horizontal, then vertical, each carrying a running sum and a running count
  // so pixels outside the band contribute nothing rather than contributing
  // background - which on a slanted sheet is what left fictitious print on
  // blank paper.
  const hSum = new Float64Array(bandW * bandH);
  const hCount = new Float64Array(bandW * bandH);
  for (let i = 0; i < bandH; i++) {
    let sum = 0;
    let n = 0;
    const base = i * bandW;
    for (let x = 0; x < bandW + RADIUS; x++) {
      if (x < bandW && inBand[base + x]) {
        sum += src[base + x];
        n++;
      }
      const drop = x - 2 * RADIUS - 1;
      if (drop >= 0 && inBand[base + drop]) {
        sum -= src[base + drop];
        n--;
      }
      const at = x - RADIUS;
      if (at >= 0 && at < bandW) {
        hSum[base + at] = sum;
        hCount[base + at] = n;
      }
    }
  }

  const flat: number[] = [];
  for (let x = 0; x < bandW; x++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < bandH + RADIUS; i++) {
      if (i < bandH) {
        sum += hSum[i * bandW + x];
        n += hCount[i * bandW + x];
      }
      const drop = i - 2 * RADIUS - 1;
      if (drop >= 0) {
        sum -= hSum[drop * bandW + x];
        n -= hCount[drop * bandW + x];
      }
      const at = i - RADIUS;
      if (at >= 0 && at < bandH && inBand[at * bandW + x] && n > 0) {
        // Centred on 128 so the histogram below can be built as usual.
        flat.push(Math.max(0, Math.min(255, 128 + src[at * bandW + x] - sum / n)));
      }
    }
  }

  const bandHistogram = new Uint32Array(256);
  for (const v of flat) bandHistogram[Math.round(v)]++;
  const bandCount = flat.length;
  const inner = brightnessSplit(bandHistogram, bandCount);
  if (!inner.valid || bandCount === 0) return { fill, spread, ink: 0, inkContrast: 0 };

  let darkCount = 0;
  let darkTotal = 0;
  let lightCount = 0;
  let lightTotal = 0;
  for (let v = 0; v < 256; v++) {
    const bin = bandHistogram[v];
    if (bin === 0) continue;
    if (v <= inner.split) {
      darkCount += bin;
      darkTotal += v * bin;
    } else {
      lightCount += bin;
      lightTotal += v * bin;
    }
  }
  // The MINORITY population, whichever side of the split it landed on.
  //
  // Polarity is not knowable in advance. Glare blowing one edge to white flips
  // it - the flat-fielded "dark" class became 92% of a plainly printed receipt
  // and it was refused. White text on a dark ticket would do the same. What is
  // true either way is that the marks are the minority and the stock is the
  // majority.
  const darkFraction = darkCount / bandCount;
  const ink = Math.min(darkFraction, 1 - darkFraction);
  const inkContrast =
    darkCount > 0 && lightCount > 0 ? lightTotal / lightCount - darkTotal / darkCount : 0;

  return { fill, spread, ink, inkContrast };
}

/** Nothing here looks like a sheet of anything. */
const BLANK_SHAPE = { fill: 0, spread: 1, ink: 0, inkContrast: 0 };

/** How much the picture differs from a blurred copy of itself. See `print`. */
function printEnergyOf(luma: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * width + x;
        acc += luma[row - 1] + luma[row] + luma[row + 1];
      }
      sum += Math.abs(luma[y * width + x] - acc / 9);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** RGBA to brightness. The exact weights do not matter for either question. */
function toLuma(rgba: Uint8ClampedArray, count: number): Uint8Array {
  const luma = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    luma[p] = (rgba[i] + 2 * rgba[i + 1] + rgba[i + 2]) >> 2;
  }
  return luma;
}

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
  private subjects: number[] = [];
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
    this.subjects = [];
    this.baselineSamples = [];
    this.last = BLIND;
  }

  /**
   * Feed one frame of RGBA pixels and get a verdict.
   *
   * Brightness rather than a single channel: red alone made a white receipt
   * under a warm light look noisier than it was.
   */
  /**
   * @param subject A SECOND, larger frame for the subject test.
   *
   * Movement is measured at 64x48 because that is plenty to see a picture
   * change and it has to run on every camera frame. Deciding whether the thing
   * in view is a printed receipt does not survive that downscale: a real
   * receipt filling the frame measures an ink contrast of 14 at 64x48, 27 at
   * 128x96 and 48 at 192x144. At the smallest size the print is smeared into
   * grey and a genuine receipt reads as blank, which is what was reported from
   * the field. Omit it and the movement frame is used, which is what the
   * fixtures do - their "text" is coarse enough to survive.
   */
  push(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    subject?: { rgba: Uint8ClampedArray; width: number; height: number },
  ): StabilityReading {
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

    const luma = toLuma(rgba, count);

    // The frame the subject is judged on, which may be a larger one.
    //
    // Pixels and dimensions are chosen TOGETHER. Falling back to the movement
    // frame's pixels while keeping the subject frame's dimensions read past the
    // end of the array and produced NaN measurements, which fail every
    // comparison silently - a receipt going from firing to not, with nothing on
    // screen to say why.
    const usable =
      subject !== undefined &&
      Number.isInteger(subject.width) &&
      Number.isInteger(subject.height) &&
      subject.width > 0 &&
      subject.height > 0 &&
      subject.rgba.length >= subject.width * subject.height * 4;
    const subjectWidth = usable ? subject!.width : width;
    const subjectHeight = usable ? subject!.height : height;
    const subjectLuma = usable ? toLuma(subject!.rgba, subjectWidth * subjectHeight) : luma;

    // Standard deviation of brightness, over the subject frame. Ink against paper drives this a long
    // way up - about 79 for crisp print - while a uniform surface stays much
    // lower: 3.5 at ordinary sensor noise, though heavy noise in near-darkness
    // can lift it to 11 or so and past the gate. A neighbouring-pixel gradient
    // could not tell the two apart at all, because noise IS high-frequency
    // detail.
    let total = 0;
    for (let p = 0; p < subjectLuma.length; p++) total += subjectLuma[p];
    const mean = total / subjectLuma.length;
    let variance = 0;
    for (let p = 0; p < subjectLuma.length; p++) {
      const d = subjectLuma[p] - mean;
      variance += d * d;
    }
    const detail = Math.sqrt(variance / subjectLuma.length);

    const paper = paperShapeOf(subjectLuma, subjectWidth, subjectHeight);
    const print = printEnergyOf(subjectLuma, subjectWidth, subjectHeight);
    // This frame's opinion of the subject: enough contrast AND paper-shaped.
    // The verdict below is taken over a window of them.
    const subjectNow =
      detail >= MIN_DETAIL &&
      paper.fill >= MIN_PAPER_FILL &&
      paper.spread <= MAX_PAPER_SPREAD &&
      paper.inkContrast >= MIN_INK_CONTRAST &&
      paper.ink >= MIN_INK &&
      paper.ink <= MAX_INK;
    this.subjects.push(subjectNow ? 1 : 0);
    if (this.subjects.length > SAMPLE_WINDOW) this.subjects.shift();
    // A MAJORITY of the recent window, not this frame.
    //
    // Every single-frame test in this file is softened this way, and for the
    // same reason each time: the countdown runs a second and a half, and
    // anything that resets it on one bad frame never completes. A finger
    // crossing the edge, a shadow, one frame where the exposure moved the
    // bright/dark split or the glare washed the contrast out - each is a frame
    // that says no, and demanding all of them say yes is exactly how this
    // feature came to never fire at all.
    const votes = this.subjects.reduce((a, b) => a + b, 0);
    const hasSubject = this.subjects.length >= SAMPLE_WINDOW && votes >= this.subjects.length * MIN_PAPER_VOTES;


    const previous = this.previous;
    if (!previous) {
      // The first frame has no movement to measure, so no verdict - but the
      // subject vote above has already counted it, which is what lets the
      // window fill from the very first frame the camera presents.
      this.previous = luma;
      this.last = { ...BLIND, detail, paperFill: paper.fill, paperSpread: paper.spread, ink: paper.ink, inkContrast: paper.inkContrast, print };
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
      hasSubject,
      paperFill: paper.fill,
      paperSpread: paper.spread,
      ink: paper.ink,
      inkContrast: paper.inkContrast,
      print,
      ready: steady && hasSubject,
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
