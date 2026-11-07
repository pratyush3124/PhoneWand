// Turns a left/right tilt angle (degrees, relative to the calibrated neutral)
// into "yes" | "no" | "center", with hysteresis so it doesn't flicker near a threshold.
//   tilt left  (negative) -> "yes"
//   tilt right (positive) -> "no"
// `enter` is how far you must tilt to select; `exit` is how close to level
// you must come back to deselect. exit < enter creates the dead band.
export function createTiltClassifier({ enter = 20, exit = 10 } = {}) {
  let state = "center";
  return {
    get state() {
      return state;
    },
    update(delta) {
      if (state === "center") {
        if (delta <= -enter) state = "yes";
        else if (delta >= enter) state = "no";
      } else if (state === "yes") {
        if (delta >= enter) state = "no";
        else if (delta > -exit) state = "center";
      } else {
        if (delta <= -enter) state = "yes";
        else if (delta < exit) state = "center";
      }
      return state;
    },
    reset() {
      state = "center";
    },
  };
}
