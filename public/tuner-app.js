/* Fake Tuner controller — receivers.json driven, RDS groups, multi-stream pool. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt3 = (f) => Number(f).toFixed(3);

  const PTY = [
    "No PTY","News","Current Affairs","Information","Sport","Education","Drama","Culture",
    "Science","Varied","Pop Music","Rock Music","Easy Listening","Light Classical","Serious Classical","Other Music",
    "Weather","Finance","Children","Social Affairs","Religion","Phone In","Travel","Leisure",
    "Jazz","Country","National","Oldies","Folk","Documentary","Alarm Test","Alarm"
  ];

  const RDS_LOCK_BW = 0.05;
  const GROUP_MS = 600;
  const NEIGHBOR_COUNT = 2;

  let CFG = null;
  let currentFreq = 0;
  let icecast = {};
  let muted = false;
  let forcedMono = false;
  let psRotIndex = 0;
  let snrHistory = [];

  // RDS state
  let lockedStation = null;
  let lockedAtMs = 0;
  let groupTick = 0;
  let piShown = false;
  let stereoPilotMs = 0; // timestamp when stereo can be reported (after 400ms)
  let psFilled = [false,false,false,false]; // 4 pairs of 2 chars
  let psBuf = "        ";
  let rtTargetRaw = "";
  let rtSegFilled = [];      // booleans, 16 segments of 4 chars
  let rtBuf = "";
  let rtPrevious = "";
  let rtFirstLoad = true;
  let afShownCount = 0;
  let rdsBasicShown = false;
  let rdsTxShown = false;

  // Audio
  let ac = null, masterGain = null, noiseGain = null;
  const pool = new Map(); // mount -> { audio, source, hp, lp, ws, splitter, merger, monoGain, stereoL, stereoR, gain }
  const AUDIO_DELAY_S = 0.35;

  // ---------- helpers ----------
  function resolveTokens(tpl, src) {
    if (!tpl) return "";
    let t = tpl;
    const md = (src && src.title) || "";
    const sv = (src && src.server_name) || "";
    const caps = /\(ALLCAPS\)/.test(t);
    t = t.replace(/\(ALLCAPS\)/g, "").replace(/%ICEMD%/g, md).replace(/%SERVER%/g, sv);
    if (caps) t = t.toUpperCase();
    return t.trim();
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
    const code = String(flag).toLowerCase();
    return `<i class="flag-sm flag-sm-${code}"></i>`;
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
    const bw = CFG.audibleBandwidth;
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
    // noise generator — pink-ish noise band-limited 30 Hz – 15 kHz to mimic
    // real FM static (balanced, not treble-heavy).
    const bs = 2 * ac.sampleRate;
    const nb = ac.createBuffer(1, bs, ac.sampleRate);
    const d = nb.getChannelData(0);
    // Voss-McCartney pink noise
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
    let audio, source;
    try {
      audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      audio.loop = false;
      audio.src = `/api/stream/${mount}`;
      audio.play().catch(() => {});
      source = ac.createMediaElementSource(audio);
    } catch (e) { return null; }
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 15000;
    const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 30;
    const ws = ac.createWaveShaper(); ws.curve = makeCurve(0);
    const gain = ac.createGain(); gain.gain.value = 0;
    // Mono-collapse chain: splitter -> merger (both channels = (L+R)/2 via gains).
    const splitter = ac.createChannelSplitter(2);
    const merger = ac.createChannelMerger(2);
    const monoL = ac.createGain(); monoL.gain.value = 0.5;
    const monoR = ac.createGain(); monoR.gain.value = 0.5;
    splitter.connect(monoL, 0); splitter.connect(monoR, 1);
    monoL.connect(merger, 0, 0); monoR.connect(merger, 0, 0);
    monoL.connect(merger, 0, 1); monoR.connect(merger, 0, 1);
    // Stereo passthrough gain
    const stereoGain = ac.createGain(); stereoGain.gain.value = 1;
    const monoGain = ac.createGain(); monoGain.gain.value = 0;
    // Audio delay to simulate stream buffering latency
    const delay = ac.createDelay(2.0); delay.delayTime.value = AUDIO_DELAY_S;
    source.connect(hp).connect(lp).connect(ws);
    ws.connect(stereoGain);     // stereo path (passthrough)
    ws.connect(splitter);        // mono path
    merger.connect(monoGain);
    stereoGain.connect(delay);
    monoGain.connect(delay);
    delay.connect(gain).connect(masterGain);
    const node = { audio, source, hp, lp, ws, gain, stereoGain, monoGain, delay };
    pool.set(mount, node);
    return node;
  }
  function pruneStations(keep) {
    for (const [m, n] of pool) {
      if (keep.has(m)) continue;
      try { n.audio.pause(); n.audio.removeAttribute("src"); n.audio.load(); } catch(e){}
      try { n.source.disconnect(); n.hp?.disconnect(); n.lp.disconnect(); n.ws.disconnect(); n.gain.disconnect(); n.stereoGain?.disconnect(); n.monoGain?.disconnect(); n.delay?.disconnect(); } catch(e){}
      pool.delete(m);
    }
  }
  function applyAudioModel(currentStation, offset, sig) {
    if (!ac) return;
    const bw = CFG.audibleBandwidth;
    const inside = currentStation && Math.abs(offset) <= bw;
    const quality = clamp((sig - CFG.noiseFloorDbf) / 50, 0, 1);
    const offR = currentStation ? clamp(Math.abs(offset) / bw, 0, 1) : 1;
    const now = performance.now();
    const pilotLocked = !!(lockedStation && now >= stereoPilotMs);
    const stereoActive = !!(inside && currentStation && currentStation.stereo && !forcedMono && pilotLocked && currentStation === lockedStation);
    for (const [mount, n] of pool) {
      const isCurrent = inside && mount === currentStation.mount;
      if (isCurrent) {
        n.ws.curve = makeCurve(offR * 60);
        n.lp.frequency.value = clamp(15000 - offR * 11000 - (1 - quality) * 6000, 1500, 15000);
        n.gain.gain.value = muted ? 0 : (1 - offR * 0.6) * (0.4 + quality * 0.6);
        if (n.stereoGain && n.monoGain) {
          n.stereoGain.gain.value = stereoActive ? 1 : 0;
          n.monoGain.gain.value = stereoActive ? 0 : 1;
        }
      } else {
        n.gain.gain.value = 0;
      }
    }
    noiseGain.gain.value = muted ? 0 : clamp((1 - quality) * 0.35 + offR * 0.3, 0, 0.6);
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
    ["#data-station-name","#data-station-city","#data-station-itu","#data-station-erp","#data-station-pol","#data-station-distance","#data-station-azimuth"]
      .forEach((id) => { const e = $(id); if (e) e.textContent = ""; });
  }
  function showBasicRDS(st) {
    $("#data-pi").textContent = (st.pi || "----").toUpperCase();
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
  function paintPS() {
    const el = $("#data-ps"); if (!el) return;
    el.textContent = psBuf;
  }
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
    const s = st.station || {};
    const setT = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    setT("#data-station-name", s.name || "");
    setT("#data-station-city", s.city || "");
    setT("#data-station-itu", s.itu || "");
    setT("#data-station-erp", s.erp ?? "");
    setT("#data-station-pol", s.pol || "");
    setT("#data-station-distance", (s.distance ?? "") + " km");
    setT("#data-station-azimuth", (s.azimuth ?? "") + "°");
  }

  // ---------- RDS group tick ----------
  // Simulates real RDS arriving in groups: PI/PTY/MS instantly with first group,
  // PS fills 2 chars per group across 4 groups (~350ms),
  // RT fills 4 chars per group across up to 16 groups (~1.4s),
  // AF reveals 1 freq every 2 groups, TX info after ~4s.
  function rdsGroup() {
    if (!lockedStation) return;
    const st = lockedStation;
    const src = icecast[st.mount];
    groupTick++;

    if (!rdsBasicShown) {
      rdsBasicShown = true;
      showBasicRDS(st);
    }

    // PS fill (4 pairs)
    if (!psFilled.every(Boolean)) {
      const psRaw = resolveTokens(st.ps, src) || (st.station?.name || "");
      const fullPS = pad8(psRaw.length > 8 ? psRaw.slice(0, 8) : psRaw);
      // pick a not-yet-filled pair index in groups arrival order
      for (let i = 0; i < 4; i++) {
        if (!psFilled[i]) {
          psFilled[i] = true;
          const chars = fullPS.slice(i*2, i*2+2);
          psBuf = psBuf.slice(0, i*2) + chars + psBuf.slice(i*2+2);
          paintPS();
          break;
        }
      }
    }

    // AF reveal
    const afTotal = (st.af || []).length;
    if (afShownCount < afTotal && groupTick % 2 === 0) {
      afShownCount++;
      paintAF(st);
    }

    // RT fill
    const newTarget = cap64(resolveTokens(st.rt, src));
    if (newTarget && newTarget !== rtTargetRaw) {
      // new RT message arrived (e.g. song change)
      if (rtBuf) rtPrevious = rtBuf;
      if (rtTargetRaw) rtFirstLoad = false;
      rtTargetRaw = newTarget;
      const segCount = Math.ceil(rtTargetRaw.length / 8);
      rtSegFilled = new Array(segCount).fill(false);
      rtBuf = "";
      paintRT();
    }
    if (rtTargetRaw && rtSegFilled.some((v) => !v)) {
      for (let i = 0; i < rtSegFilled.length; i++) {
        if (!rtSegFilled[i]) {
          rtSegFilled[i] = true;
          const chars = rtTargetRaw.slice(i*8, i*8+8);
          // pad rtBuf to needed length
          while (rtBuf.length < i*8) rtBuf += " ";
          rtBuf = rtBuf.slice(0, i*8) + chars + rtBuf.slice(i*8 + chars.length);
          paintRT();
          break;
        }
      }
      if (rtSegFilled.every(Boolean)) rtFirstLoad = false;
    }

    // TX info after ~4s of lock
    if (!rdsTxShown && performance.now() - lockedAtMs > 4500) {
      rdsTxShown = true;
      showTX(st);
    }
  }

  // PS rotation for long names (after initial fill)
  function tickPSRotation() {
    if (!lockedStation || !psFilled.every(Boolean)) return;
    const src = icecast[lockedStation.mount];
    const raw = resolveTokens(lockedStation.ps, src) || (lockedStation.station?.name || "");
    if (raw.length <= 8) return;
    const chunks = [];
    for (let i = 0; i < raw.length; i += 8) chunks.push(pad8(raw.slice(i, i + 8)));
    psRotIndex = (psRotIndex + 1) % chunks.length;
    psBuf = chunks[psRotIndex];
    paintPS();
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
    const audible = station && Math.abs(offset) <= CFG.audibleBandwidth;
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

    // ensure neighbor pool
    if (ac) {
      const keep = new Set();
      neighbors(currentFreq).forEach((s) => { keep.add(s.mount); ensureStation(s.mount); });
      pruneStations(keep);
      applyAudioModel(station, offset, sig);
    }

    // stereo indicator
    const pilotLocked = !!(lockedStation && performance.now() >= stereoPilotMs);
    const isStereo = !!(onFreq && station && station.stereo && !forcedMono && hasRDS(station) && pilotLocked && lockedStation === station);
    // circle1 always visible (mono icon); shift it 4px right when mono.
    $$(".data-st.circle1").forEach((el) => { el.style.display = "block"; el.style.left = isStereo ? "0px" : "4px"; });
    // circle2 only visible when stereo (creates the two-intersecting-circles look).
    $$(".data-st.circle2").forEach((el) => (el.style.display = isStereo ? "block" : "none"));

    // RDS lock state machine
    if (!onFreq || !hasRDS(station)) {
      if (lockedStation) {
        lockedStation = null;
        rdsBasicShown = false; rdsTxShown = false; piShown = false;
        psFilled = [false,false,false,false]; psBuf = "        ";
        rtTargetRaw = ""; rtBuf = ""; rtPrevious = ""; rtSegFilled = []; rtFirstLoad = true;
        afShownCount = 0; psRotIndex = 0; groupTick = 0;
        clearRDS(); clearTX();
      }
      return;
    }
    if (lockedStation !== station) {
      lockedStation = station;
      lockedAtMs = performance.now();
      stereoPilotMs = lockedAtMs + 400; // pilot detection delay
      rdsBasicShown = false; rdsTxShown = false; piShown = false;
      psFilled = [false,false,false,false]; psBuf = "        ";
      rtTargetRaw = ""; rtBuf = ""; rtPrevious = ""; rtSegFilled = []; rtFirstLoad = true;
      afShownCount = 0; psRotIndex = 0; groupTick = 0;
      clearRDS(); clearTX();
      // Show PI nearly instantly (within one paint tick) — real tuners decode
      // the PI block before any other RDS data.
      $("#data-pi").textContent = (station.pi || "----").toUpperCase();
      piShown = true;
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
    const ci = $("#commandinput");
    if (ci) ci.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      let v = parseFloat(ci.value.replace(",", "."));
      if (isNaN(v)) return;
      if (v > 10000) v = v / 1000;
      else if (v > 1000) v = v / 100;
      else if (v > 200) v = v / 10;
      tuneTo(v); ci.blur();
    });
    const playBtn = $(".playbutton");
    if (playBtn) playBtn.addEventListener("click", () => {
      ensureAudio();
      if (ac.state === "suspended") ac.resume();
      muted = !muted;
      const icon = playBtn.querySelector("i");
      if (icon) icon.className = muted ? "fa-solid fa-play fa-lg" : "fa-solid fa-stop fa-lg";
      // Seed neighbor pool and explicitly play each audio element within
      // the user gesture so browsers reliably allow playback.
      neighbors(currentFreq).forEach((s) => ensureStation(s.mount));
      for (const [, n] of pool) {
        try { const p = n.audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
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
    setInterval(tickPSRotation, 1200);
  })();
})();
