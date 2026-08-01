# SPEC: Eager initialization for sampled instruments

Status: implementing. Consumer: singHarmony2 — the piano must be warm and ready
by the time the user reaches the play button, with `warm()` fired at page load
instead of on the first play tap.

## The problem

Warming today requires a Piano instance, and constructing one creates the
singleton AudioContext. Constructed at page load (outside a user gesture) the
context starts `suspended` and nothing ever resumes it, so consumers defer
construction to the first click — pushing the ~1s warm-up behind the play
button. But the two halves have different constraints: `OfflineAudioContext`
pre-rendering needs NO gesture; only live output needs a running context.

## API

```js
import { initInstruments, getInstrument } from 'resound-sound';

// at page load — safe outside any user gesture
const { piano } = await initInstruments({
  piano: { id: 'my-piano', layers: [0.5, 0.65, 0.8, 0.95], pitches: ['C/3', ...] },
});

// anywhere else
const same = getInstrument('my-piano');   // same instance (or undefined)
```

Behavior:
1. `initInstruments(config)` — for each configured sampled-instrument type
   (only `piano` exists today, but the config shape is per-type so future
   sampled instruments slot in): create the instance eagerly, register it in a
   module-level registry by id, and `warm()` the given pitches. Resolves (with
   the instances) when warming completes; callers may ignore the promise for
   fire-and-forget.
2. **Idempotent / incremental**: calling again with the same id returns the
   SAME instance (constructor options from the first call win; warn on
   conflicting `layers`) and warms any not-yet-warmed pitches from the new
   call.
3. **Gesture-resume**: after creating the context, if `context.state` is
   `suspended`, install one-time listeners (`pointerdown`, `keydown`,
   `touchend` on `document`) that call `context.resume()` and remove
   themselves. If the context is already `running`, install nothing. Expose
   this as `audioContextManager.resumeOnFirstGesture()` and call it from
   `initInstruments`; it must be safe to call repeatedly (one set of listeners
   max).
4. `getInstrument(id)` returns the registered instance or undefined. Plain
   `new Piano(id)` does NOT register (no behavior change for existing users).

## Constraints

- No breaking changes to any existing export or behavior; `npm test` (22
  integration tests) stays green.
- jsdom has no `OfflineAudioContext` — `warm()` already no-ops there; init
  must still resolve cleanly in that environment (tests rely on it).
- Don't reformat the `src/index.js` export block (editor middleware regex);
  append the new exports in the same style.

## Tests (TDD — write first, in the existing integration-test style)

- init returns a Piano registered under its id; `getInstrument` finds it
- second init call with same id: same instance returned; new pitches warmed
  (spy on `warm`); different `layers` logs a warning and keeps the original
- suspended context → exactly one set of gesture listeners; dispatching
  `pointerdown` calls `context.resume()` and removes the listeners; calling
  `resumeOnFirstGesture()` twice never doubles listeners
- running context → no listeners installed
- init with no config resolves to `{}` and touches nothing

## Docs

README section ("Make the piano ready before the first tap") with the
page-load + per-song-warm pattern; CHANGELOG entry. Commit when green — no
version bump, no push, no publish.
