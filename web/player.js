/* Flying Toasters! — web recreation from reverse-engineered data.
 *
 * Engine model (see ../BEHAVIOR.md + ../RE-NOTES.md):
 *  - Compound frames carry absolute draw rects in a 640x480 design space;
 *    a frame's directory (dx,dy) offsets ALL its rects (GetFrameData).
 *  - Sprite motion: on entering a sequence (incl. loop re-entry), the origin
 *    shifts so that an art shared between the previous frame and the incoming
 *    link frame stays fixed on screen (MoveThroughCommonArtFrame). The link
 *    frame is (label-1) when that frame exists, else the label frame.
 *    All drift (flap glide, food tumble, cloud crawl) emerges from this.
 *  - Queued labels are FRAME ids; resolve to the sequence containing them.
 *  - Logic ticks at 10 Hz.
 */
'use strict';

// Play field fills the window at load (native-size sprites over more sky, like
// the original on a large monitor). 640x480 is the design space the sequence
// rects live in; the karaoke banner anchors within a centered 640x480 box.
let DESIGN_W = 640, DESIGN_H = 480;
const KAR_W = 640, KAR_H = 480;
const TICK_MS = 100;
const SPAWN_MS = 350;                            // min gap between spawns
const ASSETS = '../assets';

const rand = n => Math.floor(Math.random() * n);          // RandShort(n)
const pick = arr => arr[rand(arr.length)];
const now = () => performance.now();

function loadJSON(url) { return fetch(url).then(r => r.json()); }
function loadImage(url) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
}

// ------------------------------------------------------------- sprite banks
class ArtIndex {
  constructor() { this.byId = new Map(); }
  async load(bankIds, banksMeta) {
    const jobs = [];
    for (const b of bankIds) {
      const meta = banksMeta[b];
      if (!meta) continue;
      for (const fid of Object.keys(meta.frames)) {
        const id = Number(fid);
        jobs.push(loadImage(
          `${ASSETS}/sprites/${b}/f${String(id).padStart(3, '0')}.png`
        ).then(im => { if (im) this.byId.set(id, im); }));
      }
    }
    await Promise.all(jobs);
  }
  // compound item art ids are 1-based relative to extractor frame ids
  get(id) { return this.byId.get(id - 1) || null; }
}

// --------------------------------------------------------- compound playback
class Compound {
  constructor(json) {
    this.frames = json.frames;                 // frameNo -> {rect,dx,dy,items}
    this.seqOf = new Map();                    // frameNo -> [frameNos]
    for (const s of json.sequences)
      for (const f of s.frames) this.seqOf.set(f, s.frames);
  }
  frame(no) { return this.frames[String(no)]; }
}

class Player {
  constructor(compound, art) {
    this.c = compound;
    this.art = art;
    this.ox = 0; this.oy = 0;
    this.seq = null; this.idx = 0;
    this.prevFrame = null;                     // last frame obj drawn
  }
  // queued label = frame id; start playing from that frame
  enter(label) {
    const seq = this.c.seqOf.get(label);
    if (!seq) return false;
    const target = this.c.frame(label);
    // link frame: label-1 if it exists (sub-sequence), else the label frame
    const linkNo = this.c.frames[String(label - 1)] ? label - 1 : label;
    const link = this.c.frame(linkNo);
    this._alignCommonArt(this.prevFrame, link);
    this.seq = seq;
    this.idx = seq.indexOf(label);
    this.label = label;
    this.prevFrame = target;
    return true;
  }
  _alignCommonArt(prev, link) {
    if (!prev || !link) return;
    for (const a of prev.items) {
      for (const b of link.items) {
        if (a.art === b.art) {
          this.ox += (a.rect[0] + prev.dx) - (b.rect[0] + link.dx);
          this.oy += (a.rect[1] + prev.dy) - (b.rect[1] + link.dy);
          return;
        }
      }
    }
    // no shared art (common for baby sequences, which change pose art between
    // sequences): keep the sprite where it is by aligning the frame rects, so
    // it continues from its current screen position instead of teleporting to
    // the new sequence's absolute rect.
    this.ox += (prev.rect[0] + prev.dx) - (link.rect[0] + link.dx);
    this.oy += (prev.rect[1] + prev.dy) - (link.rect[1] + link.dy);
  }
  tick() {
    if (this.idx + 1 >= this.seq.length) return 'end';
    this.idx++;
    this.prevFrame = this.cur();
    return 'run';
  }
  cur() { return this.c.frame(this.seq[this.idx]); }
  placeCenter(cx, cy) {
    const fr = this.cur();
    const [l, t, r, b] = fr.rect;
    this.ox = Math.round(cx - (l + r) / 2 - fr.dx);
    this.oy = Math.round(cy - (t + b) / 2 - fr.dy);
  }
  draw(ctx, revealSlots = null) {
    // a frame's item list is the COMPLETE draw set; props not in the current
    // frame simply aren't drawn (no persistence) — matches the engine.
    const fr = this.cur();
    for (const it of fr.items) {
      if (revealSlots && it.artch > 1 && !revealSlots.has(it.artch)) continue;
      const im = this.art.get(it.art);
      if (!im) continue;
      ctx.drawImage(im, this.ox + it.rect[0] + fr.dx,
                        this.oy + it.rect[1] + fr.dy);
    }
  }
  bounds() {
    const fr = this.cur();
    return [this.ox + fr.rect[0] + fr.dx, this.oy + fr.rect[1] + fr.dy,
            this.ox + fr.rect[2] + fr.dx, this.oy + fr.rect[3] + fr.dy];
  }
  offscreen(margin = 35) {
    const [l, t, r, b] = this.bounds();
    return r < -margin || l > DESIGN_W + margin ||
           b < -margin || t > DESIGN_H + margin;
  }
}

// ------------------------------------------------------------ actor catalog
// Toaster behavior implements assets/transitions.json (see RE-TRANSITIONS.md):
// two adult flight families (kinds 1/2) + the baby family (kind 3), per-kind
// label pickers, entry->loop->exit acts with room guards, locked specials.

