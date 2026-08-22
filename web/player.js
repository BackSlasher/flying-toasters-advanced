/* Flying Toasters! — web recreation from reverse-engineered data.
 *
 * Data model (see ../BEHAVIOR.md):
 *  - Motion is choreography: compound frames carry absolute draw rects in a
 *    640x480 design space. A sprite has an origin; draw pos = origin + rect.
 *  - Frames with nonzero (dx,dy) are link frames: on entering one, the origin
 *    shifts by -(dx,dy)  (per-cycle drift, e.g. adult flap loop = (-60,+24)).
 *  - On entering a new sequence, origin is aligned so its first rect continues
 *    from the previous frame's rect (MoveIntoNextSequence behavior).
 *  - Logic ticks at 10 Hz (authentic cadence).
 */
'use strict';

const DESIGN_W = 640, DESIGN_H = 480, TICK_MS = 100;
const ASSETS = '../assets';

// ---------------------------------------------------------------- utilities
const rand = n => Math.floor(Math.random() * n);      // RandShort(n)
const pick = arr => arr[rand(arr.length)];

function loadJSON(url) { return fetch(url).then(r => r.json()); }

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);          // tolerate missing frames
    im.src = url;
  });
}

// ------------------------------------------------------------- sprite banks
class ArtIndex {
  constructor() { this.byId = new Map(); this.misses = new Set(); }
  async load(bankIds, banksMeta) {
    const jobs = [];
    for (const b of bankIds) {
      const meta = banksMeta[b];
      if (!meta) continue;
      for (const fid of Object.keys(meta.frames)) {
        const id = Number(fid);
        const url = `${ASSETS}/sprites/${b}/f${String(id).padStart(3, '0')}.png`;
        jobs.push(loadImage(url).then(im => {
          if (im) this.byId.set(id, im);
        }));
      }
    }
    await Promise.all(jobs);
  }
  get(id) {
    const im = this.byId.get(id);
    if (!im) this.misses.add(id);
    return im || null;
  }
}

// --------------------------------------------------------- compound playback
class Compound {
  constructor(json) {
    this.frames = json.frames;
    this.seqs = new Map();
    for (const s of json.sequences) this.seqs.set(s.label, s.frames);
  }
  frame(no) { return this.frames[String(no)]; }
}

class Player {
  /* Plays one compound sequence chain for one on-screen object. */
  constructor(compound, art) {
    this.c = compound;
    this.art = art;
    this.ox = 0; this.oy = 0;
    this.seq = null; this.idx = 0;
    this.lastRect = null;
  }
  enter(label, align = true) {
    const frames = this.c.seqs.get(label);
    if (!frames) return false;
    const first = this.c.frame(frames[0]);
    if (align && this.lastRect) {
      // continuity: first rect should continue where we left off
      this.ox += this.lastRect[0] - first.rect[0];
      this.oy += this.lastRect[1] - first.rect[1];
    }
    this.seq = frames; this.label = label; this.idx = 0;
    this._applyLink(first);
    return true;
  }
  _applyLink(fr) {
    if (fr.dx || fr.dy) { this.ox -= fr.dx; this.oy -= fr.dy; }
  }
  tick() {
    // returns 'end' when the sequence finished (caller decides what's next)
    this.idx++;
    if (this.idx >= this.seq.length) return 'end';
    this._applyLink(this.c.frame(this.seq[this.idx]));
    return 'run';
  }
  cur() { return this.c.frame(this.seq[this.idx]); }
  draw(ctx, revealSlots = null) {
    const fr = this.cur();
    this.lastRect = fr.rect;
    if (!this.lastArt) this.lastArt = new Map();
    for (const it of fr.items) {
      if (revealSlots && it.artch > 1 && !revealSlots.has(it.artch)) continue;
      let im = this.art.get(it.art);
      // boundary/gap art ids are invalid in the original engine; hold the
      // previous pose for that channel instead of blinking
      if (!im) im = this.lastArt.get(it.artch) || null;
      if (!im) continue;
      this.lastArt.set(it.artch, im);
      ctx.drawImage(im, this.ox + it.rect[0], this.oy + it.rect[1]);
    }
  }
  bounds() {
    const fr = this.cur();
    return [this.ox + fr.rect[0], this.oy + fr.rect[1],
            this.ox + fr.rect[2], this.oy + fr.rect[3]];
  }
}

