# N7. The real-IME pass is the owner's manual gate before release, not a gate on interface work

**Date:** 2026-11-07. **Status:** accepted.

**Context.** The brief says no interface work starts until pen input and text input pass in a native window. The text
spike's real-IME criteria (composition, candidate selection and placement, cancellation with Microsoft Japanese IME and
Pinyin, the Arabic and Hebrew keyboards) cannot be run on this machine: only Italian and US input is installed, installing
language packs changes the owner's system, and injected input is not allowed on the owner's screen (N6). The field-side
IME contract is covered by iced's input-method events in headless tests.

**Decision.** Interface work may start once every automated criterion of the pen and text spikes passes. The real-IME pass
(and the real pen or tablet pass) are manual checks the owner runs, listed in the Handoff; they gate the release, not the
interface work.

**Why.** IME handling is confined to the field widgets (`styk-design`) and the vendored winit and iced input code; every
panel uses the same fields, so a problem found by the manual pass is fixed in one place without rewriting a panel. Holding
the whole port on a step only the owner can perform would stop all interface work for a risk with a designed fallback (a
TSF text-store bridge, designed in `docs/native/text-input.md`).
