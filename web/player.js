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
// dev serves web/index.html with assets one level up (../assets); the built site
// puts index.html and assets/ side by side at the served root (assets).
const ASSETS = location.pathname.includes('/web/') ? '../assets' : 'assets';

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
// Drop the opaque black backdrop from a sprite: the karaoke line/word arts are
// white/red text on a black BOX, which shows a faint "tear" at its edges over
// the night sky. Make near-black pixels transparent so only the glyphs remain.
function dropBlackBox(im) {
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    // fade out dark pixels (box + heavy outline); keep bright glyph pixels.
    const lum = Math.max(px[i], px[i + 1], px[i + 2]);
    if (lum < 60) px[i + 3] = 0;
    else if (lum < 110) px[i + 3] = Math.round(px[i + 3] * (lum - 60) / 50);
  }
  g.putImageData(d, 0, 0);
  return c;
}

class ArtIndex {
  constructor() { this.byId = new Map(); }
  async load(bankIds, banksMeta, process) {
    const jobs = [];
    for (const b of bankIds) {
      const meta = banksMeta[b];
      if (!meta) continue;
      for (const fid of Object.keys(meta.frames)) {
        const id = Number(fid);
        jobs.push(loadImage(
          `${ASSETS}/sprites/${b}/f${String(id).padStart(3, '0')}.png`
        ).then(im => { if (im) this.byId.set(id, process ? process(im) : im); }));
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
  constructor(compound, art, sv) {
    this.c = compound;
    this.art = art;
    this.sv = sv;                              // for frame-triggered sounds
    this.ox = 0; this.oy = 0;
    this.seq = null; this.idx = 0;
    this.prevFrame = null;                     // last frame obj drawn
  }
  // engine binds sounds to sequence labels (ToasterControl::IToasterControl);
  // fire when playback reaches a bound frame (toast pops, conga drum, flutter…)
  _soundAt(frame) {
    const w = this.sv && this.sv.soundMap && this.sv.soundMap[frame];
    if (w) this.sv.playSound(w);
  }
  // queued label = frame id; start playing from that frame
  enter(label) {
    const seq = this.c.seqOf.get(label);
    if (!seq) return false;
    const target = this.c.frame(label);
    // link frame: label-1 if it exists (sub-sequence), else the label frame.
    // (The hold-transform loops' divergent drifts — 307 up-left, 324 down-right
    // mirrored, 638 slow-left — are AUTHORED per-frame displacements: the 2736
    // wedge deliberately scatters after its acts. Not an alignment bug.)
    const linkNo = this.c.frames[String(label - 1)] ? label - 1 : label;
    const link = this.c.frame(linkNo);
    this._alignCommonArt(this.prevFrame, link);
    this.seq = seq;
    this.idx = seq.indexOf(label);
    this.label = label;
    this.prevFrame = target;
    this._soundAt(seq[this.idx]);
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
    this._soundAt(this.seq[this.idx]);
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

// Cull safety net (ticks): the engine removes a sprite when its ±35px box leaves
// the screen (0x1798f), guarded by having-been-seen. This only bounds the
// degenerate case of a sprite that spawns off-screen and never enters — one
// value in place of the old ad-hoc 80/120/250/400 age constants.
const CULL_MAX_TICKS = 400;

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

// Authentic gag selection (family pickers 0x10cd2/0x10d85/0x10e51 — RandShort
// into these jump tables). Top level (0x10c24): RandShort(3) picks a family:
// 0 -> C (>=15s gate), 1 -> B (>=6s gate), 2 -> A (always); gated families
// fall back toward A. Every scenario's choreography comes from gags.json.
const FAM_A = [1782, 1928, 792, 807, 749, 861, 274, 295, 312, 329, 558, 456];
const FAM_B = [2391, 2406, 1213, 1227, 1288, 658, 928, 1361, 1372, 2239, 1387, 2272, 2298];
const FAM_C = [2421, 2458, 2736, 2910, 1402, 1672, 2080, 679, 1349, 879];
// scenario-specific SFX (RE-ENGINE.md sound map). WAV 22010 is NOT a universal
// gag whoosh — the enable flag +0x84 is armed only for the power-cord gag 2421
// (0x128af). Most gags are silent (music only); these are the exceptions.
// Per-scenario gag SFX (values binary-verified). TODO(#6, open): fold into the
// extractor. A single PlayNoise (0x422fcf) scan is NOT sufficient — it reproduces
// fire 928 / police 1349 / morph 1288 but MISSES cord 2421 and 679 (their sound is
// armed via a flag, not a direct call) and adds a spurious 22000 to 1288. Needs
// the flag-armed path modeled too; until then this correct table stands.
const SCEN_SFX = { 2421: 22010, 928: 22001, 679: 22005, 1349: 22005, 1288: 22012 };


class ToasterActor {
  constructor(sv, adultSong) {
    this.sv = sv;
    this.kind3 = false;
    this.weight = 1;
    this.dead = false;
    this.p = new Player(sv.compound, sv.art, sv);
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
    // Flight state machine (FlyingToaster handlers: kind1 @0x419198, kind2
    // @0x418fc8, kind3/baby @0x188cf, dispatched on [ebx+0x40]=kind). At a
    // flight-loop boundary the engine rolls RandShort(10) (0x422f51) and only
    // breaks into a special act on 0 — ~10% — and even then only if an on-screen
    // room check (0x419b0b/0x41987f) passes; otherwise it keeps cruising. This
    // 10% gate is the extracted figure (was a ~66% guess, which made flight far
    // too busy). The exact choice among a kind's acts lives in the s44/s48 launch
    // state machine (not fully lifted); picked uniformly here.
    const cruise = this.kind === 1 ? 3 : this.kind === 2 ? 93 : 983;
    if (rand(10) !== 0) return cruise;                 // ~90%: keep cruising
    if (this.kind === 1) return pick([33, 133, 172, 209, 602]);
    if (this.kind === 2) return pick([638, 231, 252]);
    return pick([988, 1014, 1009, 1019]);              // baby specials
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
    // Ground-truth cull: the engine removes a sprite once its ±35px box (0x1798f)
    // leaves the screen. `arrived` guards the entry lane (spawn starts beyond the
    // margin), and CULL_MAX_TICKS is a single never-arrived safety (a bad spawn
    // that never enters) — replacing the old per-case 120/400 age constants.
    if (this.p.offscreen() && (this.arrived || this.age > CULL_MAX_TICKS)) {
      this.dead = true;
      return;
    }
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
    this.p = new Player(sv.compound, sv.art, sv);
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
    // (entry placement starts beyond the ±35 margin) — same ground-truth rule
    if (this.p.offscreen() && (this.arrived || this.age > CULL_MAX_TICKS)) { this.die(); return; }
    if (this.kind === 'intro') {
      if (this.chain.length) { this.p.enter(this.chain.shift()); return; }
      this.introDone = true;                       // reached plain flight
      this.p.enter(93);
      return;
    }
    this.p.enter(this.loop);                     // food/cloud re-queue same
  }
  die() {
    this.dead = true;
    if (this.hasMoon) this.sv.moonActive = false;
  }
  draw(ctx) { this.p.draw(ctx); }
}

// ---------------------------------------------------- multi-toaster gags
// Data-driven from assets/gags.json (tools/gagmap.py — the extracted per-scenario,
// per-channel choreography). Each channel is a toaster playing a sequence chain,
// then dispersing to plain flight. Start positions come from the scenario's
// "start card" frame when it exists (items = each toaster formed up); else the
// channels stagger in from the entry band.
class MultiGag {
  constructor(sv, scen, opts = {}) {
    this.noLanes = !!opts.noLanes;   // debug harness: place, never claim/fail
    this.sv = sv;
    this.kind = 'gag';
    this.scen = scen;
    this.dead = false;
    // gags.json entry; if the scenario had no queue ops it's self-contained —
    // play its own sequence on main. (An entry may still carry a `loops` list
    // for that fallback main channel even with empty chans.)
    const orig = sv.gags[String(scen)];
    // Self-contained gag: the engine queued no explicit sequence (the handler's
    // QueueSequence labels are all computed scenario-relative). These are the
    // toaster playing a MODIFIED-FLIGHT loop — fire 928, hoola 1361, rowing 658,
    // leapfrog 2239, bagel-ride 1387 — which loop until they drift off. Explicit
    // queues instead carry the trailing-disperse structure (below) verbatim.
    const selfContained = !orig || !orig.chans || !Object.keys(orig.chans).length;
    let spec = orig || { chans: { main: [scen] } };
    if (selfContained) spec = Object.assign({}, spec, { chans: { main: [scen] } });
    let order = ['main', 'sub1', 'sub2', 'sub3'].filter(k => spec.chans[k]);
    this.weight = (spec.cfg && spec.cfg.weight) || 1;
    // max sprite bodies a label's sequence draws (frame item count)
    const bodies = l => {
      let mx = 0;
      for (const fn of (sv.compound.seqOf.get(l) || [l])) {
        const f = sv.compound.frame(fn);
        if (f) mx = Math.max(mx, f.items.length);
      }
      return mx;
    };
    const playable = k => (spec.chans[k] || []).filter(
      l => l !== 93 && l !== 3 && (sv.compound.seqOf.get(l) || [l]).length > 1);
    // Formation assembly (engine: GetChannelRect(slot) + SetCenterPoint per
    // channel — see gags.json `slots`): each channel snaps onto a body-slot of the
    // main's formed multi-body sequence, then plays its own chain (2736's subs
    // disperse; 2406's slot-4 baby stays). `sv.assemble` toggles this vs. the old
    // suppression (drop single-body subs, main draws the whole group).
    // Formation assembly (engine: GetChannelRect(slot) + SetCenterPoint per
    // channel, and DrawFrame's per-channel visibility). Each sprite draws only the
    // slots it OWNS: subs draw the slots the handler SetCenters them onto and follow
    // the main's live slot rect each tick; main draws every OTHER slot of the formed
    // multi-body sequence. No overlap, cooperatively-drawn formation. `sv.assemble
    // = false` reverts to the suppression (main draws the whole group, subs dropped).
    const slots = spec.slots || {};
    const mainFormed = playable('main').find(l => bodies(l) >= 3);
    const useAssembly = sv.assemble !== false && Object.keys(slots).length && mainFormed;
    let mainDrawSlots = null;
    if (useAssembly) {
      // Each sprite draws only the art-channels it OWNS (DrawFrame per-channel
      // visibility flag). Subs own the slots the handler SetCenters them onto;
      // main draws every OTHER slot of the formed sequence. No overlap.
      const subSlots = new Set();
      for (const k of order) if (k !== 'main' && slots[k] != null) subSlots.add(slots[k]);
      // use the FULLY-populated frame of the formed sequence (some open with fewer
      // bodies — 2391's first frame has 1, later 4), so all slots are accounted for.
      let ff = null;
      for (const fn of (sv.compound.seqOf.get(mainFormed) || [])) {
        const f = sv.compound.frame(fn);
        if (f && (!ff || f.items.length > ff.items.length)) ff = f;
      }
      mainDrawSlots = new Set(ff.items.map(it => it.artch).filter(a => !subSlots.has(a)));
    } else if (mainFormed) {
      // suppression fallback: drop the single-body fly-in subs; main IS the group
      order = order.filter(k => k === 'main' || playable(k).some(l => bodies(l) >= 2));
    }
    // ---- engine lane system (field init 0x416d0d + ctor 0x417113, placement
    // 0x417378, occupancy 0x4174dc) ----
    // The field divides an extended screen box (+160px margins each side) into
    // discrete diagonal entry lanes: `split` of them enter along the TOP edge
    // (x stepped by 160), the rest along the RIGHT edge (y stepped by 80).
    //   w80 = ceil(W/80)+4;  h80 = ceil(H/80)+4
    //   split = (w80-5)>>1;  total = h80+split-4       (640x480 -> 3+6 = 9 lanes)
    // Each lane has a busy claim with a 25s stale timeout (0x61a8 ms). A gag
    // needs cfg.lanes CONSECUTIVE free lanes (its footprint, offset by
    // cfg.split); if occupied the spawn FAILS silently (engine sentinel 0xfc18)
    // and the saver simply rolls again later — gags never overlap mid-air.
    const lf = sv.laneField || (sv.laneField = (() => {
      const w80 = Math.ceil(DESIGN_W / 80) + 4, h80 = Math.ceil(DESIGN_H / 80) + 4;
      const s = (w80 - 5) >> 1;
      return { split: s, total: h80 + s - 4, claim: [] };
    })());
    const laneFree = i => {
      if (i < 0 || i >= lf.total) return true;          // out of range = free
      if (lf.claim[i] && now() - lf.claim[i] > 25000) lf.claim[i] = 0;
      return !lf.claim[i];
    };
    // Per-scenario entry band ([gag+0x9c] top lane, [gag+0xa0] band size),
    // extracted as laneTop ('split' = the split threshold, i.e. right-edge
    // lanes only — the police 1349) and laneBandK (band = total - top - K).
    // The gag object is a SINGLETON, so a scenario without config REUSES the
    // previous gag's band (engine stale-state; reproduced via sv._laneBand).
    const c = spec.cfg || {};
    if (c.laneTop !== undefined || c.laneBandK !== undefined)
      sv._laneBand = { top: c.laneTop, bandK: c.laneBandK };
    const bandCfg = sv._laneBand || {};
    let laneTop = bandCfg.top === 'split' ? lf.split : (bandCfg.top || 0);
    let laneBand = bandCfg.bandK != null ? lf.total - laneTop - bandCfg.bandK
                                         : lf.total - laneTop;
    // the 0x1641e clamp
    if (laneTop > lf.total - 1) laneTop = lf.total - 1;
    if (laneTop + laneBand > lf.total) laneBand = lf.total - laneTop;
    if (laneTop < 0) laneTop = 0;
    if (laneBand < 1) laneBand = 1;
    const split = c.split != null ? c.split : 1;
    const footprint = c.lanes || 1;
    const lane = laneTop + rand(laneBand);              // RandShort within band
    if (!this.noLanes) {
      let laneOk = true;
      for (let b = 0; b < footprint; b++) if (!laneFree(lane - split + b)) laneOk = false;
      if (!laneOk) {                                    // engine: no spawn now
        this.spawnFailed = true; this.dead = true; this.ch = [];
        return;
      }
      this._lanes = [];
      for (let b = 0; b < footprint; b++) {
        const li = lane - split + b;
        if (li >= 0 && li < lf.total) { lf.claim[li] = now(); this._lanes.push(li); }
      }
    }
    // entry point per lane (0x173f4): top-edge lanes stagger x by 160 from the
    // right base +240; right-edge lanes stagger y by 80 from the top.
    const laneEntry = L => L < lf.split
      ? [DESIGN_W + (L - lf.split) * 160 + 240, -80]
      : [DESIGN_W + 80, (L - lf.split) * 80];
    const comp = sv.compound;
    const seqOf = l => comp.seqOf.get(l) || [l];
    const seqLen = l => seqOf(l).length;
    // A sequence is a *formation arc* when it carries a long absolute trajectory
    // baked into its frame rects (e.g. 2473 sweeps (826,-44)->(428,228)): it must
    // play at its authored 640x480 coordinates, synchronized with its siblings,
    // NOT re-placed on an entry lane. Actor sequences (mother/babies, food) are
    // short flap loops whose drift comes from common-art alignment; those keep
    // the entry-lane placement. Cutoff (len>=40 & displacement>=250px) cleanly
    // separates the two populations in the extracted data.
    const disp = l => {
      const s = seqOf(l);
      const ctr = fn => {
        const f = comp.frame(fn); if (!f) return null;
        const r = f.rect; return [(r[0] + r[2]) / 2 + f.dx, (r[1] + r[3]) / 2 + f.dy];
      };
      const a = ctr(s[0]), b = ctr(s[s.length - 1]);
      return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    };
    const isFormation = l => seqLen(l) >= 40 && disp(l) >= 250;
    // Formation arcs and templates are authored in the original 640x480 SCREEN
    // space with entry semantics relative to the top-RIGHT corner (all motion is
    // down-left; arcs like 2473 start off the box's top-right, cards like 1402's
    // pair sit at the right edge). Anchor the design box at the canvas top-right
    // so they FLY IN from the corner instead of materializing mid-screen
    // (centered anchoring caused the 1402/1782 "appeared in midair" reports).
    const offX = DESIGN_W - KAR_W, offY = 0;
    // Placement TEMPLATE (engine ground truth): the handler queues the formed
    // multi-body sequence just long enough for GetChannelRect(slot) to read its
    // authored slot rects, SetCenterPoints each channel there, then REPLACES the
    // queue with the channel's real single-body chain (the template never plays).
    // 2736's wedge = three act-toasters launched at the wedge's slot positions.
    let template = spec.template;
    if (!template && Object.keys(slots).length) {
      // layout CARD variant: a 1-frame multi-body label queued on main purely to
      // carry the slot rects (1402's side-by-side pair, 679) — never replaced
      // (its queue just ends), so the interpreter can't flag it; detect by shape.
      for (const l of (spec.chans.main || [])) {
        if (l !== 3 && l !== 93 && seqLen(l) === 1) {
          const f = comp.frame(l);
          if (f && f.items.length >= 2) { template = l; break; }
        }
      }
    }
    let tplFrame = null;
    if (template) {
      for (const fn of seqOf(template)) {
        const f = comp.frame(fn);
        if (f && (!tplFrame || f.items.length > tplFrame.items.length)) tplFrame = f;
      }
    }
    const tplRect = k => {
      if (!tplFrame || slots[k] == null) return null;
      const it = tplFrame.items.find(x => x.artch === slots[k]);
      return it ? it.rect : null;
    };
    this.ch = [];
    order.forEach((k, i) => {
      const raw = spec.chans[k].slice();
      const isDisp = l => l === 93 || l === 3;
      // Whether the last REAL (non-disperse) sequence is FOLLOWED by a disperse in
      // the engine's queue. That is the ground-truth persist signal: a sequence
      // with a disperse after it loops until it drifts out of view then resumes
      // flight (bagel-eyes 913, bagel-pop 861); a sequence that is the very last
      // entry with no disperse after plays ONCE, then the queue ends and the
      // toaster resumes plain flight (toast-insert 792). (CountLoopsOutOfView is
      // the engine's out-of-view detector that drives that trailing disperse.)
      // Engine ground-truth persist: this channel's transform holds — loops until
      // it drifts out of view, then disperses — iff the extractor read that from
      // the binary (0x4e loop-count = CountLoopsOutOfView, or an on-screen re-queue
      // loop). Covers self-looping transforms (fire, formations) AND driver
      // re-queued ones (police 1349). The old `loopsLast` trailing-disperse proxy
      // is gone: it could DISAGREE with the ground-truth signal (e.g. it looped
      // 792's insert forever though hold=false) — hold is now the sole gate.
      const holdCh = !!(spec.hold && spec.hold[k]);

      let chain = raw.slice();
      // KEEP leading flight loops (93/3): they are the engine's FLY-IN — the
      // toaster cruises on-screen before the act triggers (2736's channels fly
      // three loops into view, 861 flies in before the bagel pops). Stripping
      // them (the old flattened-extraction cleanup) made every gag's opening
      // beat fire at the spawn edge, half off-screen.
      // Randomized lead-in (hand-modeled chains only): leadIn = [base, span]
      // prepends base + rand(span) flight loops per spawn (1288's RandShort).
      if (k === 'main' && spec.leadIn)
        chain = Array(spec.leadIn[0] + rand(spec.leadIn[1])).fill(3).concat(chain);
      // drop 1-frame "start card" layout markers (e.g. 2458/679) — the formation
      // TEMPLATE (one artch item per channel), not a playable actor.
      chain = chain.filter(l => seqLen(l) > 1);
      // self-contained scenario: no queued sequence, so the scenario label IS the
      // sequence (a real multi-frame one, not a 1-frame card). Plays once.
      // (An extracted all-flight chain — 879's main escorts its bagel sub — is
      // NOT self-contained: it really does just fly.)
      if (!chain.length) {
        if (k === 'main' && seqLen(scen) > 1) chain = [scen];
        else return;
      }
      const formation = isFormation(chain.find(l => !isDisp(l)) ?? chain[0]);
      const slotFollow = useAssembly && k !== 'main' && slots[k] != null ? slots[k] : null;
      if (formation) {
        // formation arcs play at their AUTHORED coordinates — a leading flight
        // loop would render mid-screen at the arc's start point ("toaster pops
        // into existence in midair", the 1782 report), so the arc starts the
        // chain; the fly-in lead only applies to lane-entering channels.
        while (chain.length > 1 && isDisp(chain[0])) chain = chain.slice(1);
        // formations end mid-screen; their arc would teleport back if looped, so
        // they always exit on plain flight regardless of the queue's disperse.
        const last = chain[chain.length - 1];
        if (!isDisp(last)) chain = chain.concat([93]);
      } else if (holdCh || (selfContained && k === 'main') || slotFollow != null) {
        // loop the last real sequence until it drifts off (strip trailing disperse).
        // selfContained mains + assembly slot-bodies loop their sequence to persist.
        while (chain.length > 1 && isDisp(chain[chain.length - 1]))
          chain = chain.slice(0, -1);
      } else {
        // play once, then plain flight carries the toaster off
        const last = chain[chain.length - 1];
        if (!isDisp(last)) chain = chain.concat([93]);
      }
      const p = new Player(comp, sv.art, sv);
      p.enter(chain[0]);
      let cx, cy;
      let tplPlaced = false;
      if (formation) {
        // authored absolute coords carry the arc (raw 640x480 space; the group
        // is anchored proportionally after all channels are placed, below)
        p.ox = 0; p.oy = 0;
        const bc = p.bounds();
        cx = (bc[0] + bc[2]) / 2; cy = (bc[1] + bc[3]) / 2;
      } else if (slotFollow != null && this.mainCh) {
        // assembly slot-body: parked near main; positioned onto its slot each tick
        cx = this.mainX; cy = this.mainY;
        p.placeCenter(cx, cy);
      } else if (tplRect(k)) {
        // engine SetCenterPoint(GetChannelRect(slot)): launch this channel at
        // its authored slot rect of the (never-played) template sequence, then
        // let its own chain fly from there — synchronized group formation.
        // Placed at RAW authored coords; the group anchors proportionally below.
        const r = tplRect(k);
        cx = (r[0] + r[2]) / 2 + (tplFrame.dx || 0);
        cy = (r[1] + r[3]) / 2 + (tplFrame.dy || 0);
        p.placeCenter(cx, cy);
        tplPlaced = true;
      } else {
        // channel i enters at the i-th lane of the gag's claimed footprint
        // (cfg.lanes consecutive lanes anchored cfg.split-in at `lane`)
        [cx, cy] = laneEntry(lane - split + i);
        p.placeCenter(cx, cy);
      }
      if (this.mainX == null) { this.mainX = cx; this.mainY = cy; }
      const rec = { p, chain, ci: 0, dead: false, formation, slotFollow, tplPlaced };
      if (k === 'main') { this.mainCh = rec; rec.drawSlots = mainDrawSlots; }
      this.ch.push(rec);
    });
    // The port's two documented coordinate adaptations for absolute-coordinate
    // choreography (arcs + template groups), authored in raw 640x480 screen
    // space (no scaling/anchoring exists in the engine — on >640px displays the
    // original just used the coords raw, top-left):
    // 1. PROPORTIONAL ANCHOR: translate the whole group rigidly so its authored
    //    bounding-box centre lands at the same screen FRACTION of our canvas.
    //    Internal geometry and speeds stay exactly authored; edge/staging
    //    semantics carry over (2458's off-box diamond lands off-canvas by
    //    itself). Census: 7 of 25 placements are authored off-box staging, 18
    //    are on-screen starts.
    // 2. FLY-IN SHIFT: groups whose authored start is genuinely ON-screen (the
    //    2736 wedge, 2080's pair — an authentic pop-in on a 1996 CRT) shift
    //    right until every member starts off-canvas, so they enter flying.
    const grpChans = this.ch.filter(c => c.formation || c.tplPlaced);
    if (grpChans.length) {
      let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
      for (const c of grpChans) {
        const bb = c.p.bounds();
        l = Math.min(l, bb[0]); t = Math.min(t, bb[1]);
        r = Math.max(r, bb[2]); b = Math.max(b, bb[3]);
      }
      const cx0 = (l + r) / 2, cy0 = (t + b) / 2;
      const adx = Math.round(cx0 / KAR_W * DESIGN_W - cx0);
      const ady = Math.round(cy0 / KAR_H * DESIGN_H - cy0);
      for (const c of grpChans) { c.p.ox += adx; c.p.oy += ady; }
      let dx = 0;
      for (const c of grpChans) dx = Math.max(dx, DESIGN_W - c.p.bounds()[0] + 10);
      if (dx > 0 && dx < DESIGN_W) for (const c of grpChans) c.p.ox += dx;
    }
    if (this.mainX == null) { this.mainX = DESIGN_W / 2; this.mainY = DESIGN_H / 2; }
    // props that BREAK OFF the main toaster mid-gag (engine Split, chan vtbl+0xc8:
    // main.Split(subCh, contLabel, propLabel) — 807 splits the golden toast 2974,
    // 1672 splits a rider 1734). The engine fires this when main reaches the split
    // frame (flag [eax+0x4a] = sequence complete), detaching the prop at the
    // toaster's LIVE position — so we defer the spawn to that transition, not the
    // start, and place it exactly where the main toaster is then.
    this.pendingProps = (spec.props || []).slice();
    (spec.sounds || []).forEach(s => sv.playSound(s));
    if (SCEN_SFX[scen]) sv.playSound(SCEN_SFX[scen]);   // cord/fire/police/morph
  }
  _splitProps() {
    // Engine Split (chan vtbl 0xc8 -> the copy helper 0xdc): the broken-off prop
    // INHERITS the main toaster's transform origin (fields [+0x40]/[+0x44]), it is
    // not re-centered. Copying the origin lets the prop's OWN authored frame offset
    // place it exactly where the split frame drew it (the toast at the toaster's
    // slot), which preserves the ejection lane. placeCenter'ing the prop on main's
    // bounds-center instead discarded that offset and tossed the toast in the wrong
    // lane — the debug-menu bug flagged for 807.
    const m = this.mainCh;
    for (const pl of this.pendingProps) {
      const p = new Player(this.sv.compound, this.sv.art, this.sv);
      p.enter(pl);
      if (m) { p.ox = m.p.ox; p.oy = m.p.oy; }
      else p.placeCenter(this.mainX, this.mainY);
      // the prop keeps its OWN sequence (a toast tumbles/drifts as a toast) —
      // it drifts off on its own; no flight-flap append (that flapped the toast).
      this.ch.push({ p, chain: [pl], ci: 0, dead: false, propChan: true });
    }
    this.pendingProps = [];
  }
  tick() {
    // Each channel plays its chain independently then loops the last sequence
    // until it drifts offscreen. (An earlier barrier-sync FROZE channels while
    // waiting for slower ones — the "frozen sprites" the review flagged — so we
    // let them run free; formations hold well enough via the entry geometry.)
    let alive = 0;
    for (const c of this.ch) {
      if (c.dead) continue;
      if (c.p.tick() === 'end') {
        c.ci++;
        // main finished its gag sequence → break off any pending props HERE, at
        // the toaster's live position (the engine's split moment: the handler
        // calls Split when main's queued gag seq drains). The chain now opens
        // with fly-in flight labels, so "the gag sequence" = the FIRST REAL
        // (non-disperse) label — splitting at ci===1 fired at the fly-in's end,
        // spawning 807's toast at the pop's START (it flew off before the
        // animation finished — the "toast vanished" report).
        if (c === this.mainCh && this.pendingProps.length) {
          const firstReal = c.chain.findIndex(l => l !== 3 && l !== 93);
          if (firstReal >= 0 && c.ci === firstReal + 1) this._splitProps();
        }
        const next = c.ci < c.chain.length ? c.chain[c.ci] : c.chain[c.chain.length - 1];
        // resuming plain flight (3/93) after a gag = the engine handing the
        // toaster back to the flight state machine, which continues from the
        // sprite's CURRENT position. Preserve it instead of snapping onto shared
        // art (the power-cord/flight poses share a body art far apart → a 164px
        // teleport that read as "flickering out"). Other transitions (morph,
        // formation links) keep common-art continuity. IMPORTANT: only on the
        // FIRST gag→flight seam — once cruising, flight self-loops (93→93) must
        // use natural common-art drift, else placeCenter cancels the per-loop
        // leftward step (~17px) and the toaster creeps rightward each cycle.
        const prevLabel = c.p.label;
        const b = c.p.bounds(), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        c.p.enter(next);
        if ((next === 93 || next === 3) && prevLabel !== 93 && prevLabel !== 3)
          c.p.placeCenter(cx, cy);
        if (c.ci >= c.chain.length) c.ci = c.chain.length - 1;
      }
      if (!c.p.offscreen(0)) c._arr = true;
      if (c.p.offscreen() && (c._arr || (c._age = (c._age || 0) + 1) > CULL_MAX_TICKS)) c.dead = true;
      if (!c.dead) alive++;
    }
    // formation assembly: park each slot-body onto the main's live body-slot rect
    // (engine SetCenterPoint to GetChannelRect(slot)) so the group stays locked as
    // it drifts. When main leaves the formed frame it rides along at main's centre;
    // the formation dissolves (slot-bodies die) with main.
    const m = this.mainCh;
    if (m) {
      const mf = m.p.cur();
      const mb = m.p.bounds();
      for (const c of this.ch) {
        if (c.dead || c.slotFollow == null) continue;
        if (m.dead) { c.dead = true; continue; }
        const it = mf.items.find(x => x.artch === c.slotFollow);
        if (it) c.p.placeCenter(m.p.ox + (it.rect[0] + it.rect[2]) / 2 + mf.dx,
                                m.p.oy + (it.rect[1] + it.rect[3]) / 2 + mf.dy);
        else c.p.placeCenter((mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2);
      }
      // Broken-off props live only as long as the GAG OBJECT: the engine
      // despawns the whole FlyingBigGag (all channels) when main's exit
      // completes — the rider gets ONE dive, not encores until it drifts off
      // (the wild "still looping the tiptoe" report).
      if (m.dead) for (const c of this.ch) if (c.propChan) c.dead = true;
    }
    if (!alive) {
      this.dead = true;
      // release the gag's claimed lanes (engine helper 0x4174ad -> 0x417550)
      if (this._lanes && this.sv.laneField) {
        for (const li of this._lanes) this.sv.laneField.claim[li] = 0;
        this._lanes = null;
      }
    }
  }
  draw(ctx) { for (const c of this.ch) if (!c.dead) c.p.draw(ctx, c.drawSlots); }
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
    this.p = new Player(sv.compound, sv.art, sv);
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
    this.total = this.events.reduce((s, e) => s + (e.ms || 0), 0) || 1;
    this.i = -1;
    this.deadline = 0;            // durations are deltas accumulated by the loop
    this.t = 0;
    this.line = 0;
    this.reveal = new Set();
    this.bagelX = null;
    this.bagelTarget = null;
    this.bagel = new Player(this.sv.compound, this.sv.art, this.sv);
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
        // a new line hasn't ended yet — clear any prior line's end marker so a
        // fast-forward (enabling karaoke mid-song, or resuming a hidden tab)
        // that lands INSIDE this line doesn't immediately blank it with a stale
        // lineEndAt from the previous line.
        this.lineEndAt = null;
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
    // Anchor every line at the SAME screen position — a banner near the bottom.
    // Each line frame's artch-1 rect jitters a few px in y (264-269), and the box
    // sits ~214px up, so lines appeared to wander down/mid-screen. Compensate by
    // deriving ky from THIS line's top so it always lands at a fixed baseline.
    const lineTop = (fr.items.find(i => i.artch === 1) || { rect: [0, 266] }).rect[1];
    const kx = Math.round((DESIGN_W - KAR_W) / 2);
    const ky = DESIGN_H - 64 - lineTop;
    // Authentic per-syllable reveal (engine ground truth): draw the WHITE line
    // sprite (artch 1), then each SUNG syllable's own RED glyph art (artch>1) at
    // its authored rect. The red glyph's ink sits a few px off the white's inside
    // its box (authored that way) — in the engine its OPAQUE BLACK background
    // REPLACES the region, hiding the offset. dropBlackBox makes that background
    // transparent, so overlaying left the white peeking around the red (the
    // "doubled text" bug). Reproduce the replace: compose on an offscreen, ERASE
    // each sung syllable's rect, then draw its red art — box-blit semantics with
    // a transparent banner (no black boxes over the sky).
    const wl = fr.items.find(i => i.artch === 1);
    if (wl) {
      if (!this._oc) this._oc = document.createElement('canvas');
      const oc = this._oc;
      if (oc.width !== KAR_W || oc.height !== KAR_H) { oc.width = KAR_W; oc.height = KAR_H; }
      const octx = oc.getContext('2d');
      octx.clearRect(0, 0, KAR_W, KAR_H);
      const im = this.sv.karArt.get(wl.art);
      if (im) octx.drawImage(im, wl.rect[0], wl.rect[1]);
      for (const it of fr.items) {
        if (it.artch > 1 && this.reveal.has(it.artch)) {
          const ri = this.sv.karArt.get(it.art);
          if (!ri) continue;
          octx.clearRect(it.rect[0], it.rect[1],
                         it.rect[2] - it.rect[0], it.rect[3] - it.rect[1]);
          octx.drawImage(ri, it.rect[0], it.rect[1]);
        }
      }
      ctx.drawImage(oc, kx, ky);
    }
    if (this.bagelX != null) {
      const bfr = this.bagel.cur();
      const w = bfr.rect[2] - bfr.rect[0], h = bfr.rect[3] - bfr.rect[1];
      this.bagel.ox = Math.round(kx + this.bagelX - w / 2 - bfr.rect[0]);
      this.bagel.oy = Math.round(ky + fr.rect[1] - 6 - h - bfr.rect[1]);
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
    this.muted = false;       // legacy master gate; music/sfx now toggle per-channel
    this.musicClock = 0;      // continuous timeline (ms), advances even muted
    this.introRunning = false;
  }

  audio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;   // master mute node
      this.masterGain.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }
  setMuted(m) {
    this.muted = m;
    if (this.masterGain) this.masterGain.gain.value = m ? 0 : 1;
  }
  // Clear the field and let it re-fill fresh under the current settings. Used
  // when a preference (density, adult/baby) changes so the change takes effect
  // immediately rather than the swarm slowly drifting to the new mix.
  restart() {
    this.actors = [];
    this.debugActor = null;
    this.debugFactory = null;
    this.introRunning = false;
    this.moonActive = false;
    this._lastSpawn = 0;
    this.lastCloud = -1e9; this.lastGag = -1e9;
    this.lastGagB = -1e9; this.lastGagC = -1e9;
    if (this.laneField) this.laneField.claim = [];  // free all entry lanes
    this._laneBand = null;
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
    // authentic family selection (0x10c24): RandShort(3) -> family, gated;
    // then RandShort into the family's picker table -> scenario.
    const t = now();
    const roll = rand(3);
    let fam;
    if (roll === 0 && t > this.lastGagC + 15000) { fam = FAM_C; this.lastGagC = t; }
    else if (roll <= 1 && t > this.lastGagB + 6000) { fam = FAM_B; this.lastGagB = t; }
    else { fam = FAM_A; }
    const g = new MultiGag(this, pick(fam));
    // engine: when the gag's lane footprint is occupied the placement returns
    // the 0xfc18 sentinel and nothing spawns — the saver just rolls again later
    if (!g.spawnFailed) this.actors.push(g);
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
    // Toaster-vs-food choice = ToasterControl::RandomType (0x1e260): roll
    // RandShort(5), then gate food on the live toaster/food ratio. The thresholds
    // are EXTRACTED (float consts @0x41e384=2.0, @0x41e388=4.0; default ratio
    // when no food = 0x40800000=4.0) — type is food when ratio exceeds them,
    // else another toaster. So the flock self-balances ~4:1 toasters:food.
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
    if (this.muted || !this.settings.sound || !this.sounds[id]) return;
    const ctx = this.audio();
    const fire = buf => {
      const s = ctx.createBufferSource(); s.buffer = buf;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(g); g.connect(this.masterGain); s.start();
    };
    const cached = this.sfxCache.get(id);
    if (cached) return fire(cached);
    ctx.decodeAudioData(this.sounds[id].slice(0),
      d => { this.sfxCache.set(id, d); fire(d); });
  }

  // Music runs on a continuous timeline (musicClock, always advancing even when
  // muted) so unmuting joins the song mid-stream instead of restarting at 0:00.
  playMusic(song) {
    const ctx = this.audio();
    const buf = this.music.buffers && this.music.buffers[song];
    if (!buf) { this.music.pending = song; return; }
    this.stopMusic();
    const offset = (this.musicClock / 1000) % buf.duration;   // join at timeline
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.connect(this.masterGain); s.start(0, offset);
    // startAt is the virtual time at which the song's 0 would have played, so
    // musicMs() keeps returning the timeline position.
    this.music.src = s; this.music.startAt = ctx.currentTime - offset;
    this.music.song = song; this.music.dur = buf.duration;
  }
  stopMusic() {
    if (this.music.src) { try { this.music.src.stop(); } catch {} this.music.src = null; }
  }
  musicMs() {
    // authoritative timeline; the audio is slaved to it. Always advances.
    return this.musicClock;
  }

  setDebug(actorOrFactory) {
    if (typeof actorOrFactory === 'function') {
      this.debugFactory = actorOrFactory;
      this.debugActor = actorOrFactory();
    } else {
      this.debugFactory = null;
      this.debugActor = actorOrFactory;
    }
    if (this.debugActor && this.debugSolo) { this.actors = []; this.introRunning = false; }
  }

  tick() {
    if (this.debugActor) {
      this.debugActor.tick();
      // Respawn dead debug gags after a short PAUSE, not instantly: instant
      // respawn made every gag look like an endless loop (recurring "it keeps
      // repeating" reports for what is really the replay-for-review affordance).
      if (this.debugActor.dead && this.debugFactory) {
        this._dbgDeadTicks = (this._dbgDeadTicks || 0) + 1;
        if (this._dbgDeadTicks >= 15) {           // ~1.5s gap between replays
          this._dbgDeadTicks = 0;
          this.debugActor = this.debugFactory();
        }
      } else this._dbgDeadTicks = 0;
      if (!this.debugSolo) {                      // swarm continues alongside
        for (const a of this.actors) a.tick();
        this.actors = this.actors.filter(a => !a.dead);
        if (this.population() < this.maxObjects()) this.spawn();
      }
      return;
    }
    if (this.introRunning) {
      const intro = this.actors[0];
      if (!intro) { this.introRunning = false; this.actors = []; }
      else {
        intro.tick();
        if (intro.dead) { this.introRunning = false; this.actors = []; return; }
        // hand off to the swarm the moment the toaster materializes and starts
        // flying — DON'T wait for it to exit (it stays as the first swarm member,
        // others join around it). Return once so we don't double-tick this frame.
        if (intro.introDone) { this.introRunning = false; return; }
        return;                                  // still slideshow/materialize
      }
    }
    if (this.settings.toasters !== 2) this.songType = this.settings.toasters;
    // Continuous song timeline. When music is actually playing, slave the clock
    // to the AUDIO position (audioContext.currentTime) — a hidden tab throttles
    // rAF but WebAudio keeps playing, so a tick-counted clock would fall behind
    // the music and desync the karaoke. When no music source exists, advance by
    // the tick delta so the timeline still progresses (muted/again on unmute).
    if (this.music.src && this.audioCtx) {
      this.musicClock = (this.audioCtx.currentTime - this.music.startAt) * 1000;
    } else {
      this.musicClock += TICK_MS;
    }
    for (const a of this.actors) a.tick();
    this.actors = this.actors.filter(a => !a.dead);
    // Engine spawn cadence (ToasterControl::Play 0x1dcd0): each 10Hz tick, if the
    // population is below target, spawn exactly ONE object. Fills to target in
    // ~(target) ticks — a few seconds — as the original does.
    if (this.population() < this.maxObjects()) this.spawn();
    // karaoke tracks the same timeline as the music. It must wrap on the MUSIC's
    // loop length, not its own event total — the lyric events end ~2s before the
    // song's instrumental outro (song0: 84.3s events vs 86.5s audio), so wrapping
    // on the event total drifts the karaoke ahead of the music a little every
    // loop. Mod by the audio duration when music is playing; the tail past the
    // last event simply shows no line (instrumental), then wraps with the song.
    if (this.settings.karaoke) {
      const loopMs = (this.music.src && this.music.dur)
        ? this.music.dur * 1000 : this.karaoke.total;
      this.karaoke.tick(TICK_MS, this.musicClock % loopMs);
    }
  }

  // double-click identify: find the actor under (x,y) and describe its state
  // (for reporting stuck/broken toasters)
  identifyAt(x, y) {
    const hit = p => { const b = p.bounds(); return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; };
    const list = this.debugActor ? [this.debugActor] : this.actors;
    for (const a of list) {
      if (a.ch) {                                  // MultiGag: check each channel
        for (let i = 0; i < a.ch.length; i++) {
          const c = a.ch[i];
          if (!c.dead && hit(c.p))
            return `GAG scen ${a.scen} · ch${i} · seq ${c.p.label}` +
                   ` · step ${c.ci + 1}/${c.chain.length}` + (c.atBoundary ? ' · WAITING' : '');
        }
      } else if (a.p && hit(a.p)) {
        if (a instanceof ToasterActor)
          return `toaster kind ${a.kind} · seq ${a.p.label}` +
                 ` · s44=${a.s44} s48=${a.s48}`;
        if (a.kind === 'debug') return `debug · seq ${a.p.label}`;
        return `${a.kind} · seq ${a.p.label}`;
      }
    }
    return null;
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
  const [banksMeta, comp22000, comp22100, karaokeTables, gags, soundMap] = await Promise.all([
    loadJSON(`${ASSETS}/sprites/banks.json`),
    loadJSON(`${ASSETS}/compound_22000.json`),
    loadJSON(`${ASSETS}/compound_22100.json`),
    loadJSON(`${ASSETS}/karaoke.json`),
    loadJSON(`${ASSETS}/gags.json`),
    loadJSON(`${ASSETS}/soundmap.json`),
  ]);
  const ids = Object.keys(banksMeta).map(Number);
  const art = new ArtIndex(), karArt = new ArtIndex();
  await Promise.all([
    art.load(ids.filter(b => b < 22100), banksMeta),
    karArt.load(ids.filter(b => b >= 22100), banksMeta, dropBlackBox),
  ]);
  const sounds = {};
  for (let id = 22000; id <= 22012; id++) {
    fetch(`${ASSETS}/sounds/${id}.wav`).then(r => r.arrayBuffer())
      .then(b => { sounds[id] = b; }).catch(() => {});
  }

  // (1782/1928 share handler 0x10fc6 — the pair formation arcs 1933+2004 now
  //  come straight from extraction, so the earlier hand-patched labels are gone.)
  // Futuristic morph (1288): the extractor flattens the global 3-phase state
  // machine (morph-out 1233 -> futuristic cruise 1288 -> morph-back 1303) OUT of
  // execution order into [1233,1288,3,1288,1303,3,1288] with a spurious hold that
  // froze it on the morph-back frame. Reproduce the real arc explicitly: morph
  // out, CRUISE futuristic 3x (the handler sets the futuristic seq's [+0x4e]=2 =
  // 3 plays before the phase flips), morph back, then resume flight. (The random
  // 2-5 normal-flight lead-in and the screen-wide phase orchestration that syncs
  // all morphers aren't modeled — this is the per-toaster morph in isolation.)
  if (gags['1288']) {
    // hand-modeled morph arc (see gagmap.py): the handler flies normal for
    // RandShort(4)+2 loops FIRST (so the morph happens mid-screen, not at the
    // entry edge), then morph-out, cruise futuristic 3x ([0x4e]=2), morph back.
    // leadIn = [base, randSpan]: per-spawn flight loops = base + rand(span).
    gags['1288'].chans = { main: [1233, 1288, 1288, 1288, 1303] };
    gags['1288'].leadIn = [2, 4];
    delete gags['1288'].hold;
  }
  // BreakOffProp gags: props (807 -> golden toast 2974, 1672 -> rider 1734) come
  // from the extractor's Split(vtbl+0xc8) scan, and 1672's continuation order
  // ([3,1672,1686,3]) now comes from the state-machine interpreter — the last
  // chans boot patch is gone. (1288 remains the one hand-modeled chain: its
  // global 3-phase morph is outside the interpreter's scope, see gagmap.py.)
  const saver = new Screensaver({
    art, karArt,
    compound: new Compound(comp22000),
    karCompound: new Compound(comp22100),
    banksMeta, karaokeTables, sounds, gags, soundMap,
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
  document.getElementById('menu-btn').onclick = togglePanel;   // side button, not canvas click
  document.getElementById('close-btn').onclick = togglePanel;

  // double-click a toaster to identify it (for reporting stuck/broken ones)
  const idBox = document.getElementById('identify');
  const idText = document.getElementById('id-text');
  const idCopy = document.getElementById('id-copy');
  const idClose = document.getElementById('id-close');
  let idTimer = null;
  const hideId = () => { clearTimeout(idTimer); idBox.classList.add('hidden'); };
  const armHide = () => { clearTimeout(idTimer); idTimer = setTimeout(hideId, 6000); };
  idClose.addEventListener('click', hideId);
  // Esc closes it too
  window.addEventListener('keydown', e => { if (e.key === 'Escape') hideId(); });
  canvas.addEventListener('dblclick', e => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top) * (canvas.height / r.height);
    const info = saver.identifyAt(x, y);
    idText.textContent = info || 'nothing there';
    idCopy.classList.toggle('hidden', !info);
    idCopy.textContent = 'copy';
    idBox.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 260)}px`;
    idBox.style.top = `${e.clientY + 12}px`;
    idBox.classList.remove('hidden');
    armHide();
  });
  idCopy.addEventListener('click', async () => {
    clearTimeout(idTimer);                          // keep open while confirming
    try { await navigator.clipboard.writeText(idText.textContent); idCopy.textContent = 'copied ✓'; }
    catch { idCopy.textContent = 'copy failed'; }
    armHide();
  });
  // Density slider (authentic: the original had a density slider). 4 stops map to
  // the engine's Flight/Squadron/Air Wing/Swarm object counts.
  const DENSITY = [['Flight', 0], ['Squadron', 25], ['Air Wing', 50], ['Swarm', 75]];
  const objSlider = document.getElementById('objects');
  const objLabel = document.getElementById('objects-label');
  const applyObjects = () => {
    const [name, val] = DENSITY[+objSlider.value] || DENSITY[2];
    saver.settings.objects = val; objLabel.textContent = name;
  };
  objSlider.oninput = applyObjects;                 // live label/count while dragging
  objSlider.onchange = () => { applyObjects(); saver.restart(); };  // restart on release
  applyObjects();

  const syncMusic = () => {
    if (saver.settings.music) { decodeMusic(); saver.playMusic(saver.songType); }
    else saver.stopMusic();
  };
  document.getElementById('toasters').onchange = e => {
    saver.settings.toasters = +e.target.value;
    saver.songType = saver.settings.toasters === 1 ? 1
                   : saver.settings.toasters === 2 ? rand(2) : 0;
    if (saver.settings.karaoke) saver.karaoke.reset(saver.songType);
    if (saver.settings.music) syncMusic();
    saver.restart();                                // adult/baby switch takes effect now
  };
  document.getElementById('intro-btn').onclick = () => { saver.playIntro(); togglePanel(); };
  document.getElementById('debug-btn').onclick = () => { buildDebug(saver); togglePanel(); };

  // Top-bar toggle buttons: music / sfx / karaoke, each independent. Any click
  // also unlocks WebAudio (browsers block autoplay until a user gesture).
  const musicBtn = document.getElementById('music-btn');
  const sfxBtn = document.getElementById('sfx-btn');
  const karBtn = document.getElementById('karaoke-btn');
  function reflectButtons() {
    musicBtn.classList.toggle('on', saver.settings.music);
    sfxBtn.classList.toggle('on', saver.settings.sound);
    karBtn.classList.toggle('on', saver.settings.karaoke);
  }
  musicBtn.onclick = () => {
    saver.audio();
    saver.settings.music = !saver.settings.music;
    syncMusic();
    reflectButtons();
  };
  sfxBtn.onclick = () => {
    saver.audio();                               // unlock on gesture
    saver.settings.sound = !saver.settings.sound;
    reflectButtons();
  };
  karBtn.onclick = () => {
    saver.settings.karaoke = !saver.settings.karaoke;
    // karaoke is independent of music: it runs on the continuous timeline
    // (musicClock), so lyrics scroll with or without the song playing.
    if (saver.settings.karaoke) saver.karaoke.reset(saver.songType);
    reflectButtons();
  };
  reflectButtons();

  // Apply the controls' CURRENT values on load — a browser may restore a prior
  // selection (e.g. Babies) across reloads, and settings would otherwise keep
  // the constructor defaults (Adults) until the user re-toggled.
  saver.settings.toasters = +document.getElementById('toasters').value;
  saver.songType = saver.settings.toasters === 1 ? 1
                 : saver.settings.toasters === 2 ? rand(2) : 0;
  applyObjects();

  // The engine only plays the evolution-slideshow intro for the ADULT song
  // (SetPlayIntro is gated on songType==0 @0x1c340); baby mode goes straight to
  // the swarm. So skip the intro when we're on the baby song.
  if (saver.songType === 0) saver.playIntro();

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
// Entry = [name, spec]. spec is either a flight/food CHAIN (array of labels,
// played via DebugActor) or a GAG {g: scenario} (played via the REAL MultiGag
// straight from gags.json — so what you review is exactly what the swarm runs).
// Rebuilt to reflect the authentic RE (family tables, gags.json). Babies last.
const DEBUG_CATALOG = {
  // 3rd element = authentic nature: 'loop' (repeats), 'act' (enters/loops/
  // self-exits back to cruise), 'once' (single play). Default: chains 'loop',
  // gags 'once'.
  'Adult flight': [
    ['cruise 1 (3)', [3], 'loop'], ['cruise 2 (93)', [93], 'loop'],
    ['coil-heat act (18→33→48)', [18, 33, 33, 48], 'act'],
    ['act 586→602→607', [586, 602, 602, 607], 'act'],
    ['638 act (622→638→643)', [622, 638, 638, 643], 'act'],
    ['one-shot 133', [133], 'once'], ['one-shot 172', [172], 'once'],
    ['one-shot 209', [209], 'once'],
    ['one-shot 231', [231], 'once'], ['one-shot 252', [252], 'once'],
    ['turn-around 105', [105, 122], 'once'], ['turn-around 115', [115, 122], 'once'],
  ],
  'Food': [
    ['cracker (3039)', [3039]], ['bagel (3024)', [3024]],
    ['waffle (3019)', [3019]], ['golden toast (3002)', [3002]],
    ['brown bread (2997)', [2997]], ['brown bread moving (2979)', [2979]],
    ['static toast (2969)', [2969]], ['static golden (2974)', [2974]],
  ],
  'Sky': [
    ['cloud A (463)', [3053]], ['cloud B (464)', [3058]],
    ['cloud C (465)', [3063]], ['cloud D (466)', [3068]],
  ],
  // Names describe the EXTRACTED composition (channel count / formation-vs-actor
  // / confirmed props), not guessed choreography. User-confirmed names are kept.
  'Gags — family A': [
    ['pair 1782 (arcs 1933+2004)', { g: 1782 }], ['pair 1928 (=1782 handler)', { g: 1928 }],
    ['toaster + toast (792)', { g: 792 }], ['toast split-off (807)', { g: 807 }],
    ['toast relay (749)', { g: 749 }], ['bagel from toaster (861)', { g: 861 }],
    ['flight variant 274', { g: 274 }], ['flight variant 295', { g: 295 }],
    ['flight variant 312', { g: 312 }], ['flight variant 329', { g: 329 }],
    ['flight variant 558', { g: 558 }], ['flight variant 456', { g: 456 }],
  ],
  'Gags — family B': [
    ['mother + babies (2391)', { g: 2391 }], ['mother + babies (2406)', { g: 2406 }],
    ['baby swinging on cracker (1213)', { g: 1213 }], ['baby on waffle (1227)', { g: 1227 }],
    ['MORPH / evolution (1288)', { g: 1288 }], ['rowing/swimming toaster (658)', { g: 658 }],
    ['burning toaster (928)', { g: 928 }], ['hoola hoop (1361)', { g: 1361 }],
    ['toast juggle 1372', { g: 1372 }], ['leapfrog (2239)', { g: 2239 }],
    ['toaster riding a bagel (1387)', { g: 1387 }], ['love waffles (2272)', { g: 2272 }],
    ['kissing pair (2298)', { g: 2298 }],
  ],
  'Gags — family C': [
    ['power cord + conga (2421)', { g: 2421 }], ['line formation ×4 (2458)', { g: 2458 }],
    ['wedge ×3 (2736)', { g: 2736 }], ['sync lane-change ×3 (2910)', { g: 2910 }],
    ['same-lane block (1402)', { g: 1402 }], ['toaster + rider (1672)', { g: 1672 }],
    ['pair arcs (2080)', { g: 2080 }], ['police ×3 (679)', { g: 679 }],
    ['police car + toaster (1349)', { g: 1349 }], ['bagel-eyes ×2 (879)', { g: 879 }],
  ],
  'Flight specials (baby launch)': [
    ['special 1038', [1038], 'loop'], ['special 1065', [1065], 'loop'],
    ['special 1107', [1107, 1065], 'loop'],
    ['special 1111', [1111], 'once'], ['mom+babies 1138', [1138], 'loop'],
    ['special 1154', [1154], 'loop'], ['special 1173', [1173], 'loop'],
    ['special 1192', [1192], 'loop'],
    ['flip-over 946 (raw)', [945], 'once'], ['toast-pop 748 (raw)', [748], 'act'],
  ],
  '(baby) flight': [
    ['plain 983', [983], 'loop'], ['wander 988', [988], 'loop'],
    ['wander 997', [997], 'loop'], ['wander 1003', [1003], 'loop'],
    ['ladder 1009', [1009], 'loop'], ['ladder 1014', [1014], 'loop'],
    ['swoop 1019→1025', [1019, 1025], 'once'],
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
  const legend = document.createElement('div');
  legend.className = 'dbg-auto';
  legend.innerHTML = '<span class="kind-loop">⟳ loops</span> · ' +
    '<span class="kind-act">⤾ act (self-exits)</span> · ' +
    '<span class="kind-once">▶ one-shot</span>';
  bar.appendChild(legend);

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
    for (const [name, spec, kindRaw] of items) {
      n++;
      const num = n;                             // capture per-iteration
      const isGag = !Array.isArray(spec);
      const kind = kindRaw || (isGag ? 'once' : 'loop');   // authentic nature
      const badge = { loop: '⟳', act: '⤾', once: '▶' }[kind];
      const id = isGag ? `g${spec.g}` : spec.join('-');   // stable per-act key
      const b = document.createElement('button');
      b.dataset.num = num; b.dataset.id = id;
      b.dataset.defname = name; b.dataset.group = group; b.dataset.kind = kind;
      const render = () => {
        const disp = (reviews[id] && reviews[id].name) || name;
        b.innerHTML = `<span class="dbg-num">${num}</span>` +
          `<span class="kind-${kind}" title="${kind}">${badge}</span> ${disp}` +
          `<span class="dbg-tag"></span>`;
        mark(b, id);
      };
      render();
      b._render = render;
      byNum[n] = b;
      b.onclick = () => {
        saver.debugSolo = document.getElementById('dbg-solo').checked;
        // gags spawn the REAL MultiGag (auto-respawns for repeat viewing);
        // flight/food play via DebugActor. 'loop'/'act' keep cycling; 'once'
        // plays through then returns to plain flight (then replays for viewing).
        const factory = isGag ? () => new MultiGag(saver, spec.g, { noLanes: true })
                              : () => new DebugActor(saver, spec, kind !== 'once');
        saver.setDebug(factory);
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
      for (const [name, spec] of items) {
        const id = Array.isArray(spec) ? spec.join('-') : `g${spec.g}`;
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

  const wipeBtn = document.createElement('button');
  wipeBtn.textContent = '🗑 clear all reviews';
  wipeBtn.className = 'dbg-clear';
  wipeBtn.onclick = () => {
    if (!confirm('Clear all saved reviews?')) return;
    for (const k of Object.keys(reviews)) delete reviews[k];
    saveReviews(reviews);
    bar.querySelectorAll('button[data-id]').forEach(x => { x._render(); });
  };
  bar.appendChild(wipeBtn);
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
