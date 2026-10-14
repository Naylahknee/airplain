// paperTrail.js
// Turns a settings change into a plain-English log entry.
// The rule: no silent changes, ever. Every change gets one entry that a
// non-technical business owner can read and understand.

export function describeChange(key, oldValue, newValue) {
  if (key === "thresholds.auto") {
    const o = Math.round(oldValue * 100);
    const n = Math.round(newValue * 100);
    const meaning =
      n > o
        ? "From now on, fewer decisions will act on their own and more will ask a human first."
        : "From now on, more decisions will act on their own and fewer will ask a human first.";
    return "The auto-act line moved from " + o + "% to " + n + "% confidence. " + meaning;
  }
  if (key === "thresholds.review") {
    const o = Math.round(oldValue * 100);
    const n = Math.round(newValue * 100);
    return (
      "The review line moved from " +
      o +
      "% to " +
      n +
      "%. Decisions under this line are treated as too unsure to trust."
    );
  }
  if (key === "criteria") {
    return (
      "The decision instructions were rewritten. " +
      'Before: "' +
      oldValue +
      '" ' +
      'After: "' +
      newValue +
      '" ' +
      "This changes how AirPlain judges every new decision from here on."
    );
  }
  return (
    'Setting "' + key + '" changed from ' + JSON.stringify(oldValue) + " to " + JSON.stringify(newValue) + "."
  );
}
