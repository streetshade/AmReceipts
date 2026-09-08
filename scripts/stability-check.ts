// Checks for auto-capture's "is it being held still" decision.
//
//   npm run check:stability
//
// The first version of this passed every desk test and then never fired once on
// a real phone - not on a receipt, not on anything. So these cases are built out
// of what a real camera actually produces: sensor noise on every frame, the
// occasional spike from an autofocus hunt, and a hand that is never perfectly
// still. A synthetic "perfectly static" frame is the one case that proves
// nothing, and it is the only one the old code would have passed.

import { StabilityDetector, type StabilityReading } from "../src/lib/stability";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const W = 64;
const H = 48;

/** A deterministic pseudo-random source, so a failure can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A frame of "printed text": vertical strokes, which is what a receipt is.
 *
 * Supersampled across each pixel, so a FRACTIONAL offset genuinely shifts the
 * image. An earlier version sampled the pattern at integer positions only, and
 * a drift of a quarter of a pixel produced a byte-identical frame - which made
 * the slow-drift cases look like passes when nothing had moved at all.
 */
function receipt(offset = 0, noise = 0, random = rng(1)): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  const SUB = 8;
  for (let y = 0; y < H; y++) {
    const line = y % 5 !== 4;
    for (let x = 0; x < W; x++) {
      let ink = 0;
      for (let s = 0; s < SUB; s++) {
        const sx = x + s / SUB + offset;
        if (line && ((sx % 7) + 7) % 7 < 2) ink++;
      }
      let v = 225 - (ink / SUB) * 185;
      if (noise) v += (random() - 0.5) * 2 * noise;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
      data[i + 3] = 255;
    }
  }
  return data;
}

/** A bare table: uniform, with only sensor noise on it. */
function blank(noise = 0, random = rng(2)): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const v = 150 + (noise ? (random() - 0.5) * 2 * noise : 0);
    const i = p * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
    data[i + 3] = 255;
  }
  return data;
}

function run(frames: Uint8ClampedArray[]): StabilityReading {
  const d = new StabilityDetector();
  let last = d.push(frames[0], W, H);
  for (let i = 1; i < frames.length; i++) last = d.push(frames[i], W, H);
  return last;
}

const repeat = (n: number, make: (i: number) => Uint8ClampedArray) =>
  Array.from({ length: n }, (_, i) => make(i));

// ------------------------------------------------------------- holding still

const r1 = rng(11);
const handheld = run(repeat(60, () => receipt(0, 6, r1)));
check("a receipt held still, with ordinary sensor noise, fires", handheld.ready, JSON.stringify(handheld));
check("  and reports itself steady", handheld.steady);
check("  and sees a subject", handheld.hasSubject, String(handheld.detail));
// The distinction that matters, and the reason this is a spread and not a
// gradient: uncorrelated sensor noise is itself high-frequency detail, so a
// bare surface under a noisy camera looked exactly like printed text.
const r6b = rng(21);
const noisyTable = run(repeat(60, () => blank(15, r6b)));
check("a bare surface in a dim room is still not mistaken for a subject", !noisyTable.hasSubject, String(noisyTable.detail));
// The other end of the same trade. A thermal receipt faded until ink and paper
// are only 25 levels apart still has to fire; that is the direction worth being
// wrong in, and it is why the gate sits below what a bare surface reaches in
// near-darkness.
{
  const r = rng(22);
  const faded = run(repeat(60, () => {
    const f = receipt(0, 6, r);
    for (let p = 0; p < f.length; p += 4) {
      const ink = (225 - f[p]) / 185;
      f[p] = f[p + 1] = f[p + 2] = 225 - ink * 25;
    }
    return f;
  }));
  check("a badly faded receipt still fires", faded.ready, `contrast ${faded.detail.toFixed(1)}`);
}

// THE regression. One spike in the middle of a second of stillness is a
// heartbeat or an autofocus hunt, and the old code threw the whole second away.
const r2 = rng(12);
const withSpike = repeat(60, (i) => (i === 40 ? receipt(3, 6, r2) : receipt(0, 6, r2)));
const spiked = run(withSpike);
check("one spike in a second of stillness does not reset it", spiked.ready, JSON.stringify(spiked));

// A noisy camera in poor light: the baseline rises, and so does the bar.
const r3 = rng(13);
const noisy = run(repeat(60, () => receipt(0, 18, r3)));
check("a noisy camera calibrates to its own noise and still fires", noisy.ready, JSON.stringify(noisy));
check("  by raising the threshold rather than ignoring movement", noisy.threshold > handheld.threshold);

