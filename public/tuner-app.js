/* Fake Tuner controller - drives the UI from config + Icecast metadata. */
(() => {
  const CFG = window.TUNER_CONFIG;
  if (!CFG) { console.error("Missing TUNER_CONFIG"); return; }

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

  let currentFreq = CFG.defaultFrequency;
  let icecast = {};
  let muted = false;
  let psIndex = 0;
  let snrHistory = [];

  // ---- static config -> DOM ----
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
    const el = $(`#preset${i + 1}-text`);
    if (el) el.textContent = fmt3(f);
    const btn = $(`#preset${i + 1}`);
    if (btn) btn.addEventListener("click", () => tuneTo(f));
  });

  // ---- icecast polling ----
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
  pollIcecast();
  setInterval(pollIcecast, 8000);

  // ---- station / signal model ----
  function stationForFreq(freq) {
    let best = null, bestDist = Infinity;
    CFG.stations.forEach((st) => {
      const d = Math.abs(st.freq - freq);
      if (d < bestDist) { bestDist = d; best = st; }
    });
    return { station: best, offset: best ? freq - best.freq : 0 };
  }
  function signalDbf(st, off) {
    if (!st) return CFG.noiseFloorDbf;
    const bw = CFG.audibleBandwidth;
    const k = Math.exp(-Math.pow(off / (bw / 2), 2) * 2);
    return CFG.noiseFloorDbf + (st.signal - CFG.noiseFloorDbf) * k;
  }

  // ---- audio (WebAudio: stream -> filters -> distortion -> out, + noise) ----
  let audio, ac, srcNode, gainNode, biquadLow, biquadHigh, distortion, noiseGain, currentMount = null;
  function makeCurve(amount) {
    const n = 1024, c = new Float32Array(n), deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return c;
  }
  function ensureAudio() {
    if (audio) return;
    audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "none";
    ac = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = ac.createMediaElementSource(audio);
    biquadHigh = ac.createBiquadFilter(); biquadHigh.type = "highpass"; biquadHigh.frequency.value = 30;
    biquadLow = ac.createBiquadFilter(); biquadLow.type = "lowpass"; biquadLow.frequency.value = 15000;
    distortion = ac.createWaveShaper(); distortion.curve = makeCurve(0);
    gainNode = ac.createGain();
    srcNode.connect(biquadHigh).connect(biquadLow).connect(distortion).connect(gainNode).connect(ac.destination);
    // static noise
    const bs = 2 * ac.sampleRate;
    const nb = ac.createBuffer(1, bs, ac.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < bs; i++) d[i] = Math.random() * 2 - 1;
    const nNode = ac.createBufferSource(); nNode.buffer = nb; nNode.loop = true;
    const nHP = ac.createBiquadFilter(); nHP.type = "highpass"; nHP.frequency.value = 800;
    noiseGain = ac.createGain(); noiseGain.gain.value = 0;
    nNode.connect(nHP).connect(noiseGain).connect(ac.destination);
    nNode.start();
  }
  function setStream(mount) {
    ensureAudio();
    if (currentMount === mount) return;
    currentMount = mount;
    if (!mount) { audio.pause(); return; }
    audio.src = `/api/stream/${mount}`;
    audio.play().catch(() => {});
  }
  function applyAudioModel(sig, off, hasSt) {
    if (!audio) return;
    const bw = CFG.audibleBandwidth;
    const inside = hasSt && Math.abs(off) <= bw;
    const quality = clamp((sig - CFG.noiseFloorDbf) / 50, 0, 1);
    const offR = clamp(Math.abs(off) / bw, 0, 1);
    distortion.curve = makeCurve(offR * 60);
    biquadLow.frequency.value = inside ? clamp(15000 - offR * 11000 - (1 - quality) * 6000, 1500, 15000) : 600;
    gainNode.gain.value = muted ? 0 : (inside ? (1 - offR * 0.6) * (0.4 + quality * 0.6) : 0);
    noiseGain.gain.value = muted ? 0 : clamp((1 - quality) * 0.35 + offR * 0.3, 0, 0.6);
  }

  // ---- PS / RT ----
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

  function tickPS(st, src) {
    const el = $("#data-ps");
    if (!el) return;
    if (!st) { el.textContent = "        "; return; }
    const raw = resolveTokens(st.ps, src) || pad8(st.station?.name || "");
    if (raw.length <= 8) { el.textContent = pad8(raw); return; }
    const chunks = [];
    for (let i = 0; i < raw.length; i += 8) chunks.push(pad8(raw.slice(i, i + 8)));
    psIndex = (psIndex + 1) % chunks.length;
    el.textContent = chunks[psIndex];
  }
  function tickRT(st, src) {
    const r0 = $("#data-rt0 span"), r1 = $("#data-rt1 span");
    if (!r0) return;
    if (!st) { r0.textContent = ""; if (r1) r1.textContent = ""; return; }
    const raw = cap64(resolveTokens(st.rt, src));
    r0.textContent = raw.slice(0, 32);
    if (r1) r1.textContent = raw.slice(32, 64);
  }

  // ---- SNR canvas ----
  function drawSNR() {
    const c = $("#signal-canvas");
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let y = 0.25; y < 1; y += 0.25) {
      ctx.beginPath(); ctx.moveTo(0, h * y); ctx.lineTo(w, h * y); ctx.stroke();
    }
    const cssColor = getComputedStyle(document.documentElement).getPropertyValue("--color-main-bright").trim();
    ctx.strokeStyle = cssColor || "#68f7ee";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const max = 80, n = snrHistory.length;
    snrHistory.forEach((v, i) => {
      const x = (i / Math.max(1, n - 1)) * w;
      const y = h - clamp(v / max, 0, 1) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  // ---- main tick ----
  function paintNow() {
    const { station, offset } = stationForFreq(currentFreq);
    const inRange = station && Math.abs(offset) <= CFG.audibleBandwidth;
    const sig = signalDbf(station, offset);

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

    const src = inRange && station ? icecast[station.mount] : null;
    if (inRange && station) {
      $("#data-pi").textContent = station.pi || "----";
      $$(".data-pty").forEach((e) => (e.textContent = PTY[station.pty] || ""));
      $$(".data-tp span").forEach((e) => (e.className = station.tp ? "opacity-full" : "opacity-half"));
      $$(".data-ta span").forEach((e) => (e.className = station.ta ? "opacity-full" : "opacity-half"));
      $$(".data-ms").forEach((el) => {
        const ms = (station.ms || "M").toUpperCase();
        el.innerHTML =
          `<span class="${ms === 'M' ? 'opacity-full' : 'opacity-half'}">M</span>` +
          `<span class="${ms === 'S' ? 'opacity-full' : 'opacity-half'}">S</span>`;
      });
      $$(".data-st").forEach((el) => (el.style.display = station.stereo ? "block" : "none"));
      const afList = $("#af-list ul");
      if (afList) afList.innerHTML = (station.af || []).map((f) => `<li><a>${fmt3(f)}</a></li>`).join("") || "<li><a>—</a></li>";
      const s = station.station || {};
      const setT = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      setT("#data-station-name", s.name || "");
      setT("#data-station-city", s.city || "");
      setT("#data-station-itu", s.itu || "");
      setT("#data-station-erp", s.erp ?? "");
      setT("#data-station-pol", s.pol || "");
      setT("#data-station-distance", (s.distance ?? "") + " km");
      setT("#data-station-azimuth", (s.azimuth ?? "") + "°");
      setStream(station.mount);
    } else {
      $("#data-pi").textContent = "----";
      $$(".data-pty").forEach((e) => (e.textContent = ""));
      const afList = $("#af-list ul");
      if (afList) afList.innerHTML = "";
      setStream(null);
    }
    applyAudioModel(sig, offset, !!(inRange && station));
  }

  function rdsTick() {
    const { station, offset } = stationForFreq(currentFreq);
    const inRange = station && Math.abs(offset) <= CFG.audibleBandwidth;
    if (!inRange) { const el = $("#data-ps"); if (el) el.textContent = "        "; return; }
    tickPS(station, icecast[station.mount]);
  }
  function rtTick() {
    const { station, offset } = stationForFreq(currentFreq);
    const inRange = station && Math.abs(offset) <= CFG.audibleBandwidth;
    if (!inRange) return;
    tickRT(station, icecast[station.mount]);
  }

  // ---- tuning ----
  function tuneTo(f) {
    currentFreq = clamp(Math.round(f * 1000) / 1000, CFG.tuningMin, CFG.tuningMax);
    psIndex = 0;
    $("#data-signal-highest").textContent = "0.0";
    paintNow(); rdsTick(); rtTick();
  }
  $("#freq-up")?.addEventListener("click", () => tuneTo(currentFreq + CFG.tuningStep));
  $("#freq-down")?.addEventListener("click", () => tuneTo(currentFreq - CFG.tuningStep));
  const ci = $("#commandinput");
  if (ci) {
    ci.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      let v = parseFloat(ci.value.replace(",", "."));
      if (isNaN(v)) return;
      if (v > 10000) v = v / 1000;
      else if (v > 1000) v = v / 100;
      else if (v > 200) v = v / 10;
      tuneTo(v);
      ci.blur();
    });
  }
  const playBtn = $(".playbutton");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      ensureAudio();
      if (ac.state === "suspended") ac.resume();
      muted = !muted;
      const icon = playBtn.querySelector("i");
      if (icon) icon.className = muted ? "fa-solid fa-play fa-lg" : "fa-solid fa-stop fa-lg";
      paintNow();
    });
  }
  const vol = $("#volumeSlider");
  if (vol) vol.addEventListener("input", () => { if (gainNode) gainNode.gain.value = muted ? 0 : parseFloat(vol.value); });

  tuneTo(CFG.defaultFrequency);
  setInterval(paintNow, 1000);
  setInterval(rdsTick, 1200);
  setInterval(rtTick, 7000);
})();
