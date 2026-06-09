
This plan touches `public/tuner-app.js`, `public/receivers.json`, and `src/admin.html` only (no HTML structure changes needed beyond existing nodes).

## 1. Play button reliability + icon state

- Track audio "playing" state from the actual `<audio>` element, not just the `muted` flag. Toggle the play/stop icon based on whether at least one neighbor stream is actually playing (listen to `playing` / `pause` events on the current station's audio).
- On first click: `await ac.resume()`, then for each neighbor, call `audio.play()` and await the first `playing` event before flipping the icon to "stop". Use the user-gesture click handler to call `.play()` directly (no async gap before it).
- Cause of "spam-clicking": the source is created and `.play()` is called once before the user gesture even completes (because we currently `audio.play()` inside `ensureStation()` that runs from `paint()` setInterval, which is NOT a user gesture). Fix by **not** calling `audio.play()` inside `ensureStation()`. Start playback only from the click handler (and from any subsequent neighbor that gets created after audio is already unmuted).

## 2. TX panel blank when empty

In `showTX`, when `st.station` has no real info (or is missing entirely), clear all six labels to `""` and skip the literal `kW`, `°`, `km` suffix text. Concretely: only render `"X kW"`, `"X km"`, `"X°"` when the underlying value is a number; otherwise render `""`. Also blank out before TX-show timeout in `clearTX`.

## 3. Configurable audio latency

- Add `audioDelayMs` to top-level config (default 800). Read at boot, apply to each pool node's DelayNode (`delay.delayTime.value = ms/1000`). Default current `AUDIO_DELAY_S` becomes 0.8s.
- Admin help text updated.

## 4. Erratic pilot detection on weak signals

- Replace fixed `stereoPilotMs` lock with a per-paint stochastic decision: when `quality < 0.5`, randomly drop stereo for short bursts (~100-400ms). When `quality >= 0.8`, lock solid stereo. Smoothly blend monoGain/stereoGain.
- Still apply initial 400ms pilot detection delay after a fresh lock.

## 5. PI timing + group delay

- Add constants: `PI_DELAY_MS = 100`, `RDS_START_DELAY_MS = 220` (PI comes in at +100ms, first RDS group at +320ms).
- On lock: don't paint PI immediately. Instead schedule via `setTimeout` after PI_DELAY_MS.
- The group tick should skip work until `performance.now() - lockedAtMs >= PI_DELAY_MS + RDS_START_DELAY_MS`. We'll keep the global `setInterval(rdsGroup, GROUP_MS)` and just guard inside.

## 6. Dynamic PS modes

Add per-station and per-receiver `dynamicPsMode`: `"static"` (no rotation), `"groups"` (default — Stereo Tool style), `"scroll"` (smooth scroller).

- **groups mode**: split text on word boundaries into 8-char chunks, then transmit each chunk via the group cadence — each chunk lights up 2 chars per group, holds for a configurable `groupsHoldGroups` (default 4 groups ≈ 2.4s), then moves to the next chunk. Repeats from start.
- **scroll mode**: with `scrollStopStartMs` (default 1500), `scrollStopEndMs` (default 1500), `scrollSpeedMs` (default 250 per shift). Renders an 8-char window sliding through the full text, pausing at start and end.

Implement as a new `psScheduler` driven by a single 80ms `setInterval`. The old `psFilled` group-fill logic stays for the FIRST cycle (so initial fill still feels like real RDS groups arriving), then hands control to the scheduler.

## 7. RDS glitches on low signal + RDS character set

- Add `quality` snapshot per group tick. Probability of "drop this group" = `clamp(1 - quality, 0, 0.6)`. Some segments simply won't fill until a re-roll succeeds.
- For *very* weak signals (quality < 0.2), randomly corrupt 1 char in the new RT segment with a `_`.
- Add `toRdsAscii(s)`: normalize via `String.prototype.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')`, replace any non-ASCII with `?`, but special-map a small table (`é→e`, `ä→a`, `ö→o`, `ü→u`, `ß→ss`, `ñ→n`, `ç→c`, smart quotes → straight). Apply to PS and RT text before transmission.

## 8. RDS vs RBDS PTY tables

- Add top-level config field `rdsMode`: `"rds"` | `"rbds"` (default `"rds"`).
- Define `PTY_RDS` and `PTY_RBDS` arrays (32 entries each). Use real, canonical strings.
- Allow config override: `ptyOverrides` map of `index → string` to let users customize.
- Show the correct list when painting PTY.

## 9. Off-frequency distortion latency bug

Root cause: the delayed audio chain means the last 800ms of distorted audio plays even after the station is on-frequency. The fix is to apply audio-model parameters (curve, lowpass, gain, mono/stereo) **at the future moment** that audio will be heard, not at the current paint moment. We schedule param changes with `setValueAtTime(value, ac.currentTime + AUDIO_DELAY_S)`. Implement via `linearRampToValueAtTime` on gain nodes and `setValueAtTime` on filter freq / curve.

Also fix the mirror bug: when going off-frequency from stereo, immediately schedule monoGain to ramp up at `currentTime + AUDIO_DELAY_S` so the heard audio is mono exactly when the off-freq audio is heard.

## 10. Per-station volume control, parametric EQ, audibleBandwidth

Add to each station:
- `volume` (default 1.0, can be >1 to drive into the WaveShaper distortion — simulates overmodulation).
- `eq`: array of `{freq, gain, q}` parametric bands (apply as a chain of `peaking` BiquadFilter nodes per station).
- `audibleBandwidth` (optional) — overrides global `CFG.audibleBandwidth` for that station, used in `baseSignal`, `applyAudioModel`, RDS lock, etc.

Plus: as offset grows within the audible bandwidth, sweep a **highpass** up from 30Hz to ~400Hz to simulate the low-end cut on off-tuned stations (current code only sweeps the lowpass down).

## 11. Admin docs

Update the help text in `src/admin.html` listing new station fields:
`volume`, `eq[]`, `audibleBandwidth`, `dynamicPsMode`, `scrollStopStartMs`,
`scrollStopEndMs`, `scrollSpeedMs`, `logo`, plus top-level
`audioDelayMs`, `rdsMode`, `ptyOverrides`.

## Out of scope
- No HTML structure changes.
- No new routes.
- No CSS rework (play button already 90px).