// RE-NOTES §1: adult food picker RandShort(9) -> queued labels
const FOOD_ROLLS = [3039, 3024, 3019, 3002, 2997, 2979, 2969, 2974, 2974];
// baby food RandShort(6)
const BABYFOOD_ROLLS = [3274, 3279, 3286, 3291, 3296, 3301];
// RE-NOTES §2: clouds — 4 distinct shapes (arts 463/464/465/466). NB: the
// 16 alias labels are NOT evenly spread; 3054/3074/3094/3114 all share art
// 463, so use one label per actual shape here.
const CLOUD_ROLLS = [3053, 3058, 3063, 3068];
const BABYSKY_ROLLS = [3199, 3204, 3209, 3214, 3239, 3244, 3249, 3254, 3259, 3264];
const MOON = 3239, COW = 3244, STARS = 3249;

// RE-NOTES §4: BigGag families B and C. Only SELF-CONTAINED scenarios are
// enabled — ones whose main-channel sequence draws its whole cast from its own
// item list (len>=5). Start-card scenarios (len==1: 2458 diamond, 1402, 2080,
// 679 police-card) and the 3-frame 1227 need the multi-channel sub-actor driver
// (family-A glue, not yet wired) and are omitted so nothing flashes-and-vanishes.
// Police chase survives via self-contained scenario 928. [label, weight]
const GAG_B = [[2391, 2], [2406, 2], [1213, 1], [658, 1],
               [928, 1], [1361, 1], [1372, 1], [2239, 2], [1387, 1], [2272, 1],
               [2298, 1], [2349, 1],
               [878, 2],                          // bagel-eyes (persistent)
               [1232, 1]];                        // evolution morph
const GAG_C = [[2421, 4], [2736, 1], [2910, 1], [1672, 2],
               [1349, 2], [946, 2]];
// scenario -> follow-on. persist = loop this label until offscreen.
const GAG_CHAINS = {
  // 913 (not 912) so the persist loop skips seq 912's bagel-less link frame
  // (f912=[body] only) that caused a 1-frame no-bagel flicker each loop.
  878: { chain: [913], persist: 913 },           // bagel act -> bagel-cruise forever
  // 1288 (not 1287): 1287's first frame (art 500) duplicates its last, causing
  // a 2-same-frames hiccup on loop; entering at 1288 skips that link frame.
  1232: { chain: [1288, 1288, 1303], persist: null }, // morph -> futuristic -> back -> 93
};


class ToasterActor {
  constructor(sv, adultSong) {
    this.sv = sv;
    this.kind3 = false;
    this.weight = 1;
    this.dead = false;
    this.p = new Player(sv.compound, sv.art);
    this.queue = [];
    this.travel = sv.travelCache;              // label -> measured [dx,dy]
    this.adult = adultSong;

    // kind roll (0x19d8d)
    if (adultSong) {
      const r = rand(11);
      this.kind = r === 0 ? 3 : (r <= 5 ? 2 : 1);
    } else this.kind = 3;

    // launch (0x186d9 / 0x19e80)
    if (this.kind === 1) { this.go([3], 3, 0, 1); this.edgeEntry(); }
    else if (this.kind === 2) { this.go([93], 93, 0, 1); this.edgeEntry(); }
    else {
      let L = 983;
      if (!adultSong) {
        const r = rand(24);
        if (r < 8) L = [1038, 1107, 1111, 2391, 1138, 1154, 1173, 1192][r];
      }
      if (L === 983) { this.go([983], 983, 0, 1); this.edgeEntry(); }
      else {
        if (L === 1107) { this.go([1107, 1065], 1107, 1, 0); this.enterAt(DESIGN_W + 40, 200 + rand(DESIGN_H - 200)); }
        else if (L === 1111) { this.go([1111], 1111, 1, 0); this.enterAt(DESIGN_W / 2 - 150 + rand(300), DESIGN_H + 40); }
        else { this.go([L], L, 1, 0); this.edgeEntry(); }
      }
    }
  }
  edgeEntry() {
    const nTop = Math.ceil(DESIGN_W / 160), nRight = Math.ceil(DESIGN_H / 160);
    const k = rand(nTop + nRight);
    if (k < nTop) this.enterAt(k * 160 + rand(160) - 40, -80);
    else this.enterAt(DESIGN_W + 80, (k - nTop) * 80 + rand(80));
  }
  enterAt(cx, cy) { this.p.placeCenter(cx, cy); }

