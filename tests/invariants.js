// Behavioral invariant suite — runs inside the live player page (injected by
// tests/run.py). None of these are visual: they lock in termination, timing,
// distribution and resource-accounting behaviors that regressed silently in
// the past (807's split timing, karaoke doubling, self-link wrap stalls...).
// Returns a Promise resolving to [{name, pass, info}].
(async () => {
  const s = window.saver;
  const R = [];
  const t = (name, pass, info) => R.push({ name, pass: !!pass, info: info || '' });
  const freshGag = (scen, opts) => {
    s.actors.length = 0;
    return new MultiGag(s, scen, opts || { noLanes: true });
  };
  s.introRunning = false;
  s.debugActor = null;
  s.debugSolo = false;
  s.muted = true;                            // keep the run silent

  // ---- 1. every gag scenario terminates -------------------------------
  {
    const scens = Object.keys(s.gags).map(Number);
    const immortal = [];
    for (const sc of scens) {
      const g = freshGag(sc);
      let died = false;
      for (let i = 0; i < 3500; i++) { g.tick(); if (g.dead) { died = true; break; } }
      if (!died) immortal.push(sc);
    }
    t('all gag scenarios terminate', immortal.length === 0,
      immortal.length ? 'immortal: ' + immortal.join(',') : scens.length + ' scenarios');
  }

  // ---- 2. chain labels all resolve ------------------------------------
  {
    const bad = [];
    for (const [sc, e] of Object.entries(s.gags)) {
      for (const chain of Object.values(e.chans || {}))
        for (const l of chain)
          if (l !== 3 && l !== 93 && !s.compound.seqOf.get(l)) bad.push(sc + ':' + l);
    }
    t('all chain labels resolve to sequences', bad.length === 0, bad.join(','));
  }

  // ---- 3. 807 split timing: toast breaks off when the pop ends --------
  {
    const g = freshGag(807);
    const m = g.mainCh;
    let popEnd = null, splitAt = null, popSeen = false;
    for (let i = 0; i < 400 && !g.dead; i++) {
      if (m.p.label === 807) popSeen = true;
      if (popSeen && popEnd === null && m.p.label !== 807) popEnd = i;
      if (splitAt === null && g.ch.some(c => c.propChan)) splitAt = i;
      g.tick();
    }
    t('807 toast splits exactly at pop end', popEnd !== null && splitAt === popEnd,
      `popEnd=${popEnd} splitAt=${splitAt}`);
  }

  // ---- 4. 1672 rider: spawns at seq end, dies with the gag ------------
  {
    const g = freshGag(1672);
    let riderSeen = false, riderAliveAfterGag = false;
    for (let i = 0; i < 900; i++) {
      g.tick();
      const r = g.ch.find(c => c.propChan);
      if (r && !r.dead) riderSeen = true;
      if (g.dead) { riderAliveAfterGag = !!(r && !r.dead); break; }
    }
    t('1672 rider exists and cannot outlive the gag',
      riderSeen && !riderAliveAfterGag, `seen=${riderSeen}`);
  }

  // ---- 5. self-link wrap continuity (1227 stutter regression) ---------
  {
    const p = new Player(s.compound, s.art, s);
    p.enter(1227); p.placeCenter(600, 300);
    let stalls = 0, last = null;
    for (let i = 0; i < 14; i++) {
      const b = p.bounds(), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      if (last && c[0] === last[0] && c[1] === last[1]) stalls++;
      last = c;
      if (p.tick() === 'end') p.enter(1227);
    }
    t('self-link loops never stall at the wrap seam', stalls === 0, `stalls=${stalls}`);
  }

  // ---- 6. act-picker distributions ------------------------------------
  {
    const a = new ToasterActor(s, true);
    const roll = (kind, n) => {
      a.kind = kind;
      const h = {};
      for (let i = 0; i < n; i++) { const L = a.pickerRoll(); h[L] = (h[L] || 0) + 1; }
      return h;
    };
    const near = (got, want, n, tol) => Math.abs(got / n - want) < want * tol + 0.01;
    const N = 4000;
    const k1 = roll(1, N), k2 = roll(2, N), k3 = roll(3, N);
    t('K1 picker distribution (33,602 ~10/35; flight ~12/35)',
      near(k1[33] || 0, 10 / 35, N, 0.25) && near(k1[602] || 0, 10 / 35, N, 0.25) &&
      near(k1[3] || 0, 12 / 35, N, 0.25),
      JSON.stringify(k1));
    t('K2 picker distribution (638 ~10/30)',
      near(k2[638] || 0, 10 / 30, N, 0.25) && near(k2[93] || 0, 16 / 30, N, 0.25),
      JSON.stringify(k2));
    t('K3 specials ~1/80 each',
      near(k3[983] || 0, 76 / 80, N, 0.1) &&
      [988, 1009, 1014, 1019].every(L => (k3[L] || 0) > 0),
      JSON.stringify(k3));
    a.dead = true;
  }

  // ---- 7. random act-repeat variants ----------------------------------
  {
    const seen = l => {
      const counts = new Set();
      for (let i = 0; i < 60; i++) {
        const g = freshGag(l === 861 ? 879 : l);
        const chain = g.ch.map(c => c.chain).find(cn => cn.includes(l)) || [];
        counts.add(chain.filter(x => x === l).length);
      }
      return [...counts].sort((a, b) => a - b);
    };
    const c456 = seen(456), c861 = seen(861);
    t('456 rolls 0-2 act loops', c456.length >= 2 && Math.min(...c456) >= 0 && Math.max(...c456) <= 2,
      JSON.stringify(c456));
    t('879 rolls 1-3 bagel pops', c861.length >= 2 && Math.min(...c861) >= 1 && Math.max(...c861) <= 3,
      JSON.stringify(c861));
  }

  // ---- 8. lane accounting: claim on spawn, release by death -----------
  {
    const lf = laneFieldOf(s);
    lf.claim = []; lf.resv = [];
    s._laneGrantAt = 0;
    const a = new ToasterActor(s, true);
    const claimed = a._lane != null && !!lf.claim[a._lane];
    // force death
    a.arrived = true;
    a.p.placeCenter(-500, -500);
    for (let i = 0; i < 20 && !a.dead; i++) a.tick();
    const released = a._lane == null && lf.claim.filter(v => v).length === 0;
    t('toaster claims a lane at launch and releases at death',
      claimed && released, `claimed=${claimed} released=${released}`);
  }

  // ---- 9. gag reservations: failed spawn reserves, success clears -----
  {
    const lf = laneFieldOf(s);
    lf.claim = []; lf.resv = [];
    for (let i = 0; i < lf.total; i++) lf.claim[i] = now();   // all busy
    const g = new MultiGag(s, 928, {});                        // must fail
    const reserved = g.spawnFailed && lf.resv.filter(v => v).length > 0;
    lf.claim = [];                                             // free lanes
    // engine semantics (0x17469): a SUCCESSFUL spawn clears the reservations
    // of ITS OWN footprint only — stale reservations elsewhere persist until
    // the 25s timeout. Verify the successful footprint carries none.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const h = new MultiGag(s, 928, {});
      if (!h.spawnFailed) { ok = (h._lanes || []).every(li => !lf.resv[li]); break; }
    }
    t('failed gag spawn reserves lanes; success clears its footprint',
      reserved && ok, `reserved=${reserved} footprintCleared=${ok}`);
    lf.claim = []; lf.resv = [];
  }

  // ---- 10. scenario SFX timelines (stubbed sink) ----------------------
  {
    const fired = [];
    const orig = s.playSound.bind(s);
    const origMuted = s.muted;
    s.muted = false;
    s.playSound = (id, g, loop) => {
      fired.push({ id, loop: !!loop });
      return { stop() { fired.push({ stop: id }); } };
    };
    const run = sc => {
      fired.length = 0;
      const g = freshGag(sc);
      for (let i = 0; i < 3000 && !g.dead; i++) g.tick();
      return fired.slice();
    };
    const f1288 = run(1288);
    t('1288 plays warp then looping sting with stop',
      f1288.some(x => x.id === 22012) &&
      f1288.some(x => x.id === 22000 && x.loop) &&
      f1288.some(x => x.stop === 22000),
      JSON.stringify(f1288));
    const f928 = run(928);
    t('928 fire loops and stops at teardown',
      f928.some(x => x.id === 22001 && x.loop) && f928.some(x => x.stop === 22001),
      JSON.stringify(f928));
    const f679 = run(679);
    t('679 has no scenario siren (frame-bound bark only)',
      !f679.some(x => x.id === 22005), JSON.stringify(f679));
    s.playSound = orig;
    s.muted = origMuted;
  }

  // ---- 11. karaoke data integrity -------------------------------------
  {
    let missing = 0, badArts = 0, lines = 0;
    for (const song of Object.values(s.karaokeTables)) {
      for (const e of song.events) {
        if (e.ev !== 0 || e.line === 0) continue;
        lines++;
        const fr = s.karCompound.frame(e.line);
        if (!fr) { missing++; continue; }
        for (const it of fr.items) if (!s.karArt.get(it.art)) badArts++;
      }
    }
    t('karaoke lines and glyph arts all resolve',
      missing === 0 && badArts === 0 && lines > 30,
      `lines=${lines} missing=${missing} badArts=${badArts}`);
  }

  // ---- 12. 2391 singleton ---------------------------------------------
  {
    s._active2391 = false;
    const a = new ToasterActor(s, false); a.kind = 3;
    a.dispatchK3(2391, 0);
    const b = new ToasterActor(s, false); b.kind = 3;
    b.dispatchK3(2391, 0);
    const substituted = a.s44 === 2391 && b.s44 === 1038;
    s._active2391 = false;
    a.dead = b.dead = true;
    t('2391 is a singleton (concurrent pick substitutes 1038)', substituted,
      `a=${a.s44} b=${b.s44}`);
  }

  // ---- 13. fly-in: 861 pops on-screen ---------------------------------
  {
    const g = freshGag(861);
    const m = g.mainCh;
    let popOn = null;
    for (let i = 0; i < 400 && !g.dead; i++) {
      if (popOn === null && m.p.label === 861) popOn = !m.p.offscreen(0);
      g.tick();
    }
    t('861 bagel pops while on-screen', popOn === true, `popOn=${popOn}`);
  }

  // ---- 14. formation groups start off-canvas --------------------------
  {
    const bad = [];
    for (const sc of [2736, 2458, 1402, 679]) {
      const g = freshGag(sc);
      for (const c of g.ch)
        if ((c.formation || c.tplPlaced) && c.p.bounds()[0] <= DESIGN_W)
          bad.push(sc);
    }
    t('formation/template groups start fully off-canvas', bad.length === 0,
      bad.join(','));
  }

  s.actors.length = 0;
  s.restart();
  return R;
})()
