# N6. No injected input on the owner's screen

**Date:** 2026-11-07. **Status:** accepted.

**Context.** Windows delivers injected pointer input (`InjectSyntheticPointerInput`) only to a window that is on screen
and under the injected point. Spike S1 placed a small, nearly invisible topmost window in a screen corner for the seconds
its self-test ran, and in two early runs, before it checked that the window was uncovered, the injected pen may have
reached another window. The owner works on this machine; agents' runs must never touch their desktop.

**Decision.** Automated runs never inject input on the visible screen. The pen lab's `--inject-on-screen` self-test stays
in the developer build as a tool the owner can run by hand, and is never used by automation, agents or CI. The real
`WM_POINTER` path is covered by: the S1 measurements already taken (fields, history recovery, promotion, palm and
press-and-hold behaviour, parity), unit tests of the decoding of pointer frames, the fake input source for everything
above the platform layer, and a manual pass with a real pen or tablet when one is attached. The automation mode drives
pen strokes through the input service's fake source, which carries the same samples a device would.