  // queueWithGlue (0x19cc1): leaving a turn-around needs glue 122
  go(labels, s44, s48, s4a) {
    if ((this.s44 === 115 || this.s44 === 105) &&
        labels.length && labels[0] !== 115 && labels[0] !== 122) {
      labels = [122, ...labels];
    }
    this.queue = labels.slice();
    this.s44 = s44; this.s48 = s48; this.s4a = s4a;
    this.startLabel = this.queue[0];
    this._startPos = this.pos();
    this.p.enter(this.queue.shift());
  }
  pos() {
    if (!this.p.seq) return [0, 0];
    const b = this.p.bounds();
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
  // travel guards: measured deltas (self-calibrating); unknown -> assume ok
  predict(labels) {
    let [x, y] = this.pos();
    for (const l of labels) {
      const t = this.travel.get(l);
      if (!t) return null;
      x += t[0]; y += t[1];
    }
    return [x, y];
  }
  room(labels) {
    const p = this.predict(labels);
    if (!p) return true;
    return p[0] > 40 && p[0] < DESIGN_W - 40 && p[1] > 40 && p[1] < DESIGN_H - 40;
  }
  epOff(label) {
    const p = this.predict([label]);
    if (!p) return false;
    return p[0] < 0 || p[0] > DESIGN_W || p[1] < 0 || p[1] > DESIGN_H;
  }

  pickerRoll() {
    if (this.kind === 1) {
      const r = rand(35);
      if (r === 1) return 133;
      if (r === 2) return 172;
      if (r === 3) return 209;
      if (r >= 10 && r <= 19) return 33;
      if (r >= 20 && r <= 29) return 602;
      return 3;
    }
    if (this.kind === 2) {
      const r = rand(30);
      if (r === 2 || r === 3) return 231;
      if (r === 5 || r === 6) return 252;
      if (r >= 10 && r <= 19) return 638;
      return 93;
    }
    const r = rand(80);
    return [988, 1014, 1009, 1019][r] || 983;
  }

  boundary() {
    // record measured travel for the label that just finished
    if (this.startLabel != null && this._startPos) {
      const [x0, y0] = this._startPos, [x1, y1] = this.pos();
      this.travel.set(this.startLabel, [x1 - x0, y1 - y0]);
    }
    if (this.queue.length) {
      this.startLabel = this.queue[0];
      this._startPos = this.pos();
      this.p.enter(this.queue.shift());
      return;
    }
    const s48 = this.s48;
    const L = s48 ? this.s44 : this.pickerRoll();
    if (!this.dispatch(L, s48)) {
      const plain = this.kind === 1 ? 3 : this.kind === 2 ? 93 : 983;
      this.go([plain], plain, 0, 1);
    }
  }

  dispatch(L, s48) {
    const k = this.kind;
    if (k === 1 && L === 33) return this.loopAct(s48, 18, 33, 48, 1);
    if (k === 1 && L === 602) return this.loopAct(s48, 586, 602, 607, 0);
    if (k === 1 && (L === 133 || L === 172 || L === 209)) return this.oneShot(L);
    if (k === 2 && L === 638) return this.loopAct(s48, 622, 638, 643, 0);
    if (k === 2 && (L === 231 || L === 252)) return this.oneShot(L);
    if (k === 3) return this.dispatchK3(L, s48);
    return false;
  }
  loopAct(s48, entry, loop, exit, exitS48) {
    if (s48) {
      if (rand(10) === 0 || !this.room([loop, exit])) this.go([exit], exit, exitS48, 1);
      else this.go([loop], loop, 1, 1);
      return true;
    }
    if (this.room([entry, exit])) { this.go([entry], loop, 1, 1); return true; }
    return false;
  }
  oneShot(L) {
    if (this.epOff(L)) return false;
    this.go([L], L, 0, 1);
    return true;
  }
  dispatchK3(L, s48) {
    const LOCKED = { 1038: 1038, 1107: 1107, 1138: 1138, 1154: 1154, 1173: 1173, 1192: 1192, 2391: 2391 };
    if (LOCKED[L]) { this.go([L], L, 1, 0); return true; }
    if (L === 1111) { this.go([983], 983, 1, 0); return true; }
    if (L === 1009) {
      if (s48) {
        if (rand(10) === 0 && !this.epOff(1019)) { this.go([1019], 1014, 1, 1); return true; }
        if (rand(10) === 0 && !this.epOff(1009)) { this.go([1009], 1009, 1, 1); return true; }
        return false;
      }
      if (this.room([1009, 1009, 1009])) { this.go([1009, 1009, 1009], 1009, 1, 1); return true; }
      return false;
    }
    if (L === 1014) {
      if (s48) {
        // faithful fall-through quirk: both rolls may fire -> [1025, 1014]
        const q = [];
        let s44 = null;
        if (rand(10) === 0 && !this.epOff(1025)) { q.push(1025); s44 = 1009; }
        if (rand(10) === 0 && !this.epOff(1014)) { q.push(1014); s44 = 1014; }
        if (q.length) { this.go(q, s44, 1, 1); return true; }
        return false;
      }
      if (this.room([1014, 1014, 1014])) { this.go([1014, 1014, 1014], 1014, 1, 1); return true; }
      return false;
    }
    if (L === 1019 || L === 1025) {
      if (this.epOff(1019)) return false;
      this.go([1019, 1025], 1025, 0, 1);
      return true;
    }
    if (L === 988 || L === 997 || L === 1003) {
      if (s48) {
        if (rand(5) === 0) return false;
        const pick = [988, 997, 1003][rand(3)];
        if (this.epOff(pick)) return false;
        this.go([pick], pick, 1, 1);
        return true;
      }
      if (!this.epOff(988)) { this.go([988], 988, 1, 1); return true; }
      return false;
    }
    return false;                                // 983 and others -> default
  }

  tick() {
    this.age = (this.age || 0) + 1;
    if (!this.p.offscreen(0)) this.arrived = true;
    if (this.p.tick() !== 'end') return;
    // death: fully past left or bottom edge only (0x179e7 / 0x17a43)
    const b = this.p.bounds();
    if ((b[2] < 0 || b[1] > DESIGN_H) && (this.arrived || this.age > 120)) {
      this.dead = true;
      return;
    }
    // safety: locked specials that drift off top/right would never die
    if (this.p.offscreen(120) && this.age > 400) { this.dead = true; return; }
    this.boundary();
  }
  get kindName() { return this.kind === 3 && !this.adult ? 'baby' : 'toaster'; }
  draw(ctx) { this.p.draw(ctx); }
}

class Actor {
  /* kind: toaster | baby | food | babyfood | cloud | babysky | gag | intro */
  constructor(sv, kind, label) {
    this.sv = sv;
    this.kind = kind;
    this.weight = 1;
    this.p = new Player(sv.compound, sv.art);
    this.dead = false;
    this.loop = null;

    switch (kind) {
      case 'food': case 'babyfood': {
        this.loop = pick(kind === 'food' ? FOOD_ROLLS : BABYFOOD_ROLLS);
        this.p.enter(this.loop);
        this.enterFromEdge();
        break;
      }
      case 'cloud': case 'babysky': {
        let l = pick(kind === 'cloud' ? CLOUD_ROLLS : BABYSKY_ROLLS);
        if ((l === MOON || l === COW)) {
          if (sv.moonActive) l = STARS; else { sv.moonActive = true; this.hasMoon = true; }
        }
        this.loop = l;
        this.p.enter(l);
        this.enterCloud();
        break;
      }
      case 'gag': {
        const fam = label;                       // [label, weight] tuple
        this.loop = null;                        // scenarios run once then disperse
        this.weight = fam[1];
        this.scenario = fam[0];
        // engine follow-on chains (RE-ENGINE.md): morph forward→futuristic loop
        // →morph back→plain; bagel-eyes act→bagel-cruise (persists til offscreen)
        const spec = GAG_CHAINS[fam[0]];
        this.gagChain = spec ? spec.chain.slice() : null;
        this.gagPersist = spec ? (spec.persist ?? null) : null;
        this.p.enter(fam[0]);
        this.enterFromEdge();
        sv.playSound(22010);                     // gag whoosh (RE-ENGINE.md)
        if (fam[0] === 928) sv.playSound(22001);            // fire / burning
        else if (fam[0] === 679 || fam[0] === 1349) sv.playSound(22005); // police siren
        else if (fam[0] === 1232 || fam[0] === 1288) sv.playSound(22012); // morph warp
        break;
      }
      case 'intro': {
        this.p.enter(3133);
        this.p.placeCenter(DESIGN_W / 2, DESIGN_H / 2);
        this.chain = [115, 122];
        break;
      }
    }
  }
  // RE-NOTES entry placement: lanes along top (160px) and right (80px) edges
  enterFromEdge() {
    const nTop = Math.ceil(DESIGN_W / 160), nRight = Math.ceil(DESIGN_H / 160);
    const k = rand(nTop + nRight);
    if (k < nTop) this.p.placeCenter(k * 160 + rand(160) - 40, -80);
    else this.p.placeCenter(DESIGN_W + 80, (k - nTop) * 80 + rand(80));
  }
  enterCloud() {
    const sy = Math.floor(DESIGN_H / 100), sx = Math.floor(DESIGN_W / 100);
    const k = rand(sx + sy + 1);
    if (k < sy) this.p.placeCenter(-50, 100 * k + 50);
    else this.p.placeCenter(100 * (k - sy) - 50, -50);
  }
  tick() {
    this.age = (this.age || 0) + 1;
    if (!this.p.offscreen(0)) this.arrived = true;
    if (this.p.tick() !== 'end') return;
    // sequence boundary: cull only after the actor has actually been seen
    // (entry placement starts beyond the offscreen margin)
    if (this.p.offscreen() && (this.arrived || this.age > 80)) { this.die(); return; }
    if (this.kind === 'intro') {
      if (this.chain.length) { this.p.enter(this.chain.shift()); return; }
      this.p.enter(93);
      return;
    }
    if (this.kind === 'gag') {
      // scenario finished: follow the engine's chain (RE-ENGINE.md), which is
      // either a persistent transform (bagel-eyes/morph loop) or disperse-to-93
      if (this.gagChain && this.gagChain.length) {
        this.p.enter(this.gagChain.shift());
        return;
      }
      if (this.gagPersist != null) {             // loop the transformed cruise
        this.p.enter(this.gagPersist);
        return;
      }
      this.p.enter(93);
      this.kind = 'gag-out';
      return;
    }
    if (this.kind === 'gag-out') { this.p.enter(93); return; }
    this.p.enter(this.loop);                     // food/cloud re-queue same
  }
  die() {
    this.dead = true;
    if (this.hasMoon) this.sv.moonActive = false;
  }
  draw(ctx) { this.p.draw(ctx); }
}

// ------------------------------------------------------------- debug harness
// Plays ONE labeled chain, isolated, looping in place so an act can be judged.
// startAt = fraction down the entry lane so it drifts across the middle.
class DebugActor {
  constructor(sv, chain, loop = true) {
    this.sv = sv;
    this.kind = 'debug';
    this.dead = false;
    this.weight = 0;
    this.doLoop = loop;
    this.p = new Player(sv.compound, sv.art);
    this.chain = chain.slice();
    this.original = chain.slice();
    this.p.enter(this.chain.shift());
    this.recenter();
  }
  recenter() {
    // start upper-right so the natural down-left drift crosses the visible
    // center (the debug sidebar overlays the canvas's left ~210px)
    this.p.placeCenter(DESIGN_W * 0.7, DESIGN_H * 0.28);
  }
  tick() {
    if (this.p.tick() !== 'end') return;
    if (this.chain.length) { this.p.enter(this.chain.shift()); return; }
    if (!this.doLoop) {
      // one-shot: after the chain, drift on plain flight (like the swarm does)
      this.p.enter(93);
      if (this.p.offscreen(20)) this.recenter();
      return;
    }
    // loop the whole chain; recenter if it wandered off so it stays watchable
    this.chain = this.original.slice();
    this.p.enter(this.chain.shift());
    if (this.p.offscreen(20)) this.recenter();
  }
  draw(ctx) { this.p.draw(ctx); }
}

// ------------------------------------------------------------------ karaoke
class Karaoke {
  constructor(sv) {
    this.sv = sv;
    this.c = sv.karCompound;
    this.reset(0);
  }
  reset(song) {
    this.song = song;
    this.events = this.sv.karaokeTables[String(song)].events;
    this.i = -1;
    this.deadline = 0;            // durations are deltas accumulated by the loop
    this.t = 0;
    this.line = 0;
    this.reveal = new Set();
    this.bagelX = null;
    this.bagelTarget = null;
    this.bagel = new Player(this.sv.compound, this.sv.art);
    this.bagel.enter(3305);                      // winged bagel flap (seq 3304)
  }
  wordCenter(slot) {
    const fr = this.c.frame(this.line);
    if (!fr) return null;
    const it = fr.items.find(i => i.artch === slot);
    return it ? (it.rect[0] + it.rect[2]) / 2 : null;
  }
  tick(ms, absMs) {
    // when music drives it, snap the clock to audio playback time (stays in
    // sync); otherwise advance by the tick delta
    if (absMs != null) {
      if (absMs < this.t) this.reset(this.song);   // song looped
      this.t = absMs;
    } else this.t += ms;
    while (this.t >= this.deadline && this.i < this.events.length - 1) {
      this.i++;
      const e = this.events[this.i];
      this.deadline += e.ms || 0;
      if (e.ev === 0) {
        this.line = e.line; this.reveal = new Set();
        this.bagelX = null;
      } else if (e.ev === 1 || e.ev === 2) {
        this.line = e.line; this.reveal.add(e.word);
        const cx = this.wordCenter(e.word);
        if (cx != null) {
          if (this.bagelX == null) this.bagelX = cx;
          // arrive quickly (lead ~ the highlight) instead of drifting over the
          // whole syllable, which lagged behind the red word
          const hop = Math.min(e.ms || 1, 180);
          this.bagelTarget = { x: cx, t0: this.t, t1: this.t + hop, x0: this.bagelX };
        }
      } else if (e.ev === 4) {
        if (this.i >= this.events.length - 1) this.reset(this.song);
        else if (this.events[this.i + 1] && this.events[this.i + 1].ev === 4) { /* sentinel next */ }
        this.lineEndAt = this.deadline;
      }
    }
    if (this.t >= (this.lineEndAt || Infinity)) { this.line = 0; this.lineEndAt = null; }
    // bagel interpolation + flap
    if (this.bagelTarget) {
      const { x, t0, t1, x0 } = this.bagelTarget;
      const f = Math.min(1, (this.t - t0) / Math.max(1, t1 - t0));
      this.bagelX = x0 + (x - x0) * f;
    }
    if (this.bagel.tick() === 'end') this.bagel.enter(3305);
  }
  draw(ctx) {
    if (!this.line) return;
    const fr = this.c.frame(this.line);
    if (!fr) return;
    // anchor the karaoke box: horizontally centered, pinned to the bottom
    const kx = Math.round((DESIGN_W - KAR_W) / 2), ky = DESIGN_H - KAR_H;
    for (const it of fr.items) {
      if (it.artch > 1 && !this.reveal.has(it.artch)) continue;
      const im = this.sv.karArt.get(it.art);
      if (im) ctx.drawImage(im, kx + it.rect[0], ky + it.rect[1]);
    }
    if (this.bagelX != null) {
      const bfr = this.bagel.cur();
      const w = bfr.rect[2] - bfr.rect[0], h = bfr.rect[3] - bfr.rect[1];
      this.bagel.ox = Math.round(kx + this.bagelX - w / 2 - bfr.rect[0]);
      this.bagel.oy = Math.round(ky + fr.rect[1] - 31 - h - bfr.rect[1]);
      this.bagel.draw(ctx);
    }
  }
}

// --------------------------------------------------------------- controller
class Screensaver {
  constructor(assets) {
    Object.assign(this, assets);
    this.actors = [];
    this.settings = { objects: 50, toasters: 0, karaoke: false, sound: false };
    this.songType = 0;
    this.karaoke = new Karaoke(this);
    this.moonActive = false;
    this.travelCache = new Map();
    this.lastCloud = -1e9; this.lastGag = -1e9;
    this.lastGagB = -1e9; this.lastGagC = -1e9;
    this.audioCtx = null;
    this.sfxCache = new Map();                    // wav id -> decoded AudioBuffer
    this.music = { buffer: null, src: null, startAt: 0, song: null };
    this.settings.music = false;
    this.introRunning = false;
  }

