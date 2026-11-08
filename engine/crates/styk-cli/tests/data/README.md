# Profile picture-pressure fixture

`profile-pictures.json` is a new synthetic fixture derived from the structural fields of the
repository's Stick Nodes sprite example. It contains three separate 8x8 RGBA PNG pictures
(red, green and blue), all drawn in one frame. Their decoded pixels total 768 bytes, exceeding
the regression's 512-byte pending-picture budget while each individual picture fits.
The test compares the production profile export against two runs with a roomy budget.
No existing frozen fixture was modified.
