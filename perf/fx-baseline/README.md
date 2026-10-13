# Tyre smoke baseline

`smoke.txt` and `trail.txt` are the original Getaway renderer and simulation from
`bf5f627` (approved main after the smoke cleanup). `prove-fx-integration.ts` substitutes them at their original module paths
with a Vite pre-load plugin and a separate dependency cache. Production code never imports these copies.
