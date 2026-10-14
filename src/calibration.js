// calibration.js
// Honest confidence: compares what AirPlain SAID (its confidence number)
// with what HAPPENED (human feedback on past decisions).
//
// Only decisions a human has marked right or wrong count. Small samples
// are reported honestly instead of pretending they prove something.
// All band math happens here, in regular code, never in the model.

const BANDS = [
  [0, 50],
  [50, 60],
  [60, 70],
  [70, 80],
  [80, 90],
  [90, 100],
];

const MIN_SAMPLE = 5; // fewer than this and we say so instead of bragging

export function calibrationReport(state) {
  const bands = [];
  let total = 0;
  let right = 0;
  for (const [lo, hi] of BANDS) {
    let n = 0;
    let c = 0;
    for (const d of state.decisions) {
      const fb = state.feedback[d.id];
      if (!fb) continue;
      const pct = Math.round(d.confidence * 100);
      if (pct >= lo && pct <= hi) {
        n++;
        if (fb.correct) c++;
      }
    }
    total += n;
    right += c;
    if (n === 0) {
      bands.push("When AirPlain said it was " + lo + " to " + hi + "% sure: no checked decisions yet.");
    } else if (n < MIN_SAMPLE) {
      bands.push(
        "When AirPlain said it was " +
          lo +
          " to " +
          hi +
          "% sure: it was right " +
          c +
          " out of " +
          n +
          " times, but that is too few to trust yet."
      );
    } else {
      bands.push(
        "When AirPlain said it was " + lo + " to " + hi + "% sure: it was right " + c + " out of " + n + " times."
      );
    }
  }
  const headline =
    total === 0
      ? "No decisions have been checked yet, so there is nothing to report."
      : "Across " +
        total +
        " checked decision" +
        (total === 1 ? "" : "s") +
        ", AirPlain was right " +
        right +
        " time" +
        (right === 1 ? "" : "s") +
        " (" +
        Math.round((right / total) * 100) +
        "%).";
  return { headline, bands, checked: total, correct: right };
}
