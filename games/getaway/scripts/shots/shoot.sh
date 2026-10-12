#!/bin/bash
# Screenshot the dev build on apollo's real GPU and copy it back.
# usage: scripts/shots/shoot.sh <port> <session> <out.png> [query]   e.g. shoot.sh 5191 lead /tmp/opencode/lead-shots/x.png "stage=chase&freeze"
# Needs: vite on 127.0.0.1:<port> and `ssh -f -N -R <port>:127.0.0.1:<port> apollo`.
port=$1; sess=$2; out=$3; query=${4:-stage=chase&freeze}; wait=${WAIT:-2500}; w=${W:-1536}; h=${H:-960}
tmp=$(mktemp /tmp/opencode/shotXXXX.js)
cat > "$tmp" <<JS
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERR " + e.message));
page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" || m.type() === "warning") && !/woff|favicon|vite/.test(t)) logs.push(m.type() + ": " + t.slice(0, 300)); });
await page.setViewportSize({ width: $w, height: $h });
await page.goto("http://localhost:$port/?$query&" + Date.now(), { waitUntil: "load" });
await page.bringToFront();
await page.waitForTimeout($wait);
await page.screenshot({ path: "/tmp/shot-$sess.png" });
return JSON.stringify(logs.slice(0, 10));
JS
scp -q "$tmp" apollo:/tmp/shot-$sess.js
ssh apollo "~/.bun/bin/browser-control execute -s $sess --file /tmp/shot-$sess.js" 2>&1 | grep -E '^\[' | head -3
rm -f "$tmp"
for i in 1 2 3 4 5; do sleep 1; scp -q apollo:/tmp/shot-$sess.png "$out" 2>/dev/null && ssh apollo "rm -f /tmp/shot-$sess.png" && break; done
ls -la "$out" 2>/dev/null | awk '{print $5, $9}'
