/* =====================================================================
   Fake Tuner Configuration
   ---------------------------------------------------------------------
   Edit this file to change the tuner name, stations, tuning limits, etc.
   Reload the page after editing.
   ===================================================================== */
window.TUNER_CONFIG = {
  // ---------- Tuner identity (top banner) ----------
  tunerName: "SOUPCO-Fake",
  tunerDescription: "Fake tuner backed by the SOUPCO Icecast server.",
  tunerDevice: "Virtual TEF668x",
  ownerContact: "you@example.com",

  // ---------- Tuning ----------
  tuningMin: 87.5,      // MHz - lower band edge
  tuningMax: 108.0,     // MHz - upper band edge
  tuningStep: 0.1,      // MHz - default step (the < > buttons)
  defaultFrequency: 99.9,

  // ---------- Signal model ----------
  // Receiver noise floor in dBf and the bandwidth (MHz) around a station's
  // center frequency where its audio is still audible (off-tuned -> distorted).
  noiseFloorDbf: 8,
  audibleBandwidth: 0.3,  // +/- MHz around the station center

  // ---------- Stations ----------
  // Each station maps an FM frequency to an Icecast mount on
  //   https://radio.soupco.net:8443
  // (we proxy the stream through /api/stream/<mount> for CORS + WebAudio).
  //
  // Fields:
  //   freq     : MHz - dial frequency the station appears on
  //   mount    : Icecast mount name (path after the server host)
  //   ps       : 8-char Programme Service name (RDS PS) - supports tokens
  //   rt       : up to 64-char RadioText (RDS RT) - supports tokens
  //              tokens: %ICEMD% = current Icecast "title" (now playing)
  //                      %SERVER% = Icecast "server_name"
  //                      (ALLCAPS)...%ICEMD%... = uppercase the result
  //   pi       : RDS PI code (4 hex chars), e.g. "F597"
  //   pty      : Program TYPE (0..31), e.g. 10 (Pop Music)
  //   af       : Alternate Frequencies list, e.g. [102.5, 105.0]
  //   tp / ta  : Traffic Programme / Traffic Announcement flags
  //   ms       : 'M' (music) or 'S' (speech)
  //   stereo   : true/false
  //   signal   : signal strength in dBf at receiver (drives SNR + audio)
  //   station  : transmitter info shown in the bottom panel
  //              { name, city, itu, erp, pol, distance, azimuth }
  stations: [
    {
      freq: 92.5, mount: "kxka", pi: "92A5", pty: 10, af: [98.7],
      ps: "KXKA",
      rt: "%ICEMD% on (ALLCAPS)%SERVER%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 58,
      station: { name: "KXKA", city: "Keysota", itu: "USA", erp: 25, pol: "M", distance: 14, azimuth: 90 },
    },
    {
      freq: 92.9, mount: "mix929springton", pi: "9290", pty: 10, af: [104.3],
      ps: "MIX 92.9",
      rt: "Mix 92.9 Springton - Now Playing: %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 64,
      station: { name: "Mix 92.9", city: "Springton", itu: "USA", erp: 50, pol: "M", distance: 22, azimuth: 145 },
    },
    {
      freq: 99.9, mount: "999virginradioswimsuit", pi: "9990", pty: 10, af: [],
      ps: "VIRGIN_R",
      rt: "(ALLCAPS)%ICEMD% on Virgin Radio",
      tp: false, ta: false, ms: "M", stereo: true, signal: 72,
      station: { name: "Virgin Radio", city: "Springton", itu: "USA", erp: 100, pol: "M", distance: 8, azimuth: 200 },
    },
    {
      freq: 100.3, mount: "1003larumbastmiguel", pi: "1003", pty: 24, af: [],
      ps: "LA RUMBA",
      rt: "La Rumba 100.3 - %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 38,
      station: { name: "La Rumba 100.3", city: "San Miguel", itu: "MEX", erp: 5, pol: "M", distance: 41, azimuth: 260 },
    },
    {
      freq: 102.7, mount: "1027kissfmsprington", pi: "1027", pty: 10, af: [],
      ps: "KISS FM",
      rt: "%ICEMD% - Today's Hit Music",
      tp: false, ta: false, ms: "M", stereo: true, signal: 55,
      station: { name: "Kiss FM", city: "Springton", itu: "USA", erp: 30, pol: "M", distance: 18, azimuth: 130 },
    },
    {
      freq: 95.3, mount: "rtor1", pi: "9530", pty: 10, af: [97.1, 100.5],
      ps: "RTO R1 ",
      rt: "RTO Radio 1 - %ICEMD%",
      tp: true, ta: false, ms: "M", stereo: true, signal: 48,
      station: { name: "RTO Radio 1", city: "Soupville", itu: "USA", erp: 20, pol: "M", distance: 35, azimuth: 75 },
    },
    {
      freq: 97.7, mount: "rtor2", pi: "9770", pty: 4, af: [],
      ps: "RTO R2 ",
      rt: "(ALLCAPS)RTO Radio 2 - Now Playing %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 40,
      station: { name: "RTO Radio 2", city: "Soupville", itu: "USA", erp: 15, pol: "M", distance: 35, azimuth: 75 },
    },
    {
      freq: 105.5, mount: "rtoclassique", pi: "1055", pty: 16, af: [],
      ps: "CLASSIQ ",
      rt: "RTO Classique - %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 32,
      station: { name: "RTO Classique", city: "Soupville", itu: "USA", erp: 10, pol: "M", distance: 35, azimuth: 75 },
    },
    {
      freq: 106.9, mount: "volt", pi: "1069", pty: 10, af: [],
      ps: "VOLT FM ",
      rt: "Volt Radio - %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 25,
      station: { name: "Volt Radio", city: "Belgrade", itu: "SRB", erp: 5, pol: "M", distance: 90, azimuth: 30 },
    },
    {
      freq: 98.1, mount: "y98springton", pi: "9810", pty: 10, af: [],
      ps: "Y98     ",
      rt: "Y98 - Today's Best Mix - %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 60,
      station: { name: "Y98", city: "Springton", itu: "USA", erp: 50, pol: "M", distance: 18, azimuth: 130 },
    },
    {
      freq: 100.1, mount: "z100facesits", pi: "1001", pty: 10, af: [],
      ps: "Z100    ",
      rt: "Z100 - %ICEMD%",
      tp: false, ta: false, ms: "M", stereo: true, signal: 68,
      station: { name: "Z100", city: "Springton", itu: "USA", erp: 100, pol: "M", distance: 18, azimuth: 130 },
    },
  ],

  // ---------- Preset buttons (top right) ----------
  presets: [92.5, 99.9, 100.1, 102.7],
};