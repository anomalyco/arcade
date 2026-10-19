// Palm and finger skin (mesh vertices) to the steering-wheel rim tube surface, cm (scripts/character/wheel-closeup.ts).
(() => {
    const b = __afterhoursBody.body, r = b.seatRig
    const w = r.opts.wheel, wh = w.object
    const V = b.root.position.constructor, Q = b.root.quaternion.constructor
    const hub = wh.getWorldPosition(new V())
    const ax = wh.userData.axis.clone().normalize().applyQuaternion(wh.parent.getWorldQuaternion(new Q()))
    const td = (p) => { const gg = p.clone().sub(hub); const along = gg.dot(ax); const pl = gg.clone().addScaledVector(ax, -along); return p.distanceTo(hub.clone().add(pl.setLength(w.radius))) - w.tube }
    let mesh = null
    b.model.traverse((o) => { if (o.isSkinnedMesh && !/head/i.test(o.name) && o.skeleton.bones.some((x) => x.name === "LeftHandIndex1") && o.geometry.attributes.position.count > 5000 && !mesh) mesh = o })
    const bones = mesh.skeleton.bones
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight
    const v = new V()
    const o = {}
    for (const s of ["Left", "Right"]) {
      let palm = 1, fing = 1, inside = 0, n = 0
      for (let i = 0; i < si.count; i++) {
        let best = 0, bw = 0
        for (let k = 0; k < 4; k++) { const wg = sw.getComponent(i, k); if (wg > bw) { bw = wg; best = si.getComponent(i, k) } }
        const nm = bones[best].name
        if (!nm.startsWith(s + "Hand")) continue
        mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld)
        const d = td(v)
        if (nm === s + "Hand") palm = Math.min(palm, d)
        else if (!/Thumb/.test(nm)) { fing = Math.min(fing, d); n++; if (d < -0.004) inside++ }
      }
      o[s] = { palm: +(palm * 100).toFixed(1), fing: +(fing * 100).toFixed(1), inside, n }
    }
    return o
  })()
