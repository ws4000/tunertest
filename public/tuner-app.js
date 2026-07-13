/* Fake Tuner controller — receivers.json driven, RDS groups, multi-stream pool. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt3 = (f) => Number(f).toFixed(3);
  // AF frequencies mirror real-tuner displays: keep at least one decimal
  // ("96.0"), never pad past the last significant digit ("95.8", "72.14").
  const fmtAF = (f) => {
    const n = Number(f);
    if (!isFinite(n)) return "";
    let s = n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    if (!s.includes(".")) s += ".0";
    return s;
  };
  const DEFAULT_LOGO = "https://tef.noobish.eu/logos/default-logo.png";
  // PI placeholder shown when no station is locked (dimmed "?").
  const PI_EMPTY_HTML = '<span style="opacity:0.8">?</span>';

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
  // Per-mount live metadata for non-Icecast streams (populated by /api/stream-meta polls).
  const streamMeta = {};
  function metaFor(st) {
    if (!st || !st.mount) return null;
    const a = icecast[st.mount];
    const b = streamMeta[st.mount];
    if (a && b) return { ...b, ...a };
    return a || b || null;
  }
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
  let psFillTarget = "        ";   // current 8-char target being filled 2-at-a-time
  let psScrollOffset = 0;
  let psScrollDir = 1;
  let psScrollNextMs = 0;
  let psMode = "groups";
  // Background PS state per station mount so dynamic PS keeps advancing
  // even when you're not tuned in (so tuning in lands mid-cycle).
  const bgPS = new Map();
  let bgPSInitDone = false;

  let rtTargetRaw = "";
  let rtSegFilled = [];
  let rtBuf = "";
  let rtPrevious = "";
  let rtFirstLoad = true;
  let afShownCount = 0;
  let rdsBasicShown = false;
  let rdsTxShown = false;
  let preloadAllUntilMs = 0;

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
  // Characters with no NFKD decomposition that still have an obvious
  // single-byte RDS replacement (Ø, Ł, Þ, Æ, Œ, ß, Cyrillic, Greek, …).
  const RDS_CHAR_MAP = {
    "Ø":"O","ø":"o","Đ":"D","đ":"d","Ð":"D","ð":"d","Þ":"Th","þ":"th",
    "ß":"ss","ẞ":"SS","Æ":"AE","æ":"ae","Œ":"OE","œ":"oe","Ł":"L","ł":"l",
    "Ħ":"H","ħ":"h","ı":"i","İ":"I","Ŋ":"Ng","ŋ":"ng","ſ":"s",
    "Ə":"E","ə":"e","Ɛ":"E","ɛ":"e","Ɔ":"O","ɔ":"o","Ɵ":"O","ɵ":"o",
    "Ǝ":"E","ǝ":"e","Ʌ":"V","ʌ":"v","Ɣ":"G","ɣ":"g","Ƿ":"W","ƿ":"w",
    "Ʒ":"Zh","ʒ":"zh","Ƨ":"S","ƨ":"s","Ɂ":"'","ɂ":"'",
    // Punctuation / symbols
    "\u2018":"'","\u2019":"'","\u201A":",","\u201B":"'",
    "\u201C":'"',"\u201D":'"',"\u201E":'"',"\u201F":'"',"\u2032":"'","\u2033":'"',
    "\u2013":"-","\u2014":"-","\u2015":"-","\u2212":"-","\u2026":"...",
    "\u2022":"*","\u00B7":".","\u00A0":" ","\u202F":" ","\u2009":" ","\u200B":"",
    "\u00AB":'"',"\u00BB":'"',"\u2039":"'","\u203A":"'",
    "\u00A9":"(c)","\u00AE":"(r)","\u2122":"(tm)","\u00B0":"deg",
    "\u20AC":"EUR","\u00A3":"GBP","\u00A5":"YEN","\u00A2":"c","\u00A4":"$",
    "\u2190":"<-","\u2192":"->","\u2191":"^","\u2193":"v","\u2194":"<>",
    "\u00D7":"x","\u00F7":"/","\u00B1":"+-","\u00BC":"1/4","\u00BD":"1/2","\u00BE":"3/4",
    // Cyrillic (BGN/PCGN-ish)
    "А":"A","Б":"B","В":"V","Г":"G","Д":"D","Е":"E","Ё":"Yo","Ж":"Zh","З":"Z",
    "И":"I","Й":"Y","К":"K","Л":"L","М":"M","Н":"N","О":"O","П":"P","Р":"R",
    "С":"S","Т":"T","У":"U","Ф":"F","Х":"Kh","Ц":"Ts","Ч":"Ch","Ш":"Sh",
    "Щ":"Shch","Ъ":"","Ы":"Y","Ь":"","Э":"E","Ю":"Yu","Я":"Ya",
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh","з":"z",
    "и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r",
    "с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh",
    "щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya",
    "І":"I","і":"i","Ї":"Yi","ї":"yi","Є":"Ye","є":"ye","Ґ":"G","ґ":"g",
    "Ў":"U","ў":"u","Џ":"Dzh","џ":"dzh","Љ":"Lj","љ":"lj","Њ":"Nj","њ":"nj",
    "Ћ":"C","ћ":"c","Ђ":"Dj","ђ":"dj","Ј":"J","ј":"j","Ѕ":"Dz","ѕ":"dz",
    // Greek
    "Α":"A","Β":"B","Γ":"G","Δ":"D","Ε":"E","Ζ":"Z","Η":"I","Θ":"Th",
    "Ι":"I","Κ":"K","Λ":"L","Μ":"M","Ν":"N","Ξ":"X","Ο":"O","Π":"P","Ρ":"R",
    "Σ":"S","Τ":"T","Υ":"Y","Φ":"F","Χ":"Ch","Ψ":"Ps","Ω":"O",
    "α":"a","β":"b","γ":"g","δ":"d","ε":"e","ζ":"z","η":"i","θ":"th",
    "ι":"i","κ":"k","λ":"l","μ":"m","ν":"n","ξ":"x","ο":"o","π":"p","ρ":"r",
    "σ":"s","ς":"s","τ":"t","υ":"y","φ":"f","χ":"ch","ψ":"ps","ω":"o",
  };
  // Hiragana → romaji (katakana converted to hiragana first via offset)
  const KANA_MAP = {
    "あ":"a","い":"i","う":"u","え":"e","お":"o",
    "か":"ka","き":"ki","く":"ku","け":"ke","こ":"ko",
    "さ":"sa","し":"shi","す":"su","せ":"se","そ":"so",
    "た":"ta","ち":"chi","つ":"tsu","て":"te","と":"to",
    "な":"na","に":"ni","ぬ":"nu","ね":"ne","の":"no",
    "は":"ha","ひ":"hi","ふ":"fu","へ":"he","ほ":"ho",
    "ま":"ma","み":"mi","む":"mu","め":"me","も":"mo",
    "や":"ya","ゆ":"yu","よ":"yo",
    "ら":"ra","り":"ri","る":"ru","れ":"re","ろ":"ro",
    "わ":"wa","ゐ":"wi","ゑ":"we","を":"wo","ん":"n",
    "が":"ga","ぎ":"gi","ぐ":"gu","げ":"ge","ご":"go",
    "ざ":"za","じ":"ji","ず":"zu","ぜ":"ze","ぞ":"zo",
    "だ":"da","ぢ":"ji","づ":"zu","で":"de","ど":"do",
    "ば":"ba","び":"bi","ぶ":"bu","べ":"be","ぼ":"bo",
    "ぱ":"pa","ぴ":"pi","ぷ":"pu","ぺ":"pe","ぽ":"po",
    "ゃ":"ya","ゅ":"yu","ょ":"yo","っ":"","ゎ":"wa",
    "ぁ":"a","ぃ":"i","ぅ":"u","ぇ":"e","ぉ":"o",
    "ー":"-","・":" ",
  };
  const CP1252_BYTE_MAP = {
    "\u20AC":0x80,"\u201A":0x82,"\u0192":0x83,"\u201E":0x84,"\u2026":0x85,
    "\u2020":0x86,"\u2021":0x87,"\u02C6":0x88,"\u2030":0x89,"\u0160":0x8A,
    "\u2039":0x8B,"\u0152":0x8C,"\u017D":0x8E,"\u2018":0x91,"\u2019":0x92,
    "\u201C":0x93,"\u201D":0x94,"\u2022":0x95,"\u2013":0x96,"\u2014":0x97,
    "\u02DC":0x98,"\u2122":0x99,"\u0161":0x9A,"\u203A":0x9B,"\u0153":0x9C,
    "\u017E":0x9E,"\u0178":0x9F,
  };
  const MOJIBAKE_RE = /[ÃÂÐÑ]|[\u2018\u2019\u201A\u201C\u201D\u2020\u2021\u2039\u203A\u0152\u0153]/;
  // Repair UTF-8 bytes that were mis-decoded as Windows-1252/Latin-1
  // (a very common Icecast metadata bug). "Быть" arrives as the 8 bytes
  // D0 91 D1 8B D1 82 D1 8C re-interpreted as Latin-1 codepoints, i.e.
  // "Ð\u0091Ñ\u008BÑ\u0082Ñ\u008C". Re-encode as Latin-1 bytes, then
  // decode as UTF-8 — if it round-trips cleanly we keep the repaired
  // string, otherwise we fall back to the original.
  function repairMojibake(s) {
    if (!s || typeof s !== "string") return s;
    if (!MOJIBAKE_RE.test(s) && !/[\u00C0-\u00FF]/.test(s)) return s;
    try {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const c = s.charCodeAt(i);
        if (c <= 0xFF) {
          bytes[i] = c;
          continue;
        }
        const cp1252 = CP1252_BYTE_MAP[ch];
        if (cp1252 == null) return s;
        bytes[i] = cp1252;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return MOJIBAKE_RE.test(decoded) ? s : decoded;
    } catch (e) {
      return s;
    }
  }
  function toRdsAscii(s) {
    if (!s) return s;
    s = repairMojibake(s);
    // Decompose accents (é → e + combining acute), then drop combining marks
    let norm;
    try { norm = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); }
    catch (e) { norm = s; }
    let out = "";
    for (const ch of norm) {
      const code = ch.codePointAt(0);
      const m = RDS_CHAR_MAP[ch];
      if (m != null) { out += m; continue; }
      if (code < 128) { out += ch; continue; }
      // Katakana → hiragana (offset 0x60), then romaji
      if (code >= 0x30A1 && code <= 0x30F6) {
        const hira = String.fromCodePoint(code - 0x60);
        const km = KANA_MAP[hira];
        if (km != null) { out += km; continue; }
      }
      if (code >= 0x3041 && code <= 0x3096) {
        const km = KANA_MAP[ch];
        if (km != null) { out += km; continue; }
      }
      // CJK ideographs and anything else unhandled
      out += "?";
    }
    return out;
  }
  function resolveTokens(tpl, src, opts = {}) {
    if (!tpl) return "";
    const preserveOuterSpacing = !!opts.preserveOuterSpacing;
    const preserveInnerSpacing = !!opts.preserveInnerSpacing;
    let t = tpl;
    const md = (src && src.title) || "";
    const sv = (src && src.server_name) || "";
    const caps = /\(ALLCAPS\)/.test(t);
    t = t.replace(/\(ALLCAPS\)/g, "").replace(/%ICEMD%/g, md).replace(/%SERVER%/g, sv);
    t = t.replace(/%MD%/g, md);
    if (preserveInnerSpacing) {
      // Only collapse newlines/tabs; preserve user-typed runs of spaces
      // (e.g. "  FG.  " for Radio FG's centered PS).
      t = t.replace(/[\r\n\t]+/g, " ");
    } else {
      t = t.replace(/\s+/g, " ");
    }
    if (!preserveOuterSpacing) t = t.trim();
    t = toRdsAscii(t);
    if (caps) t = t.toUpperCase();
    return preserveOuterSpacing ? t : t.trim();
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
    // Sprite object: { sprite: "https://…flags-16.png", x, y, w, h }
    // Renders a fixed-size <span> using background-position, letting a
    // station pick a flag out of any sprite sheet (e.g. flags-16.png).
    if (typeof flag === "object" && flag.sprite) {
      const w = flag.w || 16, h = flag.h || 11;
      const style = [
        "display:inline-block",
        `width:${w}px`, `height:${h}px`,
        `background-image:url('${flag.sprite}')`,
        `background-position:-${flag.x || 0}px -${flag.y || 0}px`,
        "background-repeat:no-repeat",
        "vertical-align:middle",
        "border-radius:2px",
        "box-shadow:0 0 0 1px rgba(0,0,0,0.25)",
      ].join(";");
      return `<span class="sprite-flag" style="${style}"></span>`;
    }
    if (typeof flag !== "string") return "";
    // "sprite:URL|x|y[|w|h]" shorthand string form.
    if (flag.startsWith("sprite:")) {
      const p = flag.slice(7).split("|");
      return renderFlag({ sprite: p[0], x: +p[1]||0, y: +p[2]||0, w: +p[3]||16, h: +p[4]||11 });
    }
    if (/^https?:\/\//i.test(flag) || flag.startsWith("/")) {
      return `<img class="custom-flag" src="${flag}" alt="">`;
    }
    return `<i class="flag-sm flag-sm-${flag.toLowerCase()}"></i>`;
  }
  function resolveFlag(st) {
    if (!st) return "";
    if (st.flag) return st.flag;
    const itu = st.station?.itu;
    if (itu && CFG.customFlags && CFG.customFlags[itu]) return CFG.customFlags[itu];
    return itu || "";
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
  function extendPreloadWindow(ms) {
    preloadAllUntilMs = Math.max(preloadAllUntilMs, performance.now() + ms);
  }
  function shouldPreloadAllStations() {
    return spectrumMode || performance.now() < preloadAllUntilMs;
  }
  function desiredAudioMounts(freq) {
    const keep = new Set();
    if (!CFG) return keep;
    const tuned = stationForFreq(freq).station;
    if (tuned && tuned.mount) keep.add(tuned.mount);
    if (shouldPreloadAllStations()) {
      CFG.stations.forEach((st) => { if (st.mount) keep.add(st.mount); });
      return keep;
    }
    neighbors(freq).forEach((st) => { if (st.mount) keep.add(st.mount); });
    return keep;
  }
  function warmDesiredStations(freq) {
    const keep = desiredAudioMounts(freq);
    keep.forEach((mount) => ensureStation(mount));
    return keep;
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
      audio.autoplay = false;
      audio.loop = false;
      // Safari/WebKit bug: without element-level muting, the raw <audio>
      // element plays in parallel with the WebAudio graph — every stream
      // blasts at full volume and drowns out the pink-noise static.
      // Muting the element leaves WebAudio fully functional (samples still
      // flow through the MediaElementSource).
      audio.muted = true;
      audio.volume = 1;
      // Keep the element attached to the document so the browser does not
      // treat it as garbage / pause it under memory pressure. Hidden, muted
      // at the element level is fine — WebAudio still gets the samples.
      audio.style.display = "none";
      try { document.body.appendChild(audio); } catch (e) {}
      audio.src = /^https?:\/\//i.test(mount)
        ? `/api/stream/${encodeURIComponent(mount)}`
        : `/api/stream/${mount}`;
      try { audio.load(); } catch (e) {}
      // Buffer-recovery. NEVER call audio.load() — that fully resets the
      // MediaElement and creates an audible cut-out. We also never seek
      // (currentTime = …) for the same reason. On any stall/wait we just
      // re-issue play() immediately and let the browser keep its buffer.
      let reconnectingAt = 0;
      let waitingSince = 0;
      const tryPlay = () => {
        if (!playing) return;
        try { const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
      };
      const noteWait = () => {
        if (!waitingSince) waitingSince = Date.now();
        tryPlay();
        setTimeout(() => {
          if (!playing) return;
          if (audio.readyState >= 3) return;
          if (!waitingSince || Date.now() - waitingSince < 2200) return;
          hardReconnect();
        }, 2300);
      };
      const clearWait = () => { waitingSince = 0; };
      const hardReconnect = () => {
        if (!playing) return;
        const now = Date.now();
        // Throttle: at most one hard reconnect every 5s.
        if (now - reconnectingAt < 5000) return;
        reconnectingAt = now;
        try {
          // Force the browser to drop the dead socket and open a new one
          // by re-assigning src (cheaper than .load() + .play()).
          const src = /^https?:\/\//i.test(mount)
            ? `/api/stream/${encodeURIComponent(mount)}?t=${now}`
            : `/api/stream/${mount}?t=${now}`;
          audio.src = src;
          waitingSince = now;
          const p = audio.play(); if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      };
      audio.addEventListener("stalled", noteWait);
      audio.addEventListener("waiting", noteWait);
      audio.addEventListener("suspend", () => {
        if (audio.networkState === HTMLMediaElement.NETWORK_IDLE && audio.readyState < 3) noteWait();
      });
      audio.addEventListener("canplay", clearWait);
      audio.addEventListener("canplaythrough", clearWait);
      audio.addEventListener("playing", clearWait);
      audio.addEventListener("error",   () => setTimeout(hardReconnect, 1500));
      audio.addEventListener("ended",   () => setTimeout(hardReconnect, 250));
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
      try { n.audio.remove(); } catch (e) {}
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
  // Static-noise level (0..1) as a function of raw dBf signal, per spec:
  //   <10-15 dBf : heavy static
  //   15-30 dBf  : weak / fringe (noisier in stereo)
  //   30-50 dBf  : clear in mono, faint hiss in stereo
  //   50+ dBf    : silent
  function noiseAmountFromDbf(dbf, stereoActive) {
    let base;
    if (dbf >= 50)      base = 0;
    else if (dbf >= 30) base = 0.06 * (1 - (dbf - 30) / 20);
    else if (dbf >= 15) base = 0.06 + 0.19 * (1 - (dbf - 15) / 15);
    else if (dbf >= 10) base = 0.25 + 0.15 * (1 - (dbf - 10) / 5);
    else                base = 0.40 + 0.25 * clamp((10 - dbf) / 10, 0, 1);
    if (stereoActive && dbf < 50) {
      base += 0.08 * (1 - clamp((dbf - 15) / 35, 0, 1));
    }
    return clamp(base, 0, 0.75);
  }
  function applyAudioModel(currentStation, offset, sig) {
    if (!ac) return;
    const bw = audibleBwFor(currentStation);
    const inside = currentStation && Math.abs(offset) <= bw;
    const onFreq = currentStation && Math.abs(offset) <= RDS_LOCK_BW;
    // Quality [0..1] mapped using the same dBf thresholds as the noise
    // curve above: 15 dBf → 0 (fringe), 50 dBf → 1 (clean).
    const quality = clamp((sig - 15) / 35, 0, 1);
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
    const stationNoise = noiseAmountFromDbf(sig, stereoActive);
    const target = playing ? clamp(stationNoise + offR * 0.3, 0, 0.85) : 0;
    noiseGain.gain.setTargetAtTime(target, ac.currentTime, 0.05);
  }

  // ---------- RDS render ----------
  function clearRDS() {
    const piEl0 = $("#data-pi");
    if (piEl0) piEl0.innerHTML = PI_EMPTY_HTML;
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
    // No-station / no-signal state: show the default logo so the panel
    // doesn't collapse into an empty box.
    const logo = $("#station-logo");
    if (logo) { logo.src = DEFAULT_LOGO; logo.style.display = "block"; }
    const logoP = $("#station-logo-phone");
    if (logoP) { logoP.src = DEFAULT_LOGO; logoP.style.display = "block"; }
  }
  function clearTX() {
    const c = $("#data-station-container");
    if (c) c.style.display = "none";
    ["#data-station-name","#data-station-city","#data-station-itu","#data-station-erp","#data-station-pol","#data-station-distance","#data-station-azimuth"]
      .forEach((id) => { const e = $(id); if (e) e.textContent = ""; });
  }
  function showBasicRDS(st) {
    const piEl1 = $("#data-pi");
    if (piEl1) {
      if (st.pi && !piIsNull(st.pi)) piEl1.textContent = st.pi.toUpperCase();
      else piEl1.innerHTML = PI_EMPTY_HTML;
    }
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
    // Flag is part of RDS data — render via resolveFlag (supports customFlags by ITU)
    $$(".data-flag").forEach((e) => (e.innerHTML = renderFlag(resolveFlag(st))));
    const setLogo = (sel) => {
      const el = $(sel);
      if (!el) return;
      el.src = st.logo || DEFAULT_LOGO;
      el.style.display = "block";
    };
    setLogo("#station-logo");
    setLogo("#station-logo-phone");
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
    afList.innerHTML = af.map((f) => `<li><a>${fmtAF(f)}</a></li>`).join("");
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
  const padCenter = (s) => {
    const t = (s || "").slice(0, 8);
    const total = 8 - t.length;
    const left = Math.floor(total / 2);
    return " ".repeat(left) + t + " ".repeat(total - left);
  };
  // Pad a chunk to 8 chars. When CFG.psCenterShort is true and the trimmed
  // content is <= 6 chars, center it instead of left-aligning.
  function fitChunk(s) {
    const trimmed = (s || "").trim();
    if (CFG && (CFG.psCenterShort || CFG.pscenterShort) && trimmed.length > 0 && trimmed.length <= 6) {
      return padCenter(trimmed);
    }
    // If already 8 chars (e.g. user supplied leading/trailing spaces), preserve.
    if (s.length >= 8) return s.slice(0, 8);
    return pad8(s);
  }
  function splitPSChunks(text) {
    if (!text) return ["        "];
    const raw = toRdsAscii(text);
    // If the whole text already fits in 8 chars, preserve the user's spacing.
    if (raw.length <= 8) return [fitChunk(raw)];
    const t = raw.trim();
    if (t.length <= 8) return [fitChunk(t)];
    // Greedy word packing into 8-char chunks
    const words = t.split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
      if (w.length > 8) {
        if (cur) { out.push(fitChunk(cur)); cur = ""; }
        for (let i = 0; i < w.length; i += 8) out.push(fitChunk(w.slice(i, i + 8)));
        continue;
      }
      const trial = cur ? cur + " " + w : w;
      if (trial.length > 8) { out.push(fitChunk(cur)); cur = w; }
      else cur = trial;
    }
    if (cur) out.push(fitChunk(cur));
    return out;
  }
  function computePSFullText(st) {
    return resolveTokens(st.ps, metaFor(st), {
      preserveOuterSpacing: true,
      preserveInnerSpacing: true,
    }) || (st.station?.name || "");
  }
  function initPSForLock(st) {
    psFullText = computePSFullText(st);
    psMode = (st.dynamicPsMode || CFG.dynamicPsMode || "groups").toLowerCase();
    psChunks = splitPSChunks(psFullText);
    // Seed chunk index from the background scheduler so tuning in lands
    // mid-cycle rather than always at chunk 0.
    let startIdx = 0;
    if (psMode === "groups" && psChunks.length > 1) {
      const bg = bgPS.get(st.mount);
      if (bg && bg.chunks.length === psChunks.length && bg.idx < psChunks.length) {
        startIdx = bg.idx;
      } else {
        startIdx = Math.floor(Math.random() * psChunks.length);
      }
    }
    psChunkIdx = startIdx;
    psChunkHoldTicks = 0;
    psScrollOffset = 0;
    psScrollDir = 1;
    psScrollNextMs = performance.now() + (st.scrollStopStartMs ?? CFG.scrollStopStartMs ?? 1500);
    psFirstCycleDone = false;
    psFilled = [false, false, false, false];
    psFillTarget = (psMode === "scroll")
      ? pad8(psFullText.slice(0, 8))
      : (psChunks[psChunkIdx] || "        ");
    psBuf = "        ";
  }
  // If Icecast metadata changed, queue the new chunks but DO NOT swap mid-cycle —
  // current PS keeps cycling and the new text takes over at the next wrap.
  function maybeRefreshPSFromIcecast() {
    if (!lockedStation) return;
    const next = computePSFullText(lockedStation);
    if (next && next !== psFullText) {
      psFullText = next;
      const newChunks = splitPSChunks(psFullText);
      _pendingPSChunks = newChunks;
    }
  }
  let _pendingPSChunks = null;
  function psSchedulerTick() {
    if (!lockedStation || !psFirstCycleDone) return;
    const st = lockedStation;
    if (psMode === "static") return;
    if (psMode === "scroll") {
      const now = performance.now();
      if (now < psScrollNextMs) return;
      const text = pad8(psFullText) + "   ";
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
        if (_pendingPSChunks) {
          psFullText = _pendingPSChunks.join("").replace(/\s+$/, "");
          _pendingPSChunks = null;
        }
      } else {
        psScrollNextMs = now + (st.scrollSpeedMs ?? CFG.scrollSpeedMs ?? 300);
      }
      psBuf = text.slice(psScrollOffset, psScrollOffset + 8);
      paintPS();
      return;
    }
  }
  // Called from rdsGroup() once the current 8-char fill is complete, to
  // decide when to advance to the next chunk in groups mode.
  function psGroupsAdvance(st) {
    if (psMode !== "groups") return;
    const hold = st.groupsHoldGroups ?? CFG.groupsHoldGroups ?? 4;
    psChunkHoldTicks++;
    if (psChunkHoldTicks < hold) return;
    psChunkHoldTicks = 0;
    // Apply pending Icecast update at the wrap (chunk 0).
    if (psChunks.length <= 1) {
      if (_pendingPSChunks && _pendingPSChunks.length) {
        psChunks = _pendingPSChunks;
        _pendingPSChunks = null;
      }
      // Single-chunk: keep refilling the same chunk realistically
      psChunkIdx = 0;
    } else {
      const nextIdx = (psChunkIdx + 1) % psChunks.length;
      if (nextIdx === 0 && _pendingPSChunks && _pendingPSChunks.length) {
        psChunks = _pendingPSChunks;
        _pendingPSChunks = null;
      }
      psChunkIdx = nextIdx % psChunks.length;
    }
    // Re-trigger the 2-char gradual fill for the new chunk. We deliberately
    // do NOT clear psBuf — the previous chunk stays visible and is overwritten
    // 2 chars at a time, so dynamic updates feel like a real RDS PS rewrite
    // rather than a blank-then-fill cycle. (The very first cycle still starts
    // from blanks because initPSForLock seeded psBuf with spaces.)
    psFillTarget = psChunks[psChunkIdx] || "        ";
    psFilled = [false, false, false, false];
    paintPS();
    bgPSTouch(st.mount, psChunkIdx);
  }

  // ---------- Background PS schedulers (per non-locked station) ----------
  function bgPSInitAll() {
    if (!CFG || bgPSInitDone) return;
    bgPSInitDone = true;
    const now = performance.now();
    CFG.stations.forEach((st) => {
      if (!hasRDS(st)) return;
      const mode = (st.dynamicPsMode || CFG.dynamicPsMode || "groups").toLowerCase();
      if (mode !== "groups") return;
      const chunks = splitPSChunks(computePSFullText(st));
      if (!chunks.length) return;
      const hold = st.groupsHoldGroups ?? CFG.groupsHoldGroups ?? 4;
      bgPS.set(st.mount, {
        chunks,
        idx: Math.floor(Math.random() * chunks.length),
        // Random holdTicks gives a random offset within the current chunk
        // so two stations with identical timing won't move in lock-step.
        holdTicks: Math.floor(Math.random() * (hold + 4)),
        nextTickMs: now + Math.random() * GROUP_MS,
      });
    });
  }
  function bgPSTick() {
    if (!CFG) return;
    const now = performance.now();
    for (const [mount, s] of bgPS) {
      if (lockedStation && lockedStation.mount === mount) continue;
      if (now < s.nextTickMs) continue;
      s.nextTickMs = now + GROUP_MS;
      const st = CFG.stations.find((x) => x.mount === mount);
      if (!st) continue;
      // Refresh chunks if Icecast metadata changed
      const newChunks = splitPSChunks(computePSFullText(st));
      if (newChunks.length && newChunks.join("|") !== s.chunks.join("|")) {
        s.chunks = newChunks;
        if (s.idx >= s.chunks.length) s.idx = 0;
      }
      const hold = st.groupsHoldGroups ?? CFG.groupsHoldGroups ?? 4;
      // Each chunk takes ~4 groups to "fill" + hold groups to display.
      s.holdTicks++;
      if (s.holdTicks >= hold + 4) {
        s.holdTicks = 0;
        s.idx = s.chunks.length ? (s.idx + 1) % s.chunks.length : 0;
      }
    }
  }
  function bgPSTouch(mount, idx) {
    const s = bgPS.get(mount);
    if (s) { s.idx = idx; s.holdTicks = 0; s.nextTickMs = performance.now() + GROUP_MS; }
  }

  // ---------- RDS group tick ----------
  function rdsGroup() {
    if (!lockedStation) return;
    const st = lockedStation;
    const now = performance.now();
    if (now - lockedAtMs < PI_DELAY_MS + RDS_START_MS) return;
    const src = metaFor(st);
    groupTick++;

    if (!rdsBasicShown) {
      rdsBasicShown = true;
      showBasicRDS(st);
    }

    // Glitch probabilities scale with low signal
    const q = lastQuality;
    const dropProb = clamp((1 - q) * 0.6, 0, 0.6);

    // ---- PS gradual fill (2 chars per group). Used for both the initial
    // ---- lock and for every chunk transition in groups mode, so dynamic
    // ---- updates load in the same way a fresh tune-in does.
    if (!psFilled.every(Boolean)) {
      if (Math.random() >= dropProb) {
        for (let i = 0; i < 4; i++) {
          if (!psFilled[i]) {
            psFilled[i] = true;
            const chars = psFillTarget.slice(i * 2, i * 2 + 2);
            psBuf = psBuf.slice(0, i * 2) + chars + psBuf.slice(i * 2 + 2);
            paintPS();
            break;
          }
        }
      }
    } else {
      if (!psFirstCycleDone) psFirstCycleDone = true;
      maybeRefreshPSFromIcecast();
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

  // ---------- SNR / Spectrum canvas ----------
  let spectrumMode = false;
  let _spectrumGeom = null; // geometry of the last spectrum draw, for click→tune mapping
  const GRAPH_FONT = "10px 'Titillium Web', sans-serif";
  function niceCeil(v) {
    if (v <= 10) return Math.ceil(v / 2) * 2;
    if (v <= 30) return Math.ceil(v / 5) * 5;
    if (v <= 80) return Math.ceil(v / 10) * 10;
    return Math.ceil(v / 20) * 20;
  }
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

    // Autoscale: top of graph = a "nice" number above the recent peak
    const recentMax = snrHistory.reduce((m, v) => v > m ? v : m, CFG.noiseFloorDbf + 5);
    const top = Math.max(20, niceCeil(recentMax + 4));
    const bottom = 0;

    const padL = 30, padR = 28, padT = 6, padB = 14;
    const gx = padL, gw = w - padL - padR;
    const gy = padT, gh = h - padT - padB;

    // Gridlines + left/right axis labels
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = GRAPH_FONT;
    ctx.textBaseline = "middle";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = gy + gh * frac;
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y); ctx.stroke();
      const val = top - frac * (top - bottom);
      const label = val.toFixed(val < 10 ? 1 : 0);
      ctx.textAlign = "right"; ctx.fillText(label, gx - 4, y);
      ctx.textAlign = "left";  ctx.fillText(label, gx + gw + 4, y);
    }

    const col = getComputedStyle(document.documentElement).getPropertyValue("--color-main-bright").trim() || "#68f7ee";
    ctx.strokeStyle = col;
    ctx.lineWidth = 2; ctx.beginPath();
    const n = snrHistory.length;
    snrHistory.forEach((v, i) => {
      const x = gx + (i / Math.max(1, n - 1)) * gw;
      const y = gy + gh - clamp((v - bottom) / (top - bottom), 0, 1) * gh;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  function drawSpectrum() {
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

    const padL = 34, padR = 12, padT = 6, padB = 16;
    const gx = padL, gw = w - padL - padR;
    const gy = padT, gh = h - padT - padB;

    const fMin = CFG.tuningMin, fMax = CFG.tuningMax;
    _spectrumGeom = { gx, gw, fMin, fMax };
    // Sample dB at every 0.05 MHz across the band
    const stepF = 0.05;
    const samples = [];
    for (let f = fMin; f <= fMax + 1e-6; f += stepF) {
      let best = CFG.noiseFloorDbf;
      CFG.stations.forEach((st) => {
        const v = baseSignal(st, f - st.freq);
        if (v > best) best = v;
      });
      // Add small "static" jitter at noise floor
      const jit = (Math.random() - 0.5) * 1.2;
      samples.push({ f, db: Math.max(0, best + jit) });
    }
    const maxDb = samples.reduce((m, s) => s.db > m ? s.db : m, CFG.noiseFloorDbf + 10);
    const top = niceCeil(maxDb + 4);
    const bottom = 0;

    // Gridlines + left dB labels
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = GRAPH_FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = gy + gh * frac;
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y); ctx.stroke();
      const val = top - frac * (top - bottom);
      ctx.fillText(val.toFixed(0), gx - 4, y);
    }

    // Frequency ticks along bottom
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const fStep = (fMax - fMin) <= 10 ? 1 : 5;
    for (let f = Math.ceil(fMin / fStep) * fStep; f <= fMax; f += fStep) {
      const x = gx + ((f - fMin) / (fMax - fMin)) * gw;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath(); ctx.moveTo(x, gy + gh); ctx.lineTo(x, gy + gh + 3); ctx.stroke();
      ctx.fillText(f.toFixed(0), x, gy + gh + 4);
    }

    // Spectrum filled area
    const col = getComputedStyle(document.documentElement).getPropertyValue("--color-main-bright").trim() || "#68f7ee";
    ctx.fillStyle = col + "33";
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(gx, gy + gh);
    samples.forEach((s) => {
      const x = gx + ((s.f - fMin) / (fMax - fMin)) * gw;
      const y = gy + gh - clamp((s.db - bottom) / (top - bottom), 0, 1) * gh;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(gx + gw, gy + gh); ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Current tuning marker
    const mx = gx + ((currentFreq - fMin) / (fMax - fMin)) * gw;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(mx, gy); ctx.lineTo(mx, gy + gh); ctx.stroke();
    ctx.setLineDash([]);
  }
  function drawGraph() {
    if (spectrumMode) drawSpectrum(); else drawSNR();
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
    drawGraph();

    if (ac) {
      const keep = warmDesiredStations(currentFreq);
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
        psFilled = [false,false,false,false]; psBuf = "        "; psFillTarget = "        ";
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
          const el = $("#data-pi");
          if (el) {
            if (lockSnap.pi && !piIsNull(lockSnap.pi)) el.textContent = lockSnap.pi.toUpperCase();
            else el.innerHTML = PI_EMPTY_HTML;
          }
          piShown = true;
        }
      }, PI_DELAY_MS);
    }
  }

  // ---------- tuning ----------
  function tuneTo(f) {
    currentFreq = clamp(Math.round(f * 1000) / 1000, CFG.tuningMin, CFG.tuningMax);
    extendPreloadWindow(12000);
    if (ac) warmDesiredStations(currentFreq);
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

  // For stations whose `mount` is a full http(s) URL (i.e. NOT hosted on
  // the shared Icecast server), fetch the ICY StreamTitle via our proxy
  // so %MD% / %ICEMD% tokens work.
  async function pollStreamMeta() {
    if (!CFG || !CFG.stations) return;
    const urls = new Set();
    CFG.stations.forEach((s) => {
      if (s.mount && /^https?:\/\//i.test(s.mount)) urls.add(s.mount);
    });
    if (!urls.size) return;
    await Promise.all(Array.from(urls).map(async (u) => {
      try {
        const r = await fetch(`/api/stream-meta?url=${encodeURIComponent(u)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (j && typeof j.title === "string") {
          streamMeta[u] = { title: j.title };
        }
      } catch (e) {}
    }));
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
    // ---- Play / pause across ALL .playbutton instances (desktop + mobile tray) ----
    // The original FM-DX shipping HTML installs a jQuery handler that opens a
    // websocket (wss://.../audio) and toggles a fa-stop icon. We override both:
    //  * Neutralize the websocket-based handler.
    //  * Strip jQuery click handlers, re-bind one shared handler.
    //  * Icon = fa-pause while playing, fa-play when stopped (never fa-stop).
    const playBtns = $$(".playbutton");
    const setPlayIcon = () => {
      playBtns.forEach((b) => {
        const icon = b.querySelector("i");
        if (icon) icon.className = playing ? "fa-solid fa-stop fa-lg" : "fa-solid fa-play fa-lg";
        b.classList.remove("bg-gray");
        b.disabled = false;
      });
    };
    const onPlayClick = async () => {
      ensureAudio();
      try { if (ac.state === "suspended") await ac.resume(); } catch (e) {}
      playing = !playing;
      muted = !playing;
      setPlayIcon();
      warmDesiredStations(currentFreq);
      if (playing) {
        for (const [, n] of pool) {
          try { const p = n.audio.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        }
      } else {
        for (const [, n] of pool) {
          try { n.audio.pause(); } catch (e) {}
        }
      }
    };
    const installPlayHandler = () => {
      // Disable upstream websocket-based handler.
      try { window.OnPlayButtonClick = function () {}; } catch (e) {}
      try { if (window.Stream && window.Stream.Stop) window.Stream.Stop(); window.Stream = null; } catch (e) {}
      if (window.jQuery) {
        try { window.jQuery(".playbutton").off("click"); } catch (e) {}
      }
      $$(".playbutton").forEach((b) => {
        b.classList.remove("bg-gray");
        b.disabled = false;
        b.addEventListener("click", onPlayClick);
      });
      setPlayIcon();
    };
    if (window.jQuery) window.jQuery(installPlayHandler);
    else installPlayHandler();
    // Re-run after a tick in case upstream Init re-binds on document.ready.
    setTimeout(installPlayHandler, 0);
    setTimeout(installPlayHandler, 500);

    // ---- Spectrum analyzer plugin button ----
    const pluginHost = $(".dashboard-panel-plugin-list .scrollable-container")
                    || $(".dashboard-panel-plugin-list");
    if (pluginHost && !$("#spectrum-graph-button")) {
      const sb = document.createElement("button");
      sb.id = "spectrum-graph-button";
      sb.className = "no-bg color-4 hover-brighten tooltip";
      sb.style.cssText = "padding: 6px; width: 64px; min-width: 64px;";
      sb.setAttribute("data-tooltip", "Spectrum Graph");
      sb.setAttribute("data-tooltip-placement", "bottom");
      sb.innerHTML = `<i class="fa-solid fa-chart-area fa-lg top-10"></i><br>
        <span style="font-size: 10px; color: var(--color-main-bright) !important;">Spectrum</span>`;
      sb.addEventListener("click", () => {
        spectrumMode = !spectrumMode;
        if (spectrumMode) extendPreloadWindow(45000);
        sb.classList.toggle("bg-color-4", spectrumMode);
        const cv = $("#signal-canvas");
        if (cv) cv.style.cursor = spectrumMode ? "crosshair" : "default";
        if (ac) {
          const keep = warmDesiredStations(currentFreq);
          pruneStations(keep);
        }
        drawGraph();
      });
      pluginHost.appendChild(sb);
    }

    // ---- Click-to-tune on the spectrum graph ----
    const canvasEl = $("#signal-canvas");
    if (canvasEl) {
      canvasEl.addEventListener("click", (e) => {
        if (!spectrumMode || !_spectrumGeom) return;
        const rect = canvasEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const { gx, gw, fMin, fMax } = _spectrumGeom;
        if (x < gx || x > gx + gw) return;
        const f = fMin + ((x - gx) / gw) * (fMax - fMin);
        const stepped = Math.round(f / CFG.tuningStep) * CFG.tuningStep;
        tuneTo(stepped);
      });
    }

    const vol = $("#volumeSlider");
    if (vol) vol.addEventListener("input", () => { if (masterGain) masterGain.gain.value = parseFloat(vol.value); });
    document.addEventListener("click", (e) => {
      const t = e.target.closest(".stereo-container");
      if (!t) return;
      forcedMono = !forcedMono;
      paint();
    });

    pollIcecast(); setInterval(pollIcecast, 8000);
    pollStreamMeta(); setInterval(pollStreamMeta, 10000);

    // ---- Keyboard tuning: arrow keys step by CFG.tuningStep ----
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const tag = (t && t.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
      const step = CFG.tuningStep || 0.1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        tuneTo(currentFreq + step); e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        tuneTo(currentFreq - step); e.preventDefault();
      }
    });
    // ---- Mouse wheel tuning over the frequency display and spectrum ----
    const wheelTune = (el) => {
      if (!el) return;
      el.addEventListener("wheel", (e) => {
        // Only intercept the spectrum wheel while spectrum mode is on.
        if (el.id === "signal-canvas" && !spectrumMode) return;
        e.preventDefault();
        const step = CFG.tuningStep || 0.1;
        tuneTo(currentFreq + (e.deltaY < 0 ? step : -step));
      }, { passive: false });
    };
    wheelTune($("#data-frequency"));
    wheelTune($("#commandinput"));
    wheelTune($("#signal-canvas"));
    // Also allow wheel on the outer frequency container if present.
    wheelTune($(".data-frequency-container"));
    bgPSInitAll();
    tuneTo(CFG.defaultFrequency);
    setInterval(paint, 250);
    setInterval(rdsGroup, GROUP_MS);
    setInterval(bgPSTick, 120);
    setInterval(psSchedulerTick, 80);
  })();
})();