  audio() {
    if (!this.audioCtx)
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  maxObjects() {
    const density = (DESIGN_W * DESIGN_H) / 480000;
    let n = density * (this.songType === 1 ? 22 : 30);
    const o = this.settings.objects;
    if (o >= 75) { /* swarm */ }
    else if (o >= 50) n *= 0.5;
    else if (o >= 25) n *= 0.25;
    else n = this.songType === 1 ? 5 : 3;
    return Math.max(1, Math.round(n));
  }
  maxClouds() {
    const density = (DESIGN_W * DESIGN_H) / 480000;
    const o = this.settings.objects;
    if (o < 25) return 0;
    let n = density * 3;
    if (o < 50) n *= 0.5;
    return Math.max(1, Math.round(n));
  }
  babyMode() {
    if (this.settings.toasters === 1) return true;
    if (this.settings.toasters === 2) return this.songType === 1;
    return false;
  }
  population() {
    return this.actors.reduce((s, a) =>
      s + (a.kind === 'cloud' || a.kind === 'babysky' ? 0 : a.weight), 0);
  }

  playIntro() {
    this.actors = [];
    this.actors.push(new Actor(this, 'intro'));
    this.introRunning = true;
  }

  spawnGag() {
    const t = now();
    const roll = rand(3);
    let table = null;
    if (roll === 0 && t > this.lastGagC + 15000) { table = GAG_C; this.lastGagC = t; }
    else if (roll <= 1 && t > this.lastGagB + 6000) { table = GAG_B; this.lastGagB = t; }
    else { table = GAG_B; this.lastGagB = t; }    // family A pending -> B
    this.actors.push(new Actor(this, 'gag', pick(table)));
  }

  spawn() {
    const baby = this.babyMode();
    const t = now();
    const clouds = this.actors.filter(a => a.kind === 'cloud' || a.kind === 'babysky').length;
    if (clouds < this.maxClouds() && t > this.lastCloud + 5000) {
      this.lastCloud = t;
      this.actors.push(new Actor(this, baby ? 'babysky' : 'cloud'));
      return;
    }
    const r = rand(5);
    if (r === 1 && !baby && t > this.lastGag + 2000 &&
        !this.actors.some(a => a.kind === 'gag')) {
      this.lastGag = t;
      this.spawnGag();
      return;
    }
    const toasters = this.actors.filter(a => a instanceof ToasterActor).length;
    const food = this.actors.filter(a => a.kind === 'food' || a.kind === 'babyfood').length;
    const ratio = food > 0 ? toasters / food : 4.0;
    const wantFood = (r === 2 && ratio > 2.0) || (r >= 3 && ratio > 4.0);
    if (wantFood) this.actors.push(new Actor(this, baby ? 'babyfood' : 'food'));
    else this.actors.push(new ToasterActor(this, !baby));
    // (no per-spawn sound — the engine's WAVs are gag SFX; swarm is music-only)
  }

  // WAV id -> decoded buffer -> play. Gag SFX per RE-ENGINE.md sound map.
  playSound(id, gain = 1) {
    if (!this.settings.sound || !this.sounds[id]) return;
    const ctx = this.audio();
    const fire = buf => {
      const s = ctx.createBufferSource(); s.buffer = buf;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(g); g.connect(ctx.destination); s.start();
    };
    const cached = this.sfxCache.get(id);
    if (cached) return fire(cached);
    ctx.decodeAudioData(this.sounds[id].slice(0),
      d => { this.sfxCache.set(id, d); fire(d); });
  }

  // Music: play the matching song, aligned so karaoke can read playback time.
  playMusic(song) {
    const ctx = this.audio();
    const buf = this.music.buffers && this.music.buffers[song];
    if (!buf) { this.music.pending = song; return; }
    this.stopMusic();
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.connect(ctx.destination); s.start();
    this.music.src = s; this.music.startAt = ctx.currentTime; this.music.song = song;
  }
  stopMusic() {
    if (this.music.src) { try { this.music.src.stop(); } catch {} this.music.src = null; }
  }
  musicMs() {
    if (!this.music.src) return null;
    return (this.audioCtx.currentTime - this.music.startAt) * 1000;
  }

  setDebug(actor) {
    this.debugActor = actor;
    if (actor && this.debugSolo) { this.actors = []; this.introRunning = false; }
  }

  tick() {
    if (this.debugActor) {
      this.debugActor.tick();
      if (!this.debugSolo) {                      // swarm continues alongside
        for (const a of this.actors) a.tick();
        this.actors = this.actors.filter(a => !a.dead);
        if (this.population() < this.maxObjects()) this.spawn();
      }
      return;
    }
    if (this.introRunning) {
      const intro = this.actors[0];
      intro.tick();
      if (intro.dead) { this.introRunning = false; this.actors = []; }
      return;                                    // intro runs exclusively
    }
    if (this.settings.toasters !== 2) this.songType = this.settings.toasters;
    for (const a of this.actors) a.tick();
    this.actors = this.actors.filter(a => !a.dead);
    // Stagger spawns so toasters enter continuously and spread (not a burst),
    // but fill in a roughly fixed time regardless of field size: interval
    // scales inversely with the population target (big window → faster fill).
    const t = now();
    const max = this.maxObjects();
    const interval = Math.max(120, SPAWN_MS * 20 / max);   // ~7s to fill
    if (this.population() < max && t > (this._lastSpawn || 0) + interval) {
      this._lastSpawn = t;
      this.spawn();
    }
    if (this.settings.karaoke) this.karaoke.tick(TICK_MS, this.musicMs());
  }

  draw(ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    if (this.debugActor && this.debugSolo) { this.debugActor.draw(ctx); return; }
    if (this.debugActor) this.debugActor.draw(ctx);
    // clouds/sky behind everything
    for (const a of this.actors)
      if (a.kind === 'cloud' || a.kind === 'babysky') a.draw(ctx);
    for (const a of this.actors)
      if (!(a.kind === 'cloud' || a.kind === 'babysky')) a.draw(ctx);
    if (this.settings.karaoke && !this.introRunning) this.karaoke.draw(ctx);
  }
}

// -------------------------------------------------------------------- boot
async function boot() {
  const [banksMeta, comp22000, comp22100, karaokeTables] = await Promise.all([
    loadJSON(`${ASSETS}/sprites/banks.json`),
    loadJSON(`${ASSETS}/compound_22000.json`),
    loadJSON(`${ASSETS}/compound_22100.json`),
    loadJSON(`${ASSETS}/karaoke.json`),
  ]);
  const ids = Object.keys(banksMeta).map(Number);
  const art = new ArtIndex(), karArt = new ArtIndex();
  await Promise.all([
    art.load(ids.filter(b => b < 22100), banksMeta),
    karArt.load(ids.filter(b => b >= 22100), banksMeta),
  ]);
  const sounds = {};
  for (let id = 22000; id <= 22012; id++) {
    fetch(`${ASSETS}/sounds/${id}.wav`).then(r => r.arrayBuffer())
      .then(b => { sounds[id] = b; }).catch(() => {});
  }

  const saver = new Screensaver({
    art, karArt,
    compound: new Compound(comp22000),
    karCompound: new Compound(comp22100),
    banksMeta, karaokeTables, sounds,
  });
  window.saver = saver;                          // debug hook

  // music: decode the two karaoke songs (WebAudio) once an AudioContext exists
  saver.music.buffers = {};
  const decodeMusic = () => {
    const ctx = saver.audio();
    for (const song of [0, 1]) {
      if (saver.music.buffers[song]) continue;
      fetch(`${ASSETS}/music/song${song}.ogg`).then(r => r.arrayBuffer())
        .then(b => ctx.decodeAudioData(b))
        .then(buf => {
          saver.music.buffers[song] = buf;
          if (saver.music.pending === song) { saver.music.pending = null; saver.playMusic(song); }
        }).catch(() => {});
    }
  };

  document.getElementById('loading').classList.add('hidden');

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // fill the window at load: field = window size, native-size sprites, 1:1
  function fitField() {
    DESIGN_W = Math.max(KAR_W, Math.round(window.innerWidth));
    DESIGN_H = Math.max(KAR_H, Math.round(window.innerHeight));
    canvas.width = DESIGN_W; canvas.height = DESIGN_H;
    canvas.style.width = `${DESIGN_W}px`; canvas.style.height = `${DESIGN_H}px`;
    ctx.imageSmoothingEnabled = false;
  }
  fitField();
  // live re-fit on resize (no reload — avoids F12/devtools docking reloading
  // the page). The field is just a coordinate space; in-flight actors continue.
  window.addEventListener('resize', fitField);

  const panel = document.getElementById('panel');
  const togglePanel = () => panel.classList.toggle('hidden');
  window.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(); });
  canvas.addEventListener('click', togglePanel);
  document.getElementById('close-btn').onclick = togglePanel;
  document.getElementById('objects').onchange = e => { saver.settings.objects = +e.target.value; };
  const syncMusic = () => {
    if (saver.settings.music) { decodeMusic(); saver.playMusic(saver.songType); }
    else saver.stopMusic();
  };
  document.getElementById('toasters').onchange = e => {
    saver.settings.toasters = +e.target.value;
    if (saver.settings.toasters === 2) saver.songType = rand(2);
    if (saver.settings.karaoke) saver.karaoke.reset(saver.songType);
    if (saver.settings.music) syncMusic();
  };
  document.getElementById('karaoke').onchange = e => {
    saver.settings.karaoke = e.target.checked;
    if (e.target.checked) {
      saver.karaoke.reset(saver.songType);
      // karaoke wants the song playing to stay in sync
      if (!saver.settings.music) {
        saver.settings.music = true;
        document.getElementById('music').checked = true;
        syncMusic();
      }
    }
  };
  document.getElementById('music').onchange = e => {
    saver.settings.music = e.target.checked;
    syncMusic();
    reflectSound();
  };
  document.getElementById('sound').onchange = e => {
    saver.settings.sound = e.target.checked;
    if (e.target.checked) saver.audio();         // unlock audio on user gesture
    reflectSound();
  };
  document.getElementById('intro-btn').onclick = () => { saver.playIntro(); togglePanel(); };
  document.getElementById('debug-btn').onclick = () => { buildDebug(saver); togglePanel(); };