// ------------------------------------------------------------ actor catalog
// Curated from compound_22000.json (labels chain from rect0=(397,103) for
// adults; babies have their own cluster). Weights ~= plain flaps dominate.
const ADULT = {
  entry: 2,
  loops: [17, 32, 47, 62, 77, 208, 845, 860, 912],
  specials: [104, 132, 171, 230, 251, 519, 585, 621, 748, 806, 878,
             1371, 2173, 2390, 2405, 2747, 2801],
};
const BABY = {
  entry: 982,
  loops: [987, 996, 1002, 1008, 1013, 1018, 1025, 1032],
  specials: [1038, 1065, 1106, 1111],
};
// Food sequences have link (0,0) — drift is applied by the object (the exact
// FlyingFood motion is still being reverse-engineered; this approximates the
// adult glide slope).                                             [APPROX]
const FOOD_SEQS = [3001, 3001, 3001, 2978, 3023, 2968, 2973, 3038, 1212, 1386];
const FOOD_DRIFT = { x: -4.5, y: 1.8 };

class Actor {
  constructor(compound, art, kind) {
    this.kind = kind;                        // 'toaster' | 'baby' | 'food'
    this.p = new Player(compound, art);
    this.dead = false;
    const cat = kind === 'baby' ? BABY : ADULT;
    if (kind === 'food') {
      this.p.enter(pick(FOOD_SEQS), false);
    } else {
      this.p.enter(kind === 'baby' ? cat.entry : cat.entry, false);
    }
    this._place();
  }
  _place() {
    // enter from a random point along an extended top/right band
    const fr = this.p.cur();
    const [l, t, r, b] = fr.rect;
    const w = r - l, h = b - t;
    const alongTop = rand(DESIGN_W + DESIGN_H) < DESIGN_W;
    if (alongTop) {
      this.p.ox = rand(DESIGN_W + 200) - 100 - l;
      this.p.oy = -(b + rand(120));
    } else {
      this.p.ox = DESIGN_W + rand(160) - l;
      this.p.oy = rand(DESIGN_H / 2) - t - 100;
    }
  }
  tick() {
    if (this.kind === 'food') { this.p.ox += FOOD_DRIFT.x; this.p.oy += FOOD_DRIFT.y; }
    if (this.p.tick() === 'end') this._next();
    const [l, t, r, b] = this.p.bounds();
    if (r < -160 || l > DESIGN_W + 260 || t > DESIGN_H + 160 || b < -260) {
      this.dead = true;
    }
  }
  _next() {
    if (this.kind === 'food') { this.p.enter(this.p.label); this.p.idx = 0; return; }
    const cat = this.kind === 'baby' ? BABY : ADULT;
    let label = this.p.label;
    if (cat.loops.includes(label) || label === cat.entry) {
      if (rand(10) === 0) label = pick(cat.loops);          // 10% heading change
      else if (rand(24) === 0) label = pick(cat.specials);  // rare special
      else if (label === cat.entry) label = pick(cat.loops);
    } else {
      label = pick(cat.loops);                              // return to ladder
    }
    if (!this.p.enter(label)) { this.p.enter(pick(cat.loops)); }
    this.p.idx = 0;
  }
  draw(ctx) { this.p.draw(ctx); }
}

