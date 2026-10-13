# Tyre smoke baseline

`smoke.txt` and `trail.txt` are the original Getaway renderer and simulation from
`94c62b98abe762657ad24b633ca7fd22f314130e`. The proof fixture substitutes them at their original module paths
with a Vite pre-load plugin and a separate dependency cache. Production code never imports these copies.