// --------------------------------------------------------------- moving

const r4 = rng(14);
const panning = run(repeat(60, (i) => receipt(i * 2, 6, r4)));
check("a moving picture does not fire", !panning.ready, JSON.stringify(panning));
check("  and says it is not steady", !panning.steady);

// The ceiling: a phone that is never still must not raise its own bar until
// waving it about counts as holding it.
const r5 = rng(15);
const shaken = run(repeat(200, (i) => receipt(i * 3, 25, r5)));
check("a phone waved about never calibrates its way into firing", !shaken.ready, JSON.stringify(shaken));
check("  because the threshold is capped", shaken.threshold <= 24, String(shaken.threshold));

// ------------------------------------- a real camera's own processing

// Everything below is a STATIONARY phone whose picture still changes, because
// the camera is doing something to it. Each one must still fire: a detector
// that refuses to shoot a receipt held perfectly still is the failure this file
// exists to catch, and it is the one that already shipped once.

// Temporal denoising and rolling gain correlate one frame with the next, so the
// two-frame difference is no longer the same size as the one-frame difference.
// Independent noise gives a ratio near 1; correlated noise reaches about 1.41.
{
  const r = rng(60);
  let carry = 0;
  const frames = repeat(80, () => {
    carry = carry * 0.7 + (r() - 0.5) * 10;      // an AR(1) noise process
    return receipt(0, 0, r).map((v, i) => (i % 4 === 3 ? v : v + carry)) as Uint8ClampedArray;
  });
  const correlated = run(frames.map((f) => Uint8ClampedArray.from(f)));
  check(
    "a still phone with temporally correlated noise still fires",
    correlated.ready,
    `ratio ${correlated.motionRatio.toFixed(2)} median ${correlated.median.toFixed(2)}`,
  );
}

// Auto-exposure settling, or a cloud passing: the whole frame brightens
// smoothly, which is perfectly correlated and looks exactly like drift to a
// ratio test.
{
  const r = rng(61);
  const ramp = run(repeat(80, (i) => {
    const f = receipt(0, 5, r);
    for (let p = 0; p < f.length; p += 4) {
      f[p] = Math.min(255, f[p] + i * 0.35);
      f[p + 1] = Math.min(255, f[p + 1] + i * 0.35);
      f[p + 2] = Math.min(255, f[p + 2] + i * 0.35);
    }
    return f;
  }));
  check(
    "a still phone through an exposure ramp still fires",
    ramp.ready,
    `ratio ${ramp.motionRatio.toFixed(2)} median ${ramp.median.toFixed(2)}`,
  );
}

// A very quiet camera. The ratio is meaningless down here and must not be
// allowed to block: whatever it says, a picture changing this little will
// photograph sharply.
{
  const r = rng(62);
  const quiet = run(repeat(60, () => receipt(0, 1, r)));
  check("an almost noiseless camera fires whatever the ratio says", quiet.ready,
    `ratio ${quiet.motionRatio.toFixed(2)} median ${quiet.median.toFixed(2)}`);
}

// ------------------------------------------------- slow drift, and duplicates

// A hand panning slowly and steadily. The threshold calibrates itself from the
// quietest recent frame, and with no genuinely quiet frame to find it would
// calibrate from the movement itself and pronounce it stillness. Every speed
// here sits UNDER the absolute ceiling, so only the two-frame ratio can catch
// them - which is the whole reason it exists.
let slowFired = 0;
for (const speed of [0.25, 0.4, 0.6, 0.9, 1.5]) {
  const r = rng(30 + speed * 100);
  const drift = run(repeat(120, (i) => receipt(i * speed, 6, r)));
  const caught = !drift.ready;
  check(
    `a slow steady drift of ${speed}px per frame is not called stillness`,
    caught,
    `median ${drift.median.toFixed(2)} threshold ${drift.threshold.toFixed(2)} ratio ${drift.motionRatio.toFixed(2)}`,
  );
  if (!caught) slowFired++;
}
check("no drift speed slipped through", slowFired === 0);

