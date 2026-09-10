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

// A mug used to be let through knowingly, on the grounds that its outline is as
// rectangular as an angled receipt's. It is refused now, and for the right
// reason rather than by luck: nothing is printed on it.
{
  const mug = scene((x, y, n) => ((x - 32) ** 2 / 200 + (y - 26) ** 2 / 260 < 1 ? 215 : 110 + Math.sin(x * 0.8) * 30) + (n() - 0.5) * 20, 103);
  check("a mug does not fire", !mug.ready, `fill ${mug.paperFill.toFixed(2)} wander ${mug.paperSpread.toFixed(3)}`);
}

// ------------------------------------------------- what actually fired

// Five false captures reported from a real room, and the measurement that was
// missing. Four of the five have a fill of exactly 1.00: what had been built
// was a test for "a bright solid rectangle", and a room is full of those. Paper
// is distinguished by having something PRINTED on it, which breaks the bright
// field up. A receipt scores 0.69 to 0.79.
const room: [string, StabilityReading][] = [
  ["a monitor", scene((x, y, n) => (x > 8 && x < 56 && y > 8 && y < 40 ? 215 : 45) + (n() - 0.5) * 10, 120)],
  ["a laptop screen", scene((x, y, n) => (x > 10 && x < 54 && y > 4 && y < 30 ? 205 : 60) + (n() - 0.5) * 12, 121)],
  ["a keyboard on a desk", scene((x, y, n) => (y > 14 && y < 36 ? (x % 5 < 4 && y % 6 < 5 ? 55 : 185) : 195) + (n() - 0.5) * 14, 122)],
  ["a laptop on the ground", scene((x, y, n) => (x > 14 && x < 50 && y > 12 && y < 38 ? 200 : 55) + (n() - 0.5) * 14, 123)],
  ["a pale empty desk", scene((x, _y, n) => 190 + Math.sin(x * 0.15) * 8 + (n() - 0.5) * 12, 124)],
];
for (const [name, r] of room) {
  check(`${name} does not fire`, !r.ready, `fill ${r.paperFill.toFixed(2)} print ${r.print.toFixed(1)}`);
}

// The fifth, and the one that shape alone could never refuse: a couch has a
// perfectly receipt-like outline. What it does not have is print. Its two
// brightness populations are 39% and 61% of the sheet - a two-tone object -
// where ink covers between 4% and 25% of every receipt here.
{
  const couch = scene((x, y, n) => 130 + Math.sin(x * 0.18 + y * 0.1) * 38 + Math.sin(y * 0.24) * 22 + (n() - 0.5) * 16, 125);
  check("a couch does not fire", !couch.ready,
    `ink ${couch.ink.toFixed(3)} inkContrast ${couch.inkContrast.toFixed(0)} fill ${couch.paperFill.toFixed(2)}`);
}

// ------------------------------------------------- is anything written on it

// Two receipts that a previous attempt at this refused, both found by review
// rather than by me, and both reproduced before the fix. They are the reason
// ink is measured over the band's AREA and against the band's OWN brightness,
// rather than by how solid a typical row is.
{
  // Ordinary line spacing. Most rows of a real receipt are blank paper between
  // lines of text, so the median row is solid and the sheet reads as blank.
  const spaced = scene((x, y, n) => (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 5 < 2 ? 60 : 230) : 40) + (n() - 0.5) * 12, 130);
  check("a receipt with ordinary line spacing fires", spaced.ready,
    `ink ${spaced.ink.toFixed(3)} fill ${spaced.paperFill.toFixed(2)}`);

  const verySparse = scene((x, y, n) => (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 12 < 2 ? 60 : 230) : 40) + (n() - 0.5) * 12, 131);
  check("a receipt with very little on it fires", verySparse.ready, `ink ${verySparse.ink.toFixed(3)}`);

  // Faded ink on a dark background. Split globally, background goes one way and
  // the whole receipt - ink and paper together - goes the other, so the sheet
  // reads as blank. Split within the band, the ink is still there.
  const fadedOnDark = scene((x, y, n) => (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 5 !== 4 ? 200 : 230) : 40) + (n() - 0.5) * 12, 132);
  check("a faded receipt on a dark background fires", fadedOnDark.ready,
    `ink ${fadedOnDark.ink.toFixed(3)} inkContrast ${fadedOnDark.inkContrast.toFixed(0)}`);
}

