/* Fake Tuner controller — receivers.json driven, RDS groups, multi-stream pool. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt3 = (f) => Number(f).toFixed(3);

  // ----- PTY tables -----
  const PTY_RDS = [
    "None","News","Current Affairs","Information","Sport","Education","Drama","Culture",
    "Science","Varied","Pop Music","Rock Music","Easy Listening","Light Classics","Serious Classics","Other Music",
    "Weather","Finance","Children's","Social Affairs","Religion","Phone In","Travel","Leisure",
    "Jazz","Country","National Music","Oldies","Folk Music","Documentary","Alarm Test","Alarm"
  ];
  const PTY_RBDS = [
    "None","News","Information","Sports","Talk","Rock","Classic Rock","Adult Hits",
    "Soft Rock","Top 40","Country","Oldies","Soft","Nostalgia","Jazz","Classical",
    "Rhythm and Blues","Soft R&B","Foreign Language","Religious Music","Religious Talk","Personality","Public","College",
    "Spanish Talk","Spanish Music","Hip Hop","Unassigned","Unassigned","Weather","Emergency Test","Emergency"
  ];

  const RDS_LOCK_BW   = 0.05;
  const GROUP_MS      = 600;
  const NEIGHBOR_COUNT = 2;
  const PI_DELAY_MS   = 100;        // PI appears ~100ms after lock
  const RDS_START_MS  = 220;        // first RDS group ~220ms after PI

  let CFG = null;
  let audioDelayS = 0.8;
  let currentFreq = 0;
  let icecast = {};
  let muted = false;                // legacy alias; play toggle uses `playing`
  let playing = false;
  let forcedMono = false;
  let snrHistory = [];

  // RDS state
  let lockedStation = null;
  let lockedAtMs = 0;
  let groupTick = 0;
  let piShown = false;
  let stereoPilotMs = 0;
  let lastQuality = 0;
  let stereoErraticOff = 0;        // performance.now() until which we hold mono

  // PS scheduler
  let psFilled = [false,false,false,false];
  let psBuf = "        ";
  let psFullText = "";
  let psFirstCycleDone = false;
  let psChunks = [];
  let psChunkIdx = 0;
  let psChunkHoldTicks = 0;        // counts group ticks for "groups" mode
  let psScrollOffset = 0;
  let psScrollDir = 1;
  let psScrollNextMs = 0;
  let psMode = "groups";

  let rtTargetRaw = "";
  let rtSegFilled = [];
  let rtBuf = "";
  let rtPrevious = "";
  let rtFirstLoad = true;
  let afShownCount = 0;
  let rdsBasicShown = false;
  let rdsTxShown = false;

  // Audio
  let ac = null, masterGain = null, noiseGain = null;
  const pool = new Map();

  // ---------- helpers ----------
  function getPTYList() {
    const mode = (CFG && CFG.rdsMode) || "rds";
    const base = mode === "rbds" ? PTY_RBDS : PTY_RDS;
    const ov = (CFG && CFG.ptyOverrides) || {};
    return base.map((s, i) => (ov[i] != null ? ov[i] : s));
  }
  const RDS_CHAR_MAP = {
    "é":"e","è":"e","ê":"e","ë":"e","É":"E","È":"E","Ê":"E","Ë":"E",
    "à":"a","á":"a","â":"a","ä":"a","ã":"a","å":"a","À":"A","Á":"A","Â":"A","Ä":"A",
    "ì":"i","í":"i","î":"i","ï":"i","Î":"I","Ï":"I",
    "ò":"o","ó":"o","ô":"o","ö":"o","õ":"o","Ó":"O","Ô":"O","Ö":"O",
    "ù":"u","ú":"u","û":"u","ü":"u","Ú":"U","Ü":"U",
    "ç":"c","Ç":"C","ñ":"n","Ñ":"N","ß":"ss","ÿ":"y","æ":"ae","œ":"oe",
    "\u2018":"'","\u2019":"'","\u201C":'"',"\u201D":'"',"\u2013":"-","\u2014":"-","\u2026":"..."
  };
  function toRdsAscii(s) {
    if (!s) return s;
    let out = "";
    for (const ch of s) {
      const m = RDS_CHAR_MAP[ch];
      if (m != null) out += m;
      else if (ch.charCodeAt(0) < 128) out += ch;
      else out += "?";
    }
    return out;
  }
  function resolveTokens(tpl, src) {
    if (!tpl) return "";
    let t = tpl;
    const md = (src && src.title) || "";
    const sv = (src && src.server_name) || "";
    const caps = /\(ALLCAPS\)/.test(t);
    t = t.replace(/\(ALLCAPS\)/g, "").replace(/%ICEMD%/g, md).replace(/%SERVER%/g, sv);
    if (caps) t = t.toUpperCase();
    return toRdsAscii(t.trim());
  }
  const pad8 = (s) => (s + "        ").slice(0, 8);
  const cap64 = (s) => s.length > 64 ? s.slice(0, 64) : s;
  function piIsNull(pi) {
    const p = (pi || "").toUpperCase();
    return !p || p === "0000" || p === "FFFF";
  }
  function hasRDS(st) { return !!(st && !st.rdsDisabled && !piIsNull(st.pi)); }
  function renderFlag(flag) {
    if (!flag) return "";
    if (/^https?:\/\//i.test(flag) || flag.startsWith("/")) {
      return `<img class="custom-flag" src="${flag}" alt="">`;
    }
    return `<i class="flag-sm flag-sm-${String(flag).toLowerCase()}"></i>`;
  }
  function audibleBwFor(st) {
    return (st && typeof st.audibleBandwidth === "number")
      ? st.audibleBandwidth
      : CFG.audibleBandwidth;
  }

  // ---------- bootstrap ----------
  async function loadConfig() {
    let data = null;
    try {
      const ov = JSON.parse(localStorage.getItem("receivers_override") || "null");
      if (ov?.receivers) data = ov;
    } catch (e) {}
    if (!data) {
      try { data = await fetch("/receivers.json").then(r => r.json()); }
      catch (e) { data = { receivers: [] }; }
    }
    const slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ""));
    const rec = (data.receivers || []).find(r => r.slug === slug) || (data.receivers || [])[0];
    if (!rec) {
      document.body.innerHTML = "<div style='color:#fff;font-family:sans-serif;padding:40px'><h2>Receiver \"" + slug + "\" not found.</h2><a href='/' style='color:#68f7ee'>← Back to receivers</a></div>";
      return null;
    }
    return rec.config;
  }

  // ---------- station / signal ----------
  function stationForFreq(freq) {
    let best = null, bestDist = Infinity;
    CFG.stations.forEach((st) => {
      const d = Math.abs(st.freq - freq);
      if (d < bestDist) { bestDist = d; best = st; }
    });
    return { station: best, offset: best ? freq - best.freq : 0 };
  }
  function baseSignal(st, off) {
    if (!st) return CFG.noiseFloorDbf;
    const bw = audibleBwFor(st);
    const k = Math.exp(-Math.pow(off / (bw / 2), 2) * 2);
    return CFG.noiseFloorDbf + (st.signal - CFG.noiseFloorDbf) * k;
  }
  function neighbors(freq) {
    const sorted = [...CFG.stations].sort((a,b) => a.freq - b.freq);
    let nearestIdx = 0, nd = Infinity;
    sorted.forEach((s, i) => { const d = Math.abs(s.freq - freq); if (d < nd) { nd = d; nearestIdx = i; }});
    const out = [];
    for (let i = Math.max(0, nearestIdx - NEIGHBOR_COUNT); i <= Math.min(sorted.length - 1, nearestIdx + NEIGHBOR_COUNT); i++) out.push(sorted[i]);
    return out;
  }

  // ---------- audio pool ----------
  function makeCurve(amount) {
    const n = 1024, c = new Float32Array(n), deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return c;
  }
  function ensureAudio() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ac.createGain();
    masterGain.gain.value = parseFloat(($("#volumeSlider")?.value) ?? "1");
    masterGain.connect(ac.destination);
    // Pink noise band-limited 30 Hz – 15 kHz
    const bs = 2 * ac.sampleRate;
    const nb = ac.createBuffer(1, bs, ac.sampleRate);
    const d = nb.getChannelData(0);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < bs; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    const nNode = ac.createBufferSource(); nNode.buffer = nb; nNode.loop = true;
    const nHP = ac.createBiquadFilter(); nHP.type = "highpass"; nHP.frequency.value = 30;
    const nLP = ac.createBiquadFilter(); nLP.type = "lowpass"; nLP.frequency.value = 15000;
    noiseGain = ac.createGain(); noiseGain.gain.value = 0;
    nNode.connect(nHP).connect(nLP).connect(noiseGain).connect(masterGain);
    nNode.start();
  }
  function ensureStation(mount) {
    if (!ac || !mount) return null;
    if (pool.has(mount)) return pool.get(mount);
    // Find station config to read per-station EQ + volume
    const stCfg = CFG.stations.find((s) => s.mount === mount) || {};
    let audio, source;
    try {
      audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      audio.loop = false;
      audio.src = `/api/stream/${mount}`;
      if (playing) audio.play().catch(() => {});
      source = ac.createMediaElementSource(audio);
    } catch (e) { return null; }

    // Per-station volume (can be >1 to drive distortion)
    const stVol = ac.createGain();
    stVol.gain.value = (typeof stCfg.volume === "number") ? stCfg.volume : 1;

    // Audio delay simulates the streaming buffer. All tuner-side effects
    // come AFTER the delay so that retuning instantly affects the audio
    // currently being heard (no stale 800ms of distorted/stereo audio).
    const delay = ac.createDelay(2.5); delay.delayTime.value = audioDelayS;

    // Per-station parametric EQ (chain of peaking biquads)
    const eqNodes = [];
    (stCfg.eq || []).forEach((band) => {
      const f = ac.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = band.freq || 1000;
      f.gain.value = band.gain || 0;
      f.Q.value = band.q || 1;
      eqNodes.push(f);
    });

    // Off-tuning filters (sweep based on |offset|)
    const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 30;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass";  lp.frequency.value = 15000;

    // WaveShaper for off-tuning distortion (driven by stVol if >1)
    const ws = ac.createWaveShaper(); ws.curve = makeCurve(0);

    // Mono / stereo split-merge
    const splitter = ac.createChannelSplitter(2);
    const merger = ac.createChannelMerger(2);
    const monoL = ac.createGain(); monoL.gain.value = 0.5;
    const monoR = ac.createGain(); monoR.gain.value = 0.5;
    splitter.connect(monoL, 0); splitter.connect(monoR, 1);
    monoL.connect(merger, 0, 0); monoR.connect(merger, 0, 0);
    monoL.connect(merger, 0, 1); monoR.connect(merger, 0, 1);
    const stereoGain = ac.createGain(); stereoGain.gain.value = 1;
    const monoGain = ac.createGain();   monoGain.gain.value = 0;

    const gain = ac.createGain(); gain.gain.value = 0;

    // Chain: source -> stVol -> delay -> eq* -> hp -> lp -> ws -> (stereo|mono) -> gain -> master
    let node = source.connect(stVol).connect(delay);
    let cur = delay;
    eqNodes.forEach((f) => { cur.connect(f); cur = f; });
    cur.connect(hp).connect(lp).connect(ws);
    ws.connect(stereoGain);
    ws.connect(splitter);
    merger.connect(monoGain);
    stereoGain.connect(gain);
    monoGain.connect(gain);
    gain.connect(masterGain);

    const out = { audio, source, stVol, delay, eqNodes, hp, lp, ws, splitter, merger,
                  monoL, monoR, stereoGain, monoGain, gain, _cfg: stCfg };
    pool.set(mount, out);
    return out;
  }
  function pruneStations(keep) {
    for (const [m, n] of pool) {
      if (keep.has(m)) continue;
      try { n.audio.pause(); n.audio.removeAttribute("src"); n.audio.load(); } catch(e){}
      try {
        n.source?.disconnect(); n.stVol?.disconnect(); n.delay?.disconnect();
        n.eqNodes?.forEach((f) => f.disconnect());
        n.hp?.disconnect(); n.lp?.disconnect(); n.ws?.disconnect();
        n.splitter?.disconnect(); n.merger?.disconnect();
        n.monoL?.disconnect(); n.monoR?.disconnect();
        n.stereoGain?.disconnect(); n.monoGain?.disconnect(); n.gain?.disconnect();
      } catch(e){}
      pool.delete(m);
    }
  }
  function applyAudioModel(currentStation, offset, sig) {
    if (!ac) return;
    const bw = audibleBwFor(currentStation);
    const inside = currentStation && Math.abs(offset) <= bw;
    const onFreq = currentStation && Math.abs(offset) <= RDS_LOCK_BW;
    const quality = clamp((sig - CFG.noiseFloorDbf) / 50, 0, 1);
    lastQuality = quality;
    const offR = currentStation ? clamp(Math.abs(offset) / bw, 0, 1) : 1;
    const now = performance.now();

    // ---- erratic pilot detection on weak signals ----
    // On strong signals (q>0.7) stereo is rock solid. On weak ones we
    // randomly drop into mono for short bursts (100-400ms).
    if (lockedStation && lockedStation === currentStation && onFreq && currentStation.stereo && !forcedMono) {
      if (quality < 0.7 && now > stereoErraticOff) {
        const dropProb = clamp((0.7 - quality) * 0.25, 0, 0.18);
        if (Math.random() < dropProb) {
          stereoErraticOff = now + 100 + Math.random() * 300;
        }
      }
    }
    const pilotDetected = !!(lockedStation && now >= stereoPilotMs);
    const stereoActive = !!(onFreq && currentStation && currentStation.stereo
                            && !forcedMono && pilotDetected
                            && currentStation === lockedStation
                            && now > stereoErraticOff);

    for (const [mount, n] of pool) {
      const isCurrent = inside && mount === currentStation.mount;
      const t0 = ac.currentTime;
      if (isCurrent) {
        // Distortion increases with offset (off-tuning); overmodulation (volume>1)
        // also drives more into the curve. Curve change isn't a param so set
        // immediately — but the audio it shapes already lives after the delay,
        // so the heard audio responds in sync with retuning.
        const drive = offR * 60 + Math.max(0, ((n._cfg?.volume || 1) - 1) * 40);
        n.ws.curve = makeCurve(drive);
        n.lp.frequency.setTargetAtTime(
          clamp(15000 - offR * 11000 - (1 - quality) * 6000, 1500, 15000),
          t0, 0.05);
        // Low end gets cut as you go off frequency (real-tuner behavior)
        n.hp.frequency.setTargetAtTime(
          clamp(30 + offR * 370, 30, 400),
          t0, 0.05);
        n.gain.gain.setTargetAtTime(
          (1 - offR * 0.6) * (0.4 + quality * 0.6),
          t0, 0.03);
        // Stereo / mono crossfade — applied to post-delay audio so it tracks
        // tuning changes in real time.
        n.stereoGain.gain.setTargetAtTime(stereoActive ? 1 : 0, t0, 0.02);
        n.monoGain.gain.setTargetAtTime(stereoActive ? 0 : 1, t0, 0.02);
      } else {
        n.gain.gain.setTargetAtTime(0, t0, 0.03);
        // Off-frequency stations always collapse to mono so when you tune
        // back they don't briefly play in stereo.
        n.stereoGain.gain.setTargetAtTime(0, t0, 0.02);
        n.monoGain.gain.setTargetAtTime(1, t0, 0.02);
      }
    }
    noiseGain.gain.setTargetAtTime(
      playing ? clamp((1 - quality) * 0.35 + offR * 0.3, 0, 0.6) : 0,
      ac.currentTime, 0.05);
  }

  // ---------- RDS render ----------
  function clearRDS() {
    $("#data-pi").textContent = "----";
    const ps = $("#data-ps"); if (ps) ps.textContent = "        ";
    const r0 = $("#data-rt0 span"), r1 = $("#data-rt1 span");
    if (r0) r0.textContent = ""; if (r1) r1.textContent = "";
    $$(".data-pty").forEach((e) => (e.textContent = ""));
    $$(".data-ms").forEach((el) => {
      el.innerHTML = `<span class="opacity-half">M</span><span class="opacity-half">S</span>`;
    });
    $$(".data-tp span").forEach((e) => (e.className = "opacity-half"));
    $$(".data-ta span").forEach((e) => (e.className = "opacity-half"));
    $$(".data-flag").forEach((e) => (e.innerHTML = ""));
    const afList = $("#af-list ul"); if (afList) afList.innerHTML = "";
    const logo = $("#station-logo");
    if (logo) { logo.removeAttribute("src"); logo.style.display = "none"; }
  }
  function clearTX() {
    const c = $("#data-station-container");
    if (c) c.style.display = "none";
    ["#data-station-name","#data-station-city","#data-station-itu","#data-station-erp","#data-station-pol","#data-station-distance","#data-station-azimuth"]
      .forEach((id) => { const e = $(id); if (e) e.textContent = ""; });
  }
  function showBasicRDS(st) {
    $("#data-pi").textContent = (st.pi || "----").toUpperCase();
    const PTY = getPTYList();
    $$(".data-pty").forEach((e) => (e.textContent = PTY[st.pty] || ""));
    $$(".data-tp span").forEach((e) => (e.className = st.tp ? "opacity-full" : "opacity-half"));
    $$(".data-ta span").forEach((e) => (e.className = st.ta ? "opacity-full" : "opacity-half"));
    $$(".data-ms").forEach((el) => {
      const ms = (st.ms || "M").toUpperCase();
      el.innerHTML =
        `<span class="${ms === 'M' ? 'opacity-full' : 'opacity-half'}">M</span>` +
        `<span class="${ms === 'S' ? 'opacity-full' : 'opacity-half'}">S</span>`;
    });
    $$(".data-flag").forEach((e) => (e.innerHTML = renderFlag(st.flag)));
    const logo = $("#station-logo");
    if (logo) {
      if (st.logo) { logo.src = st.logo; logo.style.display = "block"; }
      else { logo.removeAttribute("src"); logo.style.display = "none"; }
    }
  }
  function paintPS() { const el = $("#data-ps"); if (el) el.textContent = psBuf; }
  function paintRT() {
    const r0 = $("#data-rt0 span"), r1 = $("#data-rt1 span");
    if (r0) r0.textContent = rtBuf;
    if (r1) r1.textContent = rtFirstLoad ? "" : rtPrevious;
  }
  function paintAF(st) {
    const afList = $("#af-list ul");
    if (!afList) return;
    const af = (st.af || []).slice(0, afShownCount);
    afList.innerHTML = af.map((f) => `<li><a>${fmt3(f)}</a></li>`).join("");
  }
  function showTX(st) {
    const s = st.station;
    const container = $("#data-station-container");
    if (!s || (!s.name && !s.city && !s.itu)) {
      if (container) container.style.display = "none";
      return;
    }
    if (container) container.style.display = "block";
    const setT = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    setT("#data-station-name", s.name || "");
    setT("#data-station-city", s.city || "");
    setT("#data-station-itu", s.itu || "");
    setT("#data-station-erp", (typeof s.erp === "number") ? s.erp : "");
    setT("#data-station-pol", s.pol || "");
    setT("#data-station-distance", (typeof s.distance === "number") ? (s.distance + " km") : "");
    setT("#data-station-azimuth", (typeof s.azimuth === "number") ? (s.azimuth + "°") : "");
  }

  // ---------- PS scheduler ----------
  function splitPSChunks(text) {
    if (!text) return ["        "];
    const t = toRdsAscii(text).trim();
    if (t.length <= 8) return [pad8(t)];
    // Greedy word packing into 8-char chunks
    const words = t.split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
      if (w.length > 8) {
        if (cur) { out.push(pad8(cur)); cur = ""; }
        for (let i = 0; i < w.length; i += 8) out.push(pad8(w.slice(i, i + 8)));
        continue;
      }
      const trial = cur ? cur + " " + w : w;
      if (trial.length > 8) { out.push(pad8(cur)); cur = w; }
      else cur = trial;
    }
    if (cur) out.push(pad8(cur));
    return out;
  }
  function initPSForLock(st) {
    psFullText = resolveTokens(st.ps, icecast[st.mount]) || (st.station?.name || "");
    psMode = (st.dynamicPsMode || CFG.dynamicPsMode || "groups").toLowerCase();
    psChunks = splitPSChunks(psFullText);
    psChunkIdx = 0;
    psChunkHoldTicks = 0;
    psScrollOffset = 0;
    psScrollDir = 1;
    psScrollNextMs = performance.now() + (st.scrollStopStartMs ?? CFG.scrollStopStartMs ?? 1500);
    psFirstCycleDone = false;
  }
  // For initial fill, fill the FIRST chunk (or first 8 chars for scroll mode)
  // through the RDS group cadence — 2 chars at a time per group.
  function psInitialFillTarget() {
    if (psMode === "scroll") return pad8(psFullText.slice(0, 8));
    return psChunks[0] || "        ";
  }
  function psSchedulerTick() {
    if (!lockedStation || !psFirstCycleDone) return;
    const st = lockedStation;
    if (psMode === "static") return;
    if (psMode === "scroll") {
      const now = performance.now();
      if (now < psScrollNextMs) return;
      const text = pad8(psFullText) + "   "; // small trailing pad
      const maxOff = Math.max(0, text.length - 8);
      psScrollOffset += psScrollDir;
      if (psScrollOffset >= maxOff) {
        psScrollOffset = maxOff;
        psScrollDir = -1;
        psScrollNextMs = now + (st.scrollStopEndMs ?? CFG.scrollStopEndMs ?? 1500);
      } else if (psScrollOffset <= 0) {
        psScrollOffset = 0;
        psScrollDir = 1;
        psScrollNextMs = now + (st.scrollStopStartMs ?? CFG.scrollStopStartMs ?? 1500);
      } else {
        psScrollNextMs = now + (st.scrollSpeedMs ?? CFG.scrollSpeedMs ?? 300);
      }
      psBuf = text.slice(psScrollOffset, psScrollOffset + 8);
      paintPS();
      return;
    }
    // groups (default): hold for N group ticks then transmit next chunk
  }
  // Called from rdsGroup() for groups-mode chunk transitions
  function psGroupsAdvance(st) {
    if (psMode !== "groups" || !psFirstCycleDone || psChunks.length <= 1) return;
    const hold = st.groupsHoldGroups ?? CFG.groupsHoldGroups ?? 4;
    psChunkHoldTicks++;
    if (psChunkHoldTicks >= hold) {
      psChunkHoldTicks = 0;
      psChunkIdx = (psChunkIdx + 1) % psChunks.length;
      // Animate the new chunk filling in 2 chars per group via a mini state.
      // Simpler: just flip to the next chunk in one step (very close to
      // Stereo Tool behavior, which transmits the full new chunk together).
      psBuf = psChunks[psChunkIdx];
      paintPS();
    }
  }

  // ---------- RDS group tick ----------
  function rdsGroup() {
    if (!lockedStation) return;
    const st = lockedStation;
    const now = performance.now();
    if (now - lockedAtMs < PI_DELAY_MS + RDS_START_MS) return;
    const src = icecast[st.mount];
    groupTick++;

    if (!rdsBasicShown) {
      rdsBasicShown = true;
      showBasicRDS(st);
    }

    // Glitch probabilities scale with low signal
    const q = lastQuality;
    const dropProb = clamp((1 - q) * 0.6, 0, 0.6);

    // ---- PS initial fill (groups-style, 2 chars per group) ----
    if (!psFirstCycleDone) {
      const target = psInitialFillTarget();
      if (!psFilled.every(Boolean)) {
        if (Math.random() >= dropProb) {
          for (let i = 0; i < 4; i++) {
            if (!psFilled[i]) {
              psFilled[i] = true;
              const chars = target.slice(i * 2, i * 2 + 2);
              psBuf = psBuf.slice(0, i * 2) + chars + psBuf.slice(i * 2 + 2);
              paintPS();
              break;
            }
          }
        }
      } else {
        psFirstCycleDone = true;
      }
    } else {
      psGroupsAdvance(st);
    }

    // ---- AF reveal ----
    const afTotal = (st.af || []).length;
    if (afShownCount < afTotal && groupTick % 2 === 0 && Math.random() >= dropProb) {
      afShownCount++;
      paintAF(st);
    }

    // ---- RT fill ----
    const newTarget = cap64(resolveTokens(st.rt, src));
    if (newTarget && newTarget !== rtTargetRaw) {
      if (rtBuf) rtPrevious = rtBuf;
      if (rtTargetRaw) rtFirstLoad = false;
      rtTargetRaw = newTarget;
      const segCount = Math.ceil(rtTargetRaw.length / 8);
      rtSegFilled = new Array(segCount).fill(false);
      rtBuf = "";
      paintRT();
    }
    if (rtTargetRaw && rtSegFilled.some((v) => !v) && Math.random() >= dropProb) {
      for (let i = 0; i < rtSegFilled.length; i++) {
        if (!rtSegFilled[i]) {
          rtSegFilled[i] = true;
          let chars = rtTargetRaw.slice(i * 8, i * 8 + 8);
          // Weak signals: occasionally corrupt one char
          if (q < 0.25 && Math.random() < 0.4 && chars.length > 0) {
            const ci = Math.floor(Math.random() * chars.length);
            chars = chars.slice(0, ci) + "_" + chars.slice(ci + 1);
          }
          while (rtBuf.length < i * 8) rtBuf += " ";
          rtBuf = rtBuf.slice(0, i * 8) + chars + rtBuf.slice(i * 8 + chars.length);
          paintRT();
          break;
        }
      }
      if (rtSegFilled.every(Boolean)) rtFirstLoad = false;
    }

    // ---- TX info after ~4s of lock ----
    if (!rdsTxShown && now - lockedAtMs > 4500) {
      rdsTxShown = true;
      showTX(st);
    }
  }

  // ---------- SNR canvas ----------
  function drawSNR() {
    const c = $("#signal-canvas"); if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w*dpr) || c.height !== Math.round(h*dpr)) {
      c.width = Math.round(w*dpr); c.height = Math.round(h*dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let y = 0.25; y < 1; y += 0.25) { ctx.beginPath(); ctx.moveTo(0, h*y); ctx.lineTo(w, h*y); ctx.stroke(); }
    const col = getComputedStyle(document.documentElement).getPropertyValue("--color-main-bright").trim();
    ctx.strokeStyle = col || "#68f7ee";
    ctx.lineWidth = 2; ctx.beginPath();
    const max = 80, n = snrHistory.length;
    snrHistory.forEach((v, i) => {
      const x = (i / Math.max(1, n - 1)) * w;
      const y = h - clamp(v / max, 0, 1) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  // ---------- main paint ----------
  function paint() {
    const { station, offset } = stationForFreq(currentFreq);
    const audible = station && Math.abs(offset) <= audibleBwFor(station);
    const onFreq = station && Math.abs(offset) <= RDS_LOCK_BW;

    const base = baseSignal(station, offset);
    const jitter = (Math.random() - 0.5) * (audible ? 1.6 : 3.0);
    const sig = Math.max(0, base + jitter);

    $("#data-frequency").textContent = fmt3(currentFreq);
    const ci = $("#commandinput");
    if (ci && document.activeElement !== ci) ci.value = fmt3(currentFreq);
    const sigInt = Math.floor(sig);
    const sigDec = Math.round((sig - sigInt) * 10);
    $("#data-signal").textContent = sigInt;
    $("#data-signal-decimal").textContent = "." + sigDec;
    const high = $("#data-signal-highest");
    const prev = parseFloat(high.textContent) || 0;
    if (sig > prev) high.textContent = sig.toFixed(1);

    snrHistory.push(sig);
    if (snrHistory.length > 240) snrHistory.shift();
    drawSNR();

    if (ac) {
      const keep = new Set();
      neighbors(currentFreq).forEach((s) => { keep.add(s.mount); ensureStation(s.mount); });
      pruneStations(keep);
      applyAudioModel(station, offset, sig);
    }

    // ---- Stereo indicator ----
    const pilotDetected = !!(lockedStation && performance.now() >= stereoPilotMs);
    const isStereoUi = !!(onFreq && station && station.stereo && !forcedMono
                          && hasRDS(station) && pilotDetected
                          && lockedStation === station
                          && performance.now() > stereoErraticOff);
    $$(".data-st.circle1").forEach((el) => { el.style.display = "block"; el.style.left = isStereoUi ? "0px" : "4px"; });
    $$(".data-st.circle2").forEach((el) => (el.style.display = isStereoUi ? "block" : "none"));

    // ---- RDS lock state machine ----
    if (!onFreq || !hasRDS(station)) {
      if (lockedStation) {
        lockedStation = null;
        rdsBasicShown = false; rdsTxShown = false; piShown = false;
        psFilled = [false,false,false,false]; psBuf = "        ";
        psFirstCycleDone = false; psChunks = []; psChunkIdx = 0; psChunkHoldTicks = 0;
        rtTargetRaw = ""; rtBuf = ""; rtPrevious = ""; rtSegFilled = []; rtFirstLoad = true;
        afShownCount = 0; groupTick = 0;
        clearRDS(); clearTX();
      }
      return;
    }
    if (lockedStation !== station) {
      lockedStation = station;
      lockedAtMs = performance.now();
      stereoPilotMs = lockedAtMs + 400;
      stereoErraticOff = 0;
      rdsBasicShown = false; rdsTxShown = false; piShown = false;
      psFilled = [false,false,false,false]; psBuf = "        ";
      rtTargetRaw = ""; rtBuf = ""; rtPrevious = ""; rtSegFilled = []; rtFirstLoad = true;
      afShownCount = 0; groupTick = 0;
      clearRDS(); clearTX();
      initPSForLock(station);
      // PI arrives ~100ms after lock
      const lockSnap = station;
      setTimeout(() => {
        if (lockedStation === lockSnap) {
          $("#data-pi").textContent = (lockSnap.pi || "----").toUpperCase();
          piShown = true;
        }
      }, PI_DELAY_MS);
    }
  }

  // ---------- tuning ----------
  function tuneTo(f) {
    currentFreq = clamp(Math.round(f * 1000) / 1000, CFG.tuningMin, CFG.tuningMax);
    $("#data-signal-highest").textContent = "0.0";
    paint();
  }

  // ---------- icecast polling ----------
  async function pollIcecast() {
    try {
      const r = await fetch("/api/icecast");
      const j = await r.json();
      const next = {};
      const src = j?.icestats?.source;
      const arr = Array.isArray(src) ? src : src ? [src] : [];
      arr.forEach((s) => {
        const url = s.listenurl || "";
        const mount = url.split("/").pop();
        if (mount) next[mount] = s;
      });
      icecast = next;
    } catch (e) {}
  }

  // ---------- init ----------
  (async () => {
    CFG = await loadConfig();
    if (!CFG) return;
    audioDelayS = (typeof CFG.audioDelayMs === "number" ? CFG.audioDelayMs : 800) / 1000;
    currentFreq = CFG.defaultFrequency;

    document.title = `${CFG.tunerName} - FM-DX Webserver`;
    const titleSpan = $("#tuner-name .text-200-px");
    if (titleSpan) titleSpan.textContent = CFG.tunerName;
    const descEl = $(".tuner-desc");
    if (descEl) descEl.textContent = CFG.tunerDescription;
    $$(".text-small.color-4").forEach((el, i) => { if (i === 0) el.textContent = CFG.tunerDevice; });
    $$(".tooltip[data-tooltip*='@']").forEach((el) => {
      el.textContent = CFG.ownerContact;
      el.setAttribute("data-tooltip", CFG.ownerContact);
    });
    (CFG.presets || []).slice(0, 4).forEach((f, i) => {
      const el = $(`#preset${i + 1}-text`); if (el) el.textContent = fmt3(f);
      const btn = $(`#preset${i + 1}`); if (btn) btn.addEventListener("click", () => tuneTo(f));
    });

    $("#freq-up")?.addEventListener("click", () => tuneTo(currentFreq + CFG.tuningStep));
    $("#freq-down")?.addEventListener("click", () => tuneTo(currentFreq - CFG.tuningStep));
    const ci2 = $("#commandinput");
    if (ci2) ci2.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      let v = parseFloat(ci2.value.replace(",", "."));
      if (isNaN(v)) return;
      if (v > 10000) v = v / 1000;
      else if (v > 1000) v = v / 100;
      else if (v > 200) v = v / 10;
      tuneTo(v); ci2.blur();
    });
    const playBtn = $(".playbutton");
    const setPlayIcon = () => {
      const icon = playBtn?.querySelector("i");
      if (icon) icon.className = playing ? "fa-solid fa-stop fa-lg" : "fa-solid fa-play fa-lg";
    };
    if (playBtn) playBtn.addEventListener("click", async () => {
      ensureAudio();
      try { if (ac.state === "suspended") await ac.resume(); } catch (e) {}
      playing = !playing;
      muted = !playing;
      setPlayIcon();
      // Seed neighbor pool within the user gesture and explicitly play/pause.
      neighbors(currentFreq).forEach((s) => ensureStation(s.mount));
      if (playing) {
        for (const [, n] of pool) {
          try {
            const p = n.audio.play();
            if (p && p.catch) p.catch(() => {});
          } catch (e) {}
        }
      } else {
        for (const [, n] of pool) {
          try { n.audio.pause(); } catch (e) {}
        }
      }
    });
    const vol = $("#volumeSlider");
    if (vol) vol.addEventListener("input", () => { if (masterGain) masterGain.gain.value = parseFloat(vol.value); });
    document.addEventListener("click", (e) => {
      const t = e.target.closest(".stereo-container");
      if (!t) return;
      forcedMono = !forcedMono;
      paint();
    });

    pollIcecast(); setInterval(pollIcecast, 8000);
    tuneTo(CFG.defaultFrequency);
    setInterval(paint, 250);
    setInterval(rdsGroup, GROUP_MS);
    setInterval(psSchedulerTick, 80);
  })();
})();