// And the deliberate limit of that, stated rather than discovered later: below
// about a quarter of a pixel per frame, drift is indistinguishable from a still
// phone's own correlated noise, and this fires. That is the chosen direction to
// be wrong in - the receipt crosses the frame in twenty seconds, the photograph
// is sharp, and a still phone that refuses to fire is the failure that was
// actually reported.
{
  const r = rng(70);
  const veryslow = run(repeat(120, (i) => receipt(i * 0.15, 6, r)));
  check(
    "drift too slow to blur is allowed through, knowingly",
    veryslow.ready,
    `median ${veryslow.median.toFixed(2)} ratio ${veryslow.motionRatio.toFixed(2)}`,
  );
}

// A very noisy camera - a dim room, a high ISO - is not a moving one. The
// ceiling on the threshold used to sit below what such a camera produces while
// perfectly still, so it never fired.
{
  const r = rng(71);
  const dim = run(repeat(120, () => receipt(0, 30, r)));
  check("a still phone in a dim room fires", dim.ready,
    `median ${dim.median.toFixed(2)} threshold ${dim.threshold.toFixed(2)}`);
}

// And the ratio must not condemn a still camera: noise across two frames is the
// same size as across one, so the ratio sits near 1.
const r8 = rng(40);
const stillRatio = run(repeat(60, () => receipt(0, 10, r8)));
check("a still noisy camera has a ratio near 1", stillRatio.motionRatio < 1.35, String(stillRatio.motionRatio));
check("  so it still fires", stillRatio.ready);

// Duplicate frames are deliberately NOT handled here. The detector takes a
// frame that did not change as a change of zero, which is true; discarding
// luma-identical frames instead meant a very clean camera, or aggressive
// denoising, could stop the window ever filling and nothing would ever fire.
// Keeping duplicates out is the caller's job, and `CapturePanel` does it by
// waiting on `requestVideoFrameCallback` or on the media clock advancing.

// ------------------------------------------------------------- what is in view

const r6 = rng(16);
const table = run(repeat(60, () => blank(6, r6)));
check("a bare table held still does not fire", !table.ready, JSON.stringify(table));
check("  because there is no contrast in it", !table.hasSubject, String(table.detail));
check("  even though it is perfectly steady", table.steady);

const covered = run(repeat(60, () => blank(0)));
check("a covered lens does not fire", !covered.ready);

// -------------------------------------------------------- is it paper?

// Contrast alone said yes to anything textured, and in the field the phone
// photographed the desk it was lying on. These are the scenes it has to tell
// apart, and both halves matter: everything a receipt is must fire, and
// everything a job site is must not.

/** A scene, still, with sensor noise, run until the detector has an opinion. */
function scene(px: (x: number, y: number, noise: () => number) => number, seed: number): StabilityReading {
  const random = rng(seed);
  const make = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = Math.max(0, Math.min(255, px(x, y, random)));
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return data;
  };
  const d = new StabilityDetector();
  let last = d.push(make(), W, H);
  for (let i = 0; i < 40; i++) last = d.push(make(), W, H);
  return last;
}

const print = (x: number, y: number) => (x % 7 < 2 && y % 5 !== 4 ? 60 : 230);
const onDark = (inside: boolean, x: number, y: number, n: () => number) =>
  (inside ? print(x, y) : 40) + (n() - 0.5) * 12;

const fires: [string, StabilityReading][] = [
  ["a receipt filling the frame", scene((x, y, n) => print(x, y) + (n() - 0.5) * 12, 90)],
  ["a receipt on a dark surface", scene((x, y, n) => onDark(x > 12 && x < 52 && y > 6 && y < 42, x, y, n), 91)],
  ["a receipt held at 11 degrees", scene((x, y, n) => { const sx = Math.round(x - (y - 24) * 0.2);
    return onDark(sx > 12 && sx < 52 && y > 5 && y < 43, sx, y, n); }, 92)],
  ["a receipt held at 31 degrees", scene((x, y, n) => { const sx = Math.round(x - (y - 24) * 0.6);
    return onDark(sx > 12 && sx < 52 && y > 5 && y < 43, sx, y, n); }, 93)],
  ["a receipt half out of frame", scene((x, y, n) => onDark(x < 34 && y > 6 && y < 42, x, y, n), 94)],
  ["a small receipt in the middle", scene((x, y, n) => onDark(x > 22 && x < 42 && y > 14 && y < 34, x, y, n), 95)],
  ["a faded receipt", scene((x, y, n) => (x % 7 < 2 && y % 5 !== 4 ? 200 : 225) + (n() - 0.5) * 10, 96)],
];
for (const [name, r] of fires) {
  check(`${name} fires`, r.ready, `fill ${r.paperFill.toFixed(2)} wander ${r.paperSpread.toFixed(3)} contrast ${r.detail.toFixed(0)}`);
}