  // Prominent top-left sound toggle: doubles as the user-gesture that unlocks
  // WebAudio (browsers block autoplay on load). Turns music + SFX on together.
  const soundBtn = document.getElementById('sound-btn');
  function reflectSound() {
    const on = saver.settings.music || saver.settings.sound;
    soundBtn.textContent = on ? '🔊 sound on' : '🔇 sound off';
    soundBtn.classList.toggle('on', on);
    document.getElementById('music').checked = saver.settings.music;
    document.getElementById('sound').checked = saver.settings.sound;
  }
  soundBtn.onclick = () => {
    const on = !(saver.settings.music || saver.settings.sound);
    saver.audio();                               // unlock on this gesture
    if (saver.audioCtx) saver.audioCtx.resume();
    saver.settings.music = on;
    saver.settings.sound = on;
    syncMusic();
    reflectSound();
  };
  reflectSound();

  saver.playIntro();                             // authentic: intro on activation

  let acc = 0, last = performance.now();
  function frame(t) {
    acc += t - last; last = t;
    // rAF is throttled/paused when the tab is hidden; on return, `acc` can be
    // huge. Clamp catch-up to a few ticks so we don't storm-spawn or freeze
    // (the swarm just resumes where it was rather than fast-forwarding).
    if (acc > 5 * TICK_MS) acc = TICK_MS;
    let stepped = false;
    while (acc >= TICK_MS) { acc -= TICK_MS; saver.tick(); stepped = true; }
    if (stepped) saver.draw(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------ debug button harness
// Each entry: [label, chain]. Chain plays looped in isolation for judging.
const DEBUG_CATALOG = {
  'Adult flight': [
    ['cruise 1 (label 3)', [3]],
    ['cruise 2 (label 93)', [93]],
    ['coil heat act (18→33→48)', [18, 33, 33, 48]],
    ['act 586→602→607 (cruise 3)', [586, 602, 602, 607]],
    ['fly up (133)', [133]], ['go around (172)', [172]],
    ['slow/lane (209)', [209]],
    ['change lane (231)', [231]], ['change lane 2 (252)', [252]],
    ['638 act (622→638→643)', [622, 638, 638, 643]],
    ['slow down? (105)', [105, 122]], ['turn/back-skip (115)', [115, 122]],
  ],
  'Transforms (persistent chains)': [
    // RE-ENGINE.md: these chain to a follow-on that PERSISTS until offscreen.
    // Loops enter at runStart+1 to skip the link frame (avoids debug flicker).
    ['bagel-eyes FULL (878→913)', [878, 913, 913, 913]],
    ['bagel-cruise only (913)', [913]],
    ['coil glow 945 (=mega 946)', [945]],
    ['TOAST POP 748 (juggle→pop)', [748]],
    ['MORPH evolution (1232→1288→1303)', [1232, 1288, 1288, 1303, 3]],
    ['futuristic cruise (1288)', [1288]],
    ['morph forward only (1232)', [1232]],
  ],
  'Food': [
    ['cracker (3039)', [3039]], ['bagel (3024)', [3024]],
    ['waffle (3019)', [3019]], ['golden toast (3002)', [3002]],
    ['brown bread (2997)', [2997]], ['brown bread moving (2979)', [2979]],
    ['static toast (2969)', [2969]], ['static golden (2974)', [2974]],
    ['jam toast juggle (1371)', [1371]],   // jam arts 330/331 only appear in gags
  ],
  'Sky': [
    // clouds were all art 463; these 4 labels hit the 4 distinct shapes
    ['cloud A (463)', [3053]], ['cloud B (464)', [3058]],
    ['cloud C (465)', [3063]], ['cloud D (466)', [3068]],
    ['(baby) moon 3239', [3239]], ['(baby) cow 3244', [3244]],
    ['(baby) stars 3249', [3249]],
  ],
  'Gags': [
    ['power cord 2421', [2421]], ['burning toaster (928)', [928]],
    ['solo stunt 658', [658]],
    ['toast goes in (792)', [792]], ['toast juggle cont (807)', [807]],
    ['diamond 2458', [2458]], ['finale 2910', [2910]],
    ['donkey hops / leapfrog (2239)', [2239]], ['love waffles (2272)', [2272]],
    ['hoola hoop (1361)', [1361]], ['juggle 1372', [1372]],
    ['toast+toaster 1213', [1213]], ['flip-over (946)', [946]],
    ['police card 679', [679]], ['3-wedge 2736', [2736]],
  ],
  '(baby) flight': [
    ['plain 983', [983]], ['wander 988', [988]], ['wander 997', [997]],
    ['wander 1003', [1003]], ['ladder 1009', [1009]], ['ladder 1014', [1014]],
    ['swoop 1019→1025', [1019, 1025]],
    ['special 1038', [1038]], ['special 1065', [1065]], ['special 1107', [1107, 1065]],
    ['special 1111', [1111]], ['special 1138 (mom+babies)', [1138]],
    ['special 1154', [1154]], ['special 1173', [1173]], ['special 1192', [1192]],
    ['mother 2391', [2391]], ['mother 2406', [2406]],
  ],
  '(baby) food': [
    ['duck 3274', [3274]], ['duck wiggle 3279', [3279]], ['bottle 3286', [3286]],
    ['pacifier 3291', [3291]], ['teddy 3296', [3296]], ['crib 3301', [3301]],
  ],
};

const REVIEW_KEY = 'ftReviews';
function loadReviews() {
  try { return JSON.parse(localStorage.getItem(REVIEW_KEY)) || {}; }
  catch { return {}; }
}
function saveReviews(r) { localStorage.setItem(REVIEW_KEY, JSON.stringify(r)); }

function buildDebug(saver) {
  let bar = document.getElementById('debugbar');
  if (bar) {
    bar.remove();
    const rp = document.getElementById('reviewpanel');
    if (rp) rp.remove();
    if (bar._keyHandler) window.removeEventListener('keydown', bar._keyHandler);
    saver.setDebug(null);
    return;
  }
  const reviews = loadReviews();

  bar = document.createElement('div');
  bar.id = 'debugbar';
  const title = document.createElement('div');
  title.className = 'dbg-title';
  title.textContent = 'Debug — play one act (looped, isolated)';
  bar.appendChild(title);
  const auto = document.createElement('label');
  auto.className = 'dbg-auto';
  auto.innerHTML = '<input type="checkbox" id="dbg-solo" checked> solo (pause the swarm)';
  bar.appendChild(auto);
  const loopLbl = document.createElement('label');
  loopLbl.className = 'dbg-auto';
  loopLbl.innerHTML = '<input type="checkbox" id="dbg-loop" checked> loop act ' +
    '(off = play once, then plain flight — matches the swarm)';
  bar.appendChild(loopLbl);

  const byNum = {};
  let n = 0;
  const mark = (b, id) => {
    const rv = reviews[id];
    b.classList.toggle('rv-v', rv && rv.verdict === 'V');
    b.classList.toggle('rv-x', rv && rv.verdict === 'X');
    b.dataset.tag = rv && rv.verdict ? (rv.verdict === 'V' ? '✓' : '✗') : '';
  };
  for (const [group, items] of Object.entries(DEBUG_CATALOG)) {
    const h = document.createElement('div');
    h.className = 'dbg-group';
    h.textContent = group;
    bar.appendChild(h);
    for (const [name, chain] of items) {
      n++;
      const num = n;                             // capture per-iteration
      const id = chain.join('-');                // stable per-act key
      const b = document.createElement('button');
      b.dataset.num = num; b.dataset.id = id;
      b.dataset.defname = name; b.dataset.group = group;
      const render = () => {
        const disp = (reviews[id] && reviews[id].name) || name;
        b.innerHTML = `<span class="dbg-num">${num}</span>${disp}` +
          `<span class="dbg-tag"></span>`;
        mark(b, id);
      };
      render();
      b._render = render;
      byNum[n] = b;
      b.onclick = () => {
        saver.debugSolo = document.getElementById('dbg-solo').checked;
        const doLoop = document.getElementById('dbg-loop').checked;
        saver.setDebug(new DebugActor(saver, chain, doLoop));
        bar.querySelectorAll('button[data-id]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        showReview(b);
      };
      bar.appendChild(b);
    }
  }
  const clear = document.createElement('button');
  clear.textContent = '✕ resume swarm';
  clear.className = 'dbg-clear';
  clear.onclick = () => {
    saver.setDebug(null);
    bar.querySelectorAll('button[data-id]').forEach(x => x.classList.remove('active'));
  };
  bar.appendChild(clear);

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 copy all reviews (JSON)';
  copyBtn.className = 'dbg-copy';
  copyBtn.onclick = () => {
    const out = [];
    for (const [group, items] of Object.entries(DEBUG_CATALOG))
      for (const [name, chain] of items) {
        const id = chain.join('-');
        const rv = reviews[id];
        if (rv && (rv.verdict || rv.name || rv.notes))
          out.push({ act: id, group, default_name: name,
                     verdict: rv.verdict || null, name: rv.name || null,
                     notes: rv.notes || null });
      }
    const json = JSON.stringify(out, null, 2);
    navigator.clipboard.writeText(json).then(
      () => { copyBtn.textContent = `✓ copied ${out.length} reviews`; setTimeout(() => copyBtn.textContent = '📋 copy all reviews (JSON)', 1500); },
      () => { window.prompt('Copy manually:', json); });
  };
  bar.appendChild(copyBtn);
  document.body.appendChild(bar);

  // ---- review panel (bottom, under the canvas) ----
  const rp = document.createElement('div');
  rp.id = 'reviewpanel';
  rp.innerHTML = `
    <div class="rp-head"><span id="rp-title">select an act to review</span></div>
    <div class="rp-body">
      <div class="rp-row">
        <button id="rp-v">✓ good</button>
        <button id="rp-x">✗ bad</button>
        <input id="rp-name" placeholder="rename this act…" />
      </div>
      <textarea id="rp-notes" placeholder="notes / what's wrong…" rows="3"></textarea>
    </div>`;
  document.body.appendChild(rp);

  let current = null;                            // the active catalog button
  function showReview(b) {
    current = b;
    const id = b.dataset.id;
    const rv = reviews[id] || {};
    document.getElementById('rp-title').textContent =
      `#${b.dataset.num} · ${b.dataset.group} · ${b.dataset.defname} (${id})`;
    document.getElementById('rp-name').value = rv.name || '';
    document.getElementById('rp-notes').value = rv.notes || '';
    document.getElementById('rp-v').classList.toggle('on', rv.verdict === 'V');
    document.getElementById('rp-x').classList.toggle('on', rv.verdict === 'X');
  }
  function put(field, val) {
    if (!current) return;
    const id = current.dataset.id;
    reviews[id] = reviews[id] || {};
    reviews[id][field] = val;
    saveReviews(reviews);
    current._render();
    current.classList.add('active');
    if (field === 'verdict') showReview(current);
  }
  document.getElementById('rp-v').onclick = () =>
    put('verdict', reviews[current && current.dataset.id]?.verdict === 'V' ? null : 'V');
  document.getElementById('rp-x').onclick = () =>
    put('verdict', reviews[current && current.dataset.id]?.verdict === 'X' ? null : 'X');
  document.getElementById('rp-name').oninput = e => put('name', e.target.value.trim() || null);
  document.getElementById('rp-notes').oninput = e => put('notes', e.target.value.trim() || null);
  saver._showReview = showReview;

  // type a number then Enter to fire that button
  let typed = '';
  bar._keyHandler = e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key >= '0' && e.key <= '9') typed += e.key;
    else if (e.key === 'Enter' && typed) { byNum[typed] && byNum[typed].click(); typed = ''; }
    else typed = '';
  };
  window.addEventListener('keydown', bar._keyHandler);
}

boot();