// ------------------------------------------------------------------ karaoke
class Karaoke {
  constructor(compound, art, tables) {
    this.c = compound; this.art = art; this.tables = tables;
    this.reset(0);
  }
  reset(song) {
    this.song = song;
    this.events = this.tables[String(song)].events;
    this.i = -1;
    this.wait = this.events[0] ? this.events[0].ms : 0;
    this.line = 0;
    this.reveal = new Set();
    this.t = 0;
  }
  tick(ms) {
    this.t += ms;
    while (this.t >= this.wait && this.i < this.events.length - 1) {
      this.t -= this.wait;
      this.i++;
      const e = this.events[this.i];
      this.wait = e.ms || 0;
      if (e.ev === 0) { this.line = e.line; this.reveal = new Set(); }
      else if (e.ev === 1) { this.line = e.line; this.reveal.add(e.word); }
      else if (e.ev === 4) {
        // end of line: keep shown for its duration, then clear on next event
        if (this.i === this.events.length - 1) this.reset(this.song); // loop
      }
    }
  }
  draw(ctx) {
    if (!this.line) return;
    const frames = this.c.seqs.get(this.line) || [this.line];
    const fr = this.c.frame(frames[0]);
    if (!fr) return;
    for (const it of fr.items) {
      if (it.artch > 1 && !this.reveal.has(it.artch)) continue;
      const im = this.art.get(it.art);
      if (im) ctx.drawImage(im, it.rect[0], it.rect[1]);
    }
  }
}

// -------------------------------------------------------------------- intro
// Evolution slideshow — order/timing approximated from bank inspection
// (22027..22033 stills + caption cards) until the exact FlyingIntro logic
// lands from disassembly.                                          [APPROX]
class Intro {
  constructor(art) {
    this.art = art;
    this.stills = [22027, 22028, 22029, 22030, 22031, 22032, 22033];
    this.i = 0; this.t = 0; this.done = false;
    this.frameIds = null;
  }
  tick(ms, banksMeta) {
    this.t += ms;
    if (this.t > 2600) { this.t = 0; this.i++; if (this.i >= this.stills.length) this.done = true; }
  }
  draw(ctx, banksMeta) {
    if (this.done) return;
    const bank = this.stills[this.i];
    const meta = banksMeta[bank];
    if (!meta) return;
    const fids = Object.keys(meta.frames).map(Number).sort((a, b) => a - b);
    const phase = Math.floor(this.t / (2600 / fids.length));
    const fid = fids[Math.min(phase, fids.length - 1)];
    const im = this.art.get(fid);
    if (!im) return;
    ctx.drawImage(im, (DESIGN_W - im.width) / 2, (DESIGN_H - im.height) / 2);
  }
}

// --------------------------------------------------------------- controller
class Screensaver {
  constructor(assets) {
    this.art = assets.art;
    this.karArt = assets.karArt;
    this.compound = assets.compound;
    this.karCompound = assets.karCompound;
    this.banksMeta = assets.banksMeta;
    this.karaokeTables = assets.karaoke;
    this.actors = [];
    this.settings = { objects: 50, toasters: 0, karaoke: false, sound: false };
    this.songType = 0;
    this.karaoke = new Karaoke(this.karCompound, this.karArt, this.karaokeTables);
    this.intro = null;
    this.sounds = assets.sounds;
    this.audioCtx = null;
  }

  maxObjects() {
    const density = (DESIGN_W * DESIGN_H) / 480000;         // 0.64
    let n = density * (this.songType === 1 ? 22 : 30);
    const o = this.settings.objects;
    if (o >= 75) { /* swarm x1 */ }
    else if (o >= 50) n *= 0.5;
    else if (o >= 25) n *= 0.25;
    else n = this.songType === 1 ? 5 : 3;
    return Math.max(1, Math.round(n));
  }

  babyMode() {
    if (this.settings.toasters === 1) return true;
    if (this.settings.toasters === 2) return this.songType === 1;
    return false;
  }

  playIntro() { this.intro = new Intro(this.art); }

  spawn() {
    const toasters = this.actors.filter(a => a.kind !== 'food').length;
    const food = this.actors.filter(a => a.kind === 'food').length;
    const ratio = food > 0 ? toasters / food : 4.0;
    const r = rand(5);
    let kind;
    if (r === 2) kind = ratio > 2.0 ? 'food' : 'main';
    else if (r >= 3) kind = ratio > 4.0 ? 'food' : 'main';
    else kind = 'main';
    if (kind === 'main') kind = this.babyMode() ? 'baby' : 'toaster';
    this.actors.push(new Actor(this.compound, this.art, kind));
    if (this.settings.sound && rand(6) === 0) this.playSound(pick([22000, 22001, 22004]));
  }