const refuses: [string, StabilityReading][] = [
  ["a wooden desk", scene((x, y, n) => 120 + Math.sin(x * 0.7 + y * 0.2) * 45 + Math.sin(y * 1.9) * 20 + (n() - 0.5) * 30, 97)],
  ["a dashboard with markings", scene((x, y, n) => (Math.sin(x * 0.4) * Math.cos(y * 0.5) > 0.3 ? 190 : 70) + (n() - 0.5) * 25, 98)],
  ["a blank wall", scene((_x, _y, n) => 150 + (n() - 0.5) * 16, 99)],
  ["a hand", scene((x, y, n) => ((x - 30) ** 2 / 900 + (y - 24) ** 2 / 400 < 1 ? 170 : 60) + Math.sin(x * 2.2) * 12 + (n() - 0.5) * 18, 100)],
  ["a cluttered background", scene((x, y, n) => 100 + Math.sin(x * 1.3) * 60 + Math.cos(y * 1.7) * 50 + (n() - 0.5) * 40, 101)],
  ["a keyboard", scene((x, y, n) => (x % 6 < 4 && y % 7 < 5 ? 90 : 180) + (n() - 0.5) * 20, 102)],
];
for (const [name, r] of refuses) {
  check(`${name} does not`, !r.ready, `fill ${r.paperFill.toFixed(2)} wander ${r.paperSpread.toFixed(3)}`);
}

// Stated rather than left to be discovered: a bright solid object of roughly
// constant width passes. A mug measures 0.097 against an angled receipt's
// 0.090, and no line separates them. Refusing a receipt held at a slant is the
// worse mistake, and a stray photograph is one tap to delete.
{
  const mug = scene((x, y, n) => ((x - 32) ** 2 / 200 + (y - 26) ** 2 / 260 < 1 ? 215 : 110 + Math.sin(x * 0.8) * 30) + (n() - 0.5) * 20, 103);
  check("a mug is knowingly allowed through", mug.ready, `wander ${mug.paperSpread.toFixed(3)}`);
}

// The reason the paper verdict is a vote and not a per-frame test. A finger at
// the edge, a shadow, one frame where the exposure moved the bright/dark split
// - each is a frame that does not look like a sheet, and an all-or-nothing gate
// is how this feature came to never fire at all the first time.
{
  const random = rng(110);
  const d = new StabilityDetector();
  const paper = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 5 !== 4 ? 60 : 230) : 40) + (random() - 0.5) * 12;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
      data[i + 3] = 255;
    }
    return data;
  };
  const smudged = () => {
    // The same scene with a thumb across the lower third.
    const data = paper();
    for (let y = 32; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 120 + (random() - 0.5) * 30;
    }
    return data;
  };
  let last: StabilityReading | null = null;
  for (let i = 0; i < 60; i++) last = d.push(i % 9 === 0 ? smudged() : paper(), W, H);
  check("one obscured frame in nine does not stop it firing", Boolean(last?.ready),
    `fill ${last?.paperFill.toFixed(2)} wander ${last?.paperSpread.toFixed(3)}`);

  // But a subject that is mostly obscured is not a subject.
  const d2 = new StabilityDetector();
  let mostly: StabilityReading | null = null;
  for (let i = 0; i < 60; i++) mostly = d2.push(i % 3 === 0 ? paper() : smudged(), W, H);
  check("a subject obscured most of the time does not fire", !mostly?.ready);
}

// The best-contrast receipt of all: genuinely black ink on genuinely white
// paper. Otsu legitimately splits that at 0, and a guard written as
// `split === 0` threw away exactly the case the feature exists for.
{
  const pure = scene((x, y) => (x % 7 < 2 && y % 5 !== 4 ? 0 : 255), 112);
  check("a pure black-on-white receipt fires", pure.ready,
    `fill ${pure.paperFill.toFixed(2)} wander ${pure.paperSpread.toFixed(3)}`);
}

// An exactly uniform frame - no noise at all to give Otsu anything to find.
{
  const flat = scene(() => 200, 113);
  check("an exactly uniform frame is not called paper", !flat.hasSubject,
    `fill ${flat.paperFill.toFixed(2)}`);
}