// Lighting. Every one of these is the SAME printed receipt under a different
// lamp, and each was refused before the band was flat-fielded - the split
// followed the light instead of the ink, so half the sheet landed in each class
// and a plainly printed receipt read as a two-tone object.
{
  const faded = (x: number, y: number) => (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 8 < 2 ? 200 : 230) : 40);
  const even = scene((x, y, n) => faded(x, y) + (n() - 0.5) * 10, 140);
  check("a faded receipt under even light fires", even.ready, `ink ${even.ink.toFixed(3)}/${even.inkContrast.toFixed(0)}`);

  const shadowed = scene((x, y, n) => faded(x, y) - (x < 32 ? 20 : 0) + (n() - 0.5) * 10, 141);
  check("  with half of it in shadow, still fires", shadowed.ready, `ink ${shadowed.ink.toFixed(3)}`);

  const graded = scene((x, y, n) => faded(x, y) - (x / W) * 40 + (n() - 0.5) * 10, 142);
  check("  under a lamp from one side, still fires", graded.ready, `ink ${graded.ink.toFixed(3)}`);

  // A known limit, asserted rather than left to be found. A strip of glare
  // running the full height BESIDE the sheet is refused - not by the ink test,
  // which handles it, but by the shape test, because a bright mass of a
  // different height next to the paper is not a consistent rectangle. Loosening
  // that is what lets hands and blobs back in.
  const glared = scene((x, y, n) => (x > 40 ? 255 : faded(x, y)) + (n() - 0.5) * 10, 143);
  check("  but a full-height band of glare beside it is refused, knowingly", !glared.ready,
    `ink ${glared.ink.toFixed(3)}/${glared.inkContrast.toFixed(0)} wander ${glared.paperSpread.toFixed(3)}`);
}

// A BLANK sheet held at an angle must not read as printed. The flat-field pass
// sampled each row's neighbours using that row's own span, and on a slanted
// sheet the neighbouring rows sit elsewhere - so it reached off the paper into
// the background, and the residuals that left on blank paper were counted as
// print. A blank sheet at 11 degrees fired.
{
  const sheet = (printed: boolean, skew: number, seed: number) =>
    scene((x, y, n) => {
      const sx = Math.round(x - (y - 24) * skew);
      const on = sx > 12 && sx < 52 && y > 5 && y < 43;
      return (on ? (printed && sx % 7 < 2 && y % 5 !== 4 ? 60 : 230) : 40) + (n() - 0.5) * 10;
    }, seed);
  for (const skew of [0, 0.2, 0.36]) {
    const blank = sheet(false, skew, 150 + skew * 100);
    check(`a blank sheet at skew ${skew} is not read as printed`, !blank.ready,
      `ink ${blank.ink.toFixed(3)}/${blank.inkContrast.toFixed(0)}`);
    const printed = sheet(true, skew, 160 + skew * 100);
    check(`  and a printed one at skew ${skew} still fires`, printed.ready,
      `ink ${printed.ink.toFixed(3)}/${printed.inkContrast.toFixed(0)}`);
  }
}

// Framing. A small receipt on a PALE desk lets the band spread into the
// surroundings and dilutes the print to one percent, which is why the lower
// bound on ink is tiny and contrast is what refuses a blank surface.
{
  const small = (x: number, y: number, bg: number) => (x > 22 && x < 42 && y > 14 && y < 34 ? (x % 7 < 2 && y % 8 < 2 ? 60 : 230) : bg);
  const onDark = scene((x, y, n) => small(x, y, 40) + (n() - 0.5) * 10, 144);
  check("a small receipt on a dark surface fires", onDark.ready, `ink ${onDark.ink.toFixed(3)}`);
  const onPale = scene((x, y, n) => small(x, y, 230) + (n() - 0.5) * 10, 145);
  check("a small receipt on a pale desk fires", onPale.ready, `ink ${onPale.ink.toFixed(3)}`);
}

// Faded AND sparse together. Standard deviation confounds contrast with
// density, so each fault alone passed the old global gate and the two together
// scored 8.4 and did not. Interactions are invisible when faults are only ever
// tested one at a time.
{
  const both = scene((x, y, n) => (x % 7 < 2 && y % 8 < 2 ? 200 : 230) + (n() - 0.5) * 10, 146);
  check("a receipt both faded and sparsely printed fires", both.ready,
    `contrast ${both.detail.toFixed(1)} ink ${both.ink.toFixed(3)}/${both.inkContrast.toFixed(0)}`);
}

