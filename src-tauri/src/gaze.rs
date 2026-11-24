//! Which way the pet would look to see the mouse cursor: coarsely, one of eight
//! directions or straight ahead (the cursor on its face), and whether the cursor is
//! close enough to be worth watching. The cursor loop in main.rs works it out each time
//! it looks at the cursor anyway, and tells the page (`gaze` event) only when it changes.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Gaze {
    /// 0 straight ahead, 1 up, then clockwise to 8 up-left (as `ANIMS.gaze` in anims.js).
    pub dir: u8,
    pub near: bool,
}

/// The cursor counts as close within this many logical px of the pet's eyes...
const REACH: f64 = 360.0;
/// ...and stops counting a little further out, so that it doesn't flicker at the rim.
const LET_GO: f64 = 400.0;
/// The eyes are this far down the body (`#pet-hit`).
const EYE_LEVEL: f64 = 0.36;

/// Where the pet looks for the cursor at (`x`, `y`), with its body at `body` (x, y,
/// width, height), all in logical px from the window's top left. `was_near`: what the
/// last answer said. Far away, it is always (0, far): only coming close is news.
pub fn look(x: f64, y: f64, body: [f64; 4], was_near: bool) -> Gaze {
    let [bx, by, bw, bh] = body;
    let (dx, dy) = (x - (bx + bw / 2.0), y - (by + bh * EYE_LEVEL));
    let near = dx.hypot(dy) < if was_near { LET_GO } else { REACH };
    if !near {
        return Gaze::default();
    }
    // On its face (the drawing is about half as wide as the body): straight at you.
    if dx.abs() < bw * 0.25 && dy.abs() < bh * 0.3 {
        return Gaze { dir: 0, near };
    }
    // Degrees clockwise from straight up, into eight slices centred on the directions.
    let a = dx.atan2(-dy).to_degrees();
    let dir = ((a + 360.0 + 22.5) % 360.0 / 45.0) as u8 + 1;
    Gaze { dir, near }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: [f64; 4] = [100.0, 300.0, 200.0, 100.0];
    // Its eyes, as `look` sees them.
    const EX: f64 = 200.0;
    const EY: f64 = 336.0;

    fn dir(x: f64, y: f64) -> u8 {
        look(x, y, BODY, false).dir
    }

    #[test]
    fn eight_ways_round() {
        let d = 150.0;
        assert_eq!(dir(EX, EY - d), 1);
        assert_eq!(dir(EX + d, EY - d), 2);
        assert_eq!(dir(EX + d, EY), 3);
        assert_eq!(dir(EX + d, EY + d), 4);
        assert_eq!(dir(EX, EY + d), 5);
        assert_eq!(dir(EX - d, EY + d), 6);
        assert_eq!(dir(EX - d, EY), 7);
        assert_eq!(dir(EX - d, EY - d), 8);
    }

    #[test]
    fn on_its_face() {
        assert_eq!(look(EX + 10.0, EY - 5.0, BODY, false), Gaze { dir: 0, near: true });
    }

    #[test]
    fn far_is_quiet_and_lets_go_further_out() {
        assert_eq!(look(EX + 380.0, EY, BODY, false), Gaze::default());
        assert_eq!(look(EX + 380.0, EY, BODY, true), Gaze { dir: 3, near: true });
        assert_eq!(look(EX + 420.0, EY, BODY, true), Gaze::default());
    }
}