// Only the continuous band is measured. Stray bright rows above and below a
// good sheet used to be averaged in with it, and could spoil a receipt that was
// perfectly well framed.
{
  const withStrays = scene((x, y, n) => {
    if (y === 1 || y === 45) return (x > 2 && x < 20 ? 240 : 40) + (n() - 0.5) * 10;   // unrelated bands
    const inside = x > 12 && x < 52 && y > 8 && y < 40;
    return (inside ? (x % 7 < 2 && y % 5 !== 4 ? 60 : 230) : 40) + (n() - 0.5) * 12;
  }, 114);
  check("stray bright rows outside the sheet do not spoil it", withStrays.ready,
    `fill ${withStrays.paperFill.toFixed(2)} wander ${withStrays.paperSpread.toFixed(3)}`);
}

// Where receipts actually are: on a workbench. A textured background scatters
// bright pixels to both edges of every row, so every background row used to
// qualify on span alone, the "longest band" swallowed the frame, and the
// half-covered background rows dragged the median down and rejected the sheet.
{
  const onWood = scene((x, y, n) => {
    const inside = x > 14 && x < 50 && y > 10 && y < 38;
    if (inside) return (x % 7 < 2 && y % 5 !== 4 ? 60 : 235) + (n() - 0.5) * 12;
    return 120 + Math.sin(x * 0.7 + y * 0.2) * 45 + Math.sin(y * 1.9) * 20 + (n() - 0.5) * 30;
  }, 115);
  check("a receipt on a wooden bench fires", onWood.ready,
    `fill ${onWood.paperFill.toFixed(2)} wander ${onWood.paperSpread.toFixed(3)}`);
}

// And the bench on its own still does not.
{
  const bench = scene((x, y, n) => 120 + Math.sin(x * 0.7 + y * 0.2) * 45 + Math.sin(y * 1.9) * 20 + (n() - 0.5) * 30, 116);
  check("the bench on its own still does not", !bench.ready);
}

// A blank frame must not be reported as a perfect sheet, even in the
// diagnostics: Otsu finds no split in it and every pixel lands on one side.
{
  const blankWhite = scene((_x, _y, n) => 250 + (n() - 0.5) * 4, 111);
  check("a blank bright frame is not called paper", !blankWhite.hasSubject,
    `fill ${blankWhite.paperFill.toFixed(2)} wander ${blankWhite.paperSpread.toFixed(3)}`);
}

// ------------------------------------------------------------------ warm-up

const d = new StabilityDetector();
const r7 = rng(17);
check("the very first frame cannot fire", !d.push(receipt(0, 6, r7), W, H).ready);
let early: StabilityReading | null = null;
for (let i = 0; i < 5; i++) early = d.push(receipt(0, 6, r7), W, H);
check("nor can a handful of frames", !early?.ready, "needs a full window before it will commit");
let later: StabilityReading | null = null;
for (let i = 0; i < 40; i++) later = d.push(receipt(0, 6, r7), W, H);
check("but a full window of stillness does", Boolean(later?.ready));

// Reset must genuinely forget, or the frame after a shot inherits the
// stillness that caused it and fires again immediately.
d.reset();
check("a reset forgets everything", !d.push(receipt(0, 6, r7), W, H).ready);

// --------------------------------------------------------------- robustness

// A camera renegotiating its resolution, or a phone turned on its side. The
// mismatched compare used to read past the end of the previous frame, and the
// NaN it produced sat in the baseline window for three seconds during which
// nothing could fire - the never-fires signature exactly.
{
  const d2 = new StabilityDetector();
  const r = rng(80);
  for (let i = 0; i < 40; i++) d2.push(receipt(0, 6, r), W, H);
  const small = new Uint8ClampedArray(32 * 24 * 4).fill(200);
  const afterResize = d2.push(small, 32, 24);
  check("a change of frame size does not poison it", Number.isFinite(afterResize.diff) && !afterResize.ready);
  let back: StabilityReading | null = null;
  for (let i = 0; i < 40; i++) back = d2.push(receipt(0, 6, r), W, H);
  check("  and it recovers on the next steady second", Boolean(back?.ready), JSON.stringify(back));
}

check("an empty frame is refused rather than throwing", !new StabilityDetector().push(new Uint8ClampedArray(0), 0, 0).ready);
check(
  "a frame shorter than its own dimensions is refused",
  !new StabilityDetector().push(new Uint8ClampedArray(16), W, H).ready,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