// Print covers a minority of a receipt and about half of a two-tone object.
// That is what the upper bound is, and these are the numbers behind it.
{
  const receipt = scene((x, y, n) => (x > 12 && x < 52 && y > 6 && y < 42 ? (x % 7 < 2 && y % 5 !== 4 ? 60 : 230) : 40) + (n() - 0.5) * 12, 133);
  check("ink covers a minority of a receipt", receipt.ink < 0.33, receipt.ink.toFixed(3));
  for (const [name, r] of room) {
    check(`  and ${name} is refused on one of the two`, r.ink > 0.33 || r.inkContrast < 20,
      `ink ${r.ink.toFixed(3)} inkContrast ${r.inkContrast.toFixed(0)}`);
  }
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

// ------------------------------------------- print at the size print really is

// Every fixture above draws "text" two pixels wide every seven, which is
// enormous next to real print - and that is exactly why the suite passed while
// a real receipt reported `ink 0.00/00` from the field. At 64x48 real text is
// smeared into grey: measured on a rendered receipt, the ink contrast is 14 at
// that size and 48 at 192x144. These run at the size the app now judges
// subjects at, with strokes one pixel wide.
{
  const SW = 192, SH = 144;
  const fine = (opts: { ink: number; paper: number; ground: number; every: number; seed: number }) => {
    const random = rng(opts.seed);
    const make = () => {
      const data = new Uint8ClampedArray(SW * SH * 4);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const onSheet = x > 30 && x < 162 && y > 12 && y < 132;
          // One-pixel strokes on text lines, the way print actually falls.
          const isInk = onSheet && y % opts.every < 1 && x % 3 < 1;
          const v = (onSheet ? (isInk ? opts.ink : opts.paper) : opts.ground) + (random() - 0.5) * 8;
          const i = (y * SW + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
          data[i + 3] = 255;
        }
      }
      return data;
    };
    // A still movement frame alongside, as the camera screen provides.
    const still = new Uint8ClampedArray(W * H * 4).fill(200);
    for (let p = 3; p < still.length; p += 4) still[p] = 255;
    const d = new StabilityDetector();
    let last = d.push(still, W, H, { rgba: make(), width: SW, height: SH });
    for (let i = 0; i < 40; i++) last = d.push(still, W, H, { rgba: make(), width: SW, height: SH });
    return last;
  };

  const crisp = fine({ ink: 45, paper: 235, ground: 55, every: 4, seed: 200 });
  check("fine one-pixel print fires", crisp.ready, `ink ${crisp.ink.toFixed(3)}/${crisp.inkContrast.toFixed(0)}`);

  const faint = fine({ ink: 175, paper: 235, ground: 55, every: 4, seed: 201 });
  check("  faint fine print fires", faint.ready, `ink ${faint.ink.toFixed(3)}/${faint.inkContrast.toFixed(0)}`);

  const sparse = fine({ ink: 45, paper: 235, ground: 55, every: 9, seed: 202 });
  check("  widely spaced fine print fires", sparse.ready, `ink ${sparse.ink.toFixed(3)}/${sparse.inkContrast.toFixed(0)}`);

  const onPale = fine({ ink: 45, paper: 235, ground: 225, every: 4, seed: 203 });
  check("  fine print on a pale desk fires", onPale.ready, `ink ${onPale.ink.toFixed(3)}/${onPale.inkContrast.toFixed(0)}`);

  const blank = fine({ ink: 235, paper: 235, ground: 55, every: 4, seed: 204 });
  check("  and a blank sheet at the same size does not", !blank.ready,
    `ink ${blank.ink.toFixed(3)}/${blank.inkContrast.toFixed(0)}`);
}

// A subject frame whose dimensions and pixels disagree must not be used.
// Falling back to the movement frame's pixels while keeping the subject frame's
// dimensions read past the end of the array and produced NaN, which fails every
// comparison silently.
{
  const d = new StabilityDetector();
  const still = new Uint8ClampedArray(W * H * 4).fill(200);
  for (let p = 3; p < still.length; p += 4) still[p] = 255;
  let last = d.push(still, W, H, { rgba: new Uint8ClampedArray(16), width: 192, height: 144 });
  for (let i = 0; i < 30; i++) last = d.push(still, W, H, { rgba: new Uint8ClampedArray(16), width: 192, height: 144 });
  check("a subject frame too short for its dimensions is refused, not used", Number.isFinite(last.detail));
  check("  and produces no NaN anywhere", Number.isFinite(last.ink) && Number.isFinite(last.print));
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