  playSound(id) {
    const buf = this.sounds[id];
    if (!buf) return;
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx.decodeAudioData(buf.slice(0), decoded => {
      const src = this.audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(this.audioCtx.destination);
      src.start();
    });
  }

  tick() {
    if (this.intro && !this.intro.done) { this.intro.tick(TICK_MS, this.banksMeta); return; }
    if (this.settings.toasters === 2 && rand(3000) === 0) this.songType = rand(2);
    else if (this.settings.toasters !== 2) this.songType = this.settings.toasters;
    for (const a of this.actors) a.tick();
    this.actors = this.actors.filter(a => !a.dead);
    if (this.actors.length < this.maxObjects()) this.spawn();
    if (this.settings.karaoke) this.karaoke.tick(TICK_MS);
  }

  draw(ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    if (this.intro && !this.intro.done) { this.intro.draw(ctx, this.banksMeta); return; }
    // stable z-order: painter's order by spawn time (original keeps a z list)
    for (const a of this.actors) a.draw(ctx);
    if (this.settings.karaoke) this.karaoke.draw(ctx);
  }
}

// -------------------------------------------------------------------- boot
async function boot() {
  const [banksMeta, comp22000, comp22100, karaoke] = await Promise.all([
    loadJSON(`${ASSETS}/sprites/banks.json`),
    loadJSON(`${ASSETS}/compound_22000.json`),
    loadJSON(`${ASSETS}/compound_22100.json`),
    loadJSON(`${ASSETS}/karaoke.json`),
  ]);
  const toasterBanks = Object.keys(banksMeta).map(Number).filter(b => b < 22100);
  const karBanks = Object.keys(banksMeta).map(Number).filter(b => b >= 22100);
  const art = new ArtIndex();
  const karArt = new ArtIndex();
  await Promise.all([art.load(toasterBanks, banksMeta), karArt.load(karBanks, banksMeta)]);

  // sounds (fetched lazily as raw buffers; decoded on demand)
  const sounds = {};
  for (const id of [22000, 22001, 22004]) {
    fetch(`${ASSETS}/sounds/${id}.wav`).then(r => r.arrayBuffer()).then(b => { sounds[id] = b; }).catch(() => {});
  }

  const saver = new Screensaver({
    art, karArt,
    compound: new Compound(comp22000),
    karCompound: new Compound(comp22100),
    banksMeta, karaoke, sounds,
  });

  document.getElementById('loading').classList.add('hidden');
  window.saver = saver;                      // debug hook
  window.artDebug = { art, karArt };

  // --- canvas scale
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

  // --- settings panel
  const panel = document.getElementById('panel');
  const togglePanel = () => panel.classList.toggle('hidden');
  window.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(); });
  canvas.addEventListener('click', togglePanel);
  document.getElementById('close-btn').onclick = togglePanel;
  document.getElementById('objects').onchange = e => { saver.settings.objects = Number(e.target.value); };
  document.getElementById('toasters').onchange = e => { saver.settings.toasters = Number(e.target.value); };
  document.getElementById('karaoke').onchange = e => {
    saver.settings.karaoke = e.target.checked;
    if (e.target.checked) saver.karaoke.reset(saver.songType);
  };
  document.getElementById('sound').onchange = e => { saver.settings.sound = e.target.checked; };
  document.getElementById('intro-btn').onclick = () => { saver.playIntro(); togglePanel(); };

  // --- main loop: 10 Hz logic, draw on tick
  let acc = 0, last = performance.now();
  function frame(now) {
    acc += now - last; last = now;
    let stepped = false;
    while (acc >= TICK_MS) { acc -= TICK_MS; saver.tick(); stepped = true; }
    if (stepped) saver.draw(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
