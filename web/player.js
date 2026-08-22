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

const DESIGN_W = 640, DESIGN_H = 480, TICK_MS = 100;
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
    // no shared art: rects chain absolutely (by design; no shift)
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
    const fr = this.cur();
    for (const it of fr.items) {
      if (revealSlots && it.artch > 1 && !revealSlots.has(it.artch)) continue;
      const im = this.art.get(it.art) || this._held(it.artch);
      if (!im) continue;
      this._hold(it.artch, im);
      ctx.drawImage(im, this.ox + it.rect[0] + fr.dx,
                        this.oy + it.rect[1] + fr.dy);
    }
  }
  _held(ch) { return this.heldArt ? this.heldArt.get(ch) : null; }
  _hold(ch, im) {
    if (!this.heldArt) this.heldArt = new Map();
    this.heldArt.set(ch, im);
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
// Adult toaster: entry swoop label 3 (seq 2), standard flight 93 (seq 92),
// flap-loop attitude ladder (adjacent variants; 10% switch per boundary).
// Full transition graph transcription is in progress; specials disabled until
// then so acts never splice mid-way.
const ADULT_LOOPS = [17, 32, 47, 62, 77];
const BABY_LOOPS = [987, 996, 1002, 1008, 1013, 1018, 1025, 1032];

// RE-NOTES §1: adult food picker RandShort(9) -> queued labels
const FOOD_ROLLS = [3039, 3024, 3019, 3002, 2997, 2979, 2969, 2974, 2974];
// baby food RandShort(6)
const BABYFOOD_ROLLS = [3274, 3279, 3286, 3291, 3296, 3301];
// RE-NOTES §2: clouds (4 shapes, uniform), baby sky RandShort(10)
const CLOUD_ROLLS = [3054, 3074, 3094, 3114];
const BABYSKY_ROLLS = [3199, 3204, 3209, 3214, 3239, 3244, 3249, 3254, 3259, 3264];
const MOON = 3239, COW = 3244, STARS = 3249;

// RE-NOTES §4: BigGag families B and C (single-channel scenarios).
// [label, weight, gate] — family A (multi-actor glue) pending transcription.
const GAG_B = [[2391, 2], [2406, 2], [1213, 1], [1227, 1], [1288, 1], [658, 1],
               [928, 1], [1361, 1], [1372, 1], [2239, 2], [1387, 1], [2272, 1],
               [2298, 1], [2349, 1]];
const GAG_C = [[2421, 4], [2458, 4], [2736, 1], [2910, 1], [1402, 2], [1672, 2],
               [2080, 2], [679, 2], [1349, 2], [879, 2], [946, 2]];

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
      case 'toaster': {
        this.loop = pick(ADULT_LOOPS);
        this.p.enter(rand(4) === 0 ? 93 : 3);
        this.enterFromEdge();
        break;
      }
      case 'baby': {
        this.loop = pick(BABY_LOOPS);
        this.p.enter(983);
        this.enterFromEdge();
        break;
      }
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
        this.p.enter(fam[0]);
        this.enterFromEdge();
        this.scenario = fam[0];
        sv.playSound(22010);
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
    if (this.p.tick() !== 'end') return;
    // sequence boundary
    if (this.p.offscreen()) { this.die(); return; }
    if (this.kind === 'intro') {
      if (this.chain.length) { this.p.enter(this.chain.shift()); return; }
      this.p.enter(93);
      return;
    }
    if (this.kind === 'gag') {
      // scenario finished: disperse via standard flight until offscreen
      this.p.enter(93);
      this.kind = 'gag-out';
      return;
    }
    if (this.kind === 'gag-out') { this.p.enter(93); return; }
    if (this.kind === 'toaster' || this.kind === 'baby') {
      const loops = this.kind === 'baby' ? BABY_LOOPS : ADULT_LOOPS;
      if (rand(10) === 0) {                     // 10% attitude change (adjacent)
        const i = loops.indexOf(this.loop);
        this.loop = loops[Math.max(0, Math.min(loops.length - 1,
                                               i + (rand(2) ? 1 : -1)))];
      }
      this.p.enter(this.loop);
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
    this.deadline = this.events[0] ? this.events[0].ms : 0;
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
  tick(ms) {
    this.t += ms;
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
          this.bagelTarget = { x: cx, t0: this.t, t1: this.t + (e.ms || 1), x0: this.bagelX };
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
    for (const it of fr.items) {
      if (it.artch > 1 && !this.reveal.has(it.artch)) continue;
      const im = this.sv.karArt.get(it.art);
      if (im) ctx.drawImage(im, it.rect[0], it.rect[1]);
    }
    if (this.bagelX != null) {
      const bfr = this.bagel.cur();
      const w = bfr.rect[2] - bfr.rect[0], h = bfr.rect[3] - bfr.rect[1];
      this.bagel.ox = Math.round(this.bagelX - w / 2 - bfr.rect[0]);
      this.bagel.oy = Math.round(fr.rect[1] - 31 - h - bfr.rect[1]);
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
    this.lastCloud = -1e9; this.lastGag = -1e9;
    this.lastGagB = -1e9; this.lastGagC = -1e9;
    this.audioCtx = null;
    this.introRunning = false;
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
      s + (a.kind.startsWith('cloud') || a.kind === 'babysky' ? 0 : a.weight), 0);
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
    const toasters = this.actors.filter(a => a.kind === 'toaster' || a.kind === 'baby').length;
    const food = this.actors.filter(a => a.kind.endsWith('food')).length;
    const ratio = food > 0 ? toasters / food : 4.0;
    const wantFood = (r === 2 && ratio > 2.0) || (r >= 3 && ratio > 4.0);
    const kind = wantFood ? (baby ? 'babyfood' : 'food')
                          : (baby ? 'baby' : 'toaster');
    this.actors.push(new Actor(this, kind));
    if (this.settings.sound && rand(8) === 0) this.playSound(pick([22002, 22003, 22004]));
  }

  playSound(id) {
    if (!this.settings.sound || !this.sounds[id]) return;
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx.decodeAudioData(this.sounds[id].slice(0), d => {
      const s = this.audioCtx.createBufferSource();
      s.buffer = d; s.connect(this.audioCtx.destination); s.start();
    });
  }

  tick() {
    if (this.introRunning) {
      const intro = this.actors[0];
      intro.tick();
      if (intro.dead) { this.introRunning = false; this.actors = []; }
      return;                                    // intro runs exclusively
    }
    if (this.settings.toasters !== 2) this.songType = this.settings.toasters;
    for (const a of this.actors) a.tick();
    this.actors = this.actors.filter(a => !a.dead);
    if (this.population() < this.maxObjects()) this.spawn();
    if (this.settings.karaoke) this.karaoke.tick(TICK_MS);
  }

  draw(ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
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
  for (const id of [22002, 22003, 22004, 22010]) {
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

  document.getElementById('loading').classList.add('hidden');

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  function rescale() {
    const s = Math.max(1, Math.floor(Math.min(
      window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H)));
    canvas.style.width = `${DESIGN_W * s}px`;
    canvas.style.height = `${DESIGN_H * s}px`;
  }
  window.addEventListener('resize', rescale);
  rescale();

  const panel = document.getElementById('panel');
  const togglePanel = () => panel.classList.toggle('hidden');
  window.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(); });
  canvas.addEventListener('click', togglePanel);
  document.getElementById('close-btn').onclick = togglePanel;
  document.getElementById('objects').onchange = e => { saver.settings.objects = +e.target.value; };
  document.getElementById('toasters').onchange = e => {
    saver.settings.toasters = +e.target.value;
    if (saver.settings.toasters === 2) saver.songType = rand(2);
    if (saver.settings.karaoke) saver.karaoke.reset(saver.songType);
  };
  document.getElementById('karaoke').onchange = e => {
    saver.settings.karaoke = e.target.checked;
    if (e.target.checked) saver.karaoke.reset(saver.songType);
  };
  document.getElementById('sound').onchange = e => { saver.settings.sound = e.target.checked; };
  document.getElementById('intro-btn').onclick = () => { saver.playIntro(); togglePanel(); };

  saver.playIntro();                             // authentic: intro on activation

  let acc = 0, last = performance.now();
  function frame(t) {
    acc += t - last; last = t;
    let stepped = false;
    while (acc >= TICK_MS) { acc -= TICK_MS; saver.tick(); stepped = true; }
    if (stepped) saver.draw(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
