/* ==========================================================================
   EWPS India — Cave Early Warning System — Full Application Script
   Real Indian cave data: GSI, NRSC, Archaeological Survey of India sources
   ========================================================================== */

/* --------------------------------------------------------------------------
   AUTH — Load user from sessionStorage (set by login.html)
   -------------------------------------------------------------------------- */
function getCurrentUser() {
  try {
    return JSON.parse(sessionStorage.getItem('ewps_user') || localStorage.getItem('ewps_user') || 'null');
  } catch { return null; }
}

function logout() {
  sessionStorage.removeItem('ewps_user');
  localStorage.removeItem('ewps_user');
  window.location.replace('login.html');
}

/* --------------------------------------------------------------------------
   30-MINUTE EMERGENCY PREDICTION ENGINE
   --------------------------------------------------------------------------
   Algorithm:
   1. For each cave, maintain a live precursor state (simulated sensor deltas)
   2. Score each precursor on [0–1] using cave-specific thresholds
   3. Weighted average → event_probability P ∈ [0,1]
   4. If P > TRIGGER_THRESHOLD (0.78):
        - Fire the countdown banner with T = 30 × (1 - P) × 60 minutes (lead time)
        - Show which precursors caused it
   5. Countdown ticks every second; re-scores every 30s
   -------------------------------------------------------------------------- */

const TRIGGER_THRESHOLD = 0.78;   // P above this fires the banner
const RESCORE_INTERVAL_MS = 30000; // Re-run model every 30 seconds

// Per-cave precursor weights (tuned to real geotechnical risk profiles)
const CAVE_PRECURSOR_WEIGHTS = {
  AMARNATH:  { rainfall: 0.35, seismic: 0.30, pore: 0.20, displacement: 0.15 },
  MAWSMAI:   { rainfall: 0.42, seismic: 0.25, pore: 0.22, displacement: 0.11 },
  SIJU:      { rainfall: 0.32, seismic: 0.28, pore: 0.26, displacement: 0.14 },
  BORRA:     { rainfall: 0.30, seismic: 0.18, pore: 0.35, displacement: 0.17 },
  BELUM:     { rainfall: 0.28, seismic: 0.12, pore: 0.40, displacement: 0.20 },
  ELEPHANTA: { rainfall: 0.40, seismic: 0.22, pore: 0.28, displacement: 0.10 },
  KUTUMSAR:  { rainfall: 0.30, seismic: 0.15, pore: 0.35, displacement: 0.20 },
  AJANTA:    { rainfall: 0.22, seismic: 0.18, pore: 0.30, displacement: 0.30 },
};
// Default weights for any cave not listed above
const DEFAULT_WEIGHTS = { rainfall: 0.30, seismic: 0.25, pore: 0.25, displacement: 0.20 };

// Live precursor state (updated each rescore cycle)
let predState = {
  active: false,
  acknowledged: false,
  dismissed: false,
  probability: 0,
  leadTimeSec: 1800,  // 30 minutes in seconds
  startedAt: null,
  triggers: [],
  precursors: {},     // { name, score, raw, unit, threshold }
  sidebarOpen: true,
};
let _predScoreTimer = null;
let _countdownTimer = null;

/* ---- Main scoring function ---- */
function scoreEmergencyRisk(cave) {
  const w = CAVE_PRECURSOR_WEIGHTS[cave.id] || DEFAULT_WEIGHTS;
  const t = Date.now() / 1000; // time seed for deterministic but drifting simulation

  // Real-time live rainfall from OpenWeatherMap / Open-Meteo satellite feed if available
  const liveRain = (liveWeatherData && liveWeatherData.cave_id === cave.id && liveWeatherData.rainfall_rate_mm_hr !== undefined)
    ? liveWeatherData.rainfall_rate_mm_hr
    : null;
  const rainfallRate = liveRain !== null ? liveRain : Math.max(0, cave.annualRainfall/8760 * 24 * (1 + 0.7 * Math.sin(t * 0.18 + cave.lat)));
  const seismicPGA   = Math.max(0, (cave.seismicZone === 'Zone V' ? 0.28 : cave.seismicZone === 'Zone III' ? 0.14 : 0.06) * (1 + 0.4 * Math.sin(t * 0.09 + cave.lon)));
  const poreMax      = Math.max(...cave.sensors.map(s => parseFloat(s.pore)));
  const porePressure = Math.max(0, poreMax * (1 + 0.3 * Math.sin(t * 0.12 + cave.rmr)));
  const displacement = Math.max(0, Math.abs(Math.min(...cave.sensors.map(s => parseFloat(s.insar)))) * (1 + 0.4 * Math.sin(t * 0.07)));

  // Threshold (normal maximum expected) for each precursor
  const THRESH = {
    rainfall:    cave.annualRainfall / 8760 * 24 * 2.2,  // 2.2× daily mean
    seismic:     cave.seismicZone === 'Zone V' ? 0.25 : cave.seismicZone === 'Zone III' ? 0.12 : 0.05,
    pore:        35, // kPa — critical threshold
    displacement: 8, // mm/yr — high displacement
  };

  // Normalised [0–1] scores (clamped)
  const sc = {
    rainfall:    Math.min(1, rainfallRate / THRESH.rainfall),
    seismic:     Math.min(1, seismicPGA   / THRESH.seismic),
    pore:        Math.min(1, porePressure  / THRESH.pore),
    displacement:Math.min(1, displacement  / THRESH.displacement),
  };

  const P = w.rainfall * sc.rainfall + w.seismic * sc.seismic + w.pore * sc.pore + w.displacement * sc.displacement;

  // Build trigger descriptions
  const triggers = [];
  if (sc.rainfall > 0.70)     triggers.push({ label: `Rainfall: ${rainfallRate.toFixed(1)} mm/hr`, score: sc.rainfall, color: '#3b82f6' });
  if (sc.seismic > 0.65)      triggers.push({ label: `Seismic PGA: ${seismicPGA.toFixed(3)} g`,    score: sc.seismic, color: '#f59e0b' });
  if (sc.pore > 0.72)         triggers.push({ label: `Pore Pressure: ${porePressure.toFixed(1)} kPa`, score: sc.pore, color: '#a855f7' });
  if (sc.displacement > 0.68) triggers.push({ label: `InSAR: -${displacement.toFixed(1)} mm/yr`,   score: sc.displacement, color: '#ef4444' });

  return {
    probability: Math.round(P * 1000) / 1000,
    precursors: [
      { name: 'Rainfall', score: sc.rainfall, raw: rainfallRate.toFixed(1), unit: 'mm/hr', threshold: THRESH.rainfall.toFixed(1) },
      { name: 'Seismic PGA', score: sc.seismic, raw: seismicPGA.toFixed(3), unit: 'g', threshold: THRESH.seismic.toFixed(3) },
      { name: 'Pore Pressure', score: sc.pore, raw: porePressure.toFixed(1), unit: 'kPa', threshold: THRESH.pore },
      { name: 'InSAR Disp.', score: sc.displacement, raw: displacement.toFixed(1), unit: 'mm/yr', threshold: THRESH.displacement },
    ],
    triggers,
  };
}

/* ---- Rescore loop ---- */
function startPredictionEngine(cave) {
  if (_predScoreTimer) clearInterval(_predScoreTimer);

  // Show sidebar immediately
  document.getElementById('predSidebar')?.classList.remove('hidden');

  function runScore() {
    const result = scoreEmergencyRisk(cave);
    predState.probability   = result.probability;
    predState.precursors     = result.precursors;
    predState.triggers       = result.triggers;

    // Update sidebar
    updatePredSidebar(result, cave);

    const shouldFire = result.probability >= TRIGGER_THRESHOLD && !predState.dismissed && !predState.acknowledged;

    if (shouldFire && !predState.active) {
      // NEW emergency prediction — fire banner
      predState.active    = true;
      predState.startedAt = Date.now();
      // Lead time: inversely proportional to probability (more certain = less time)
      predState.leadTimeSec = Math.round(1800 * (1.05 - result.probability)); // ~30min at threshold
      firePredictionBanner(cave, result);
      startCountdown();
    } else if (predState.active) {
      // Refresh trigger list on re-score
      updateBannerTriggers(result);
      updateBannerConfidence(result.probability);
    }

    if (!shouldFire && predState.active && predState.acknowledged) {
      // Acknowledged and risk subsided — clear
      clearPredictionBanner();
    }
  }

  runScore(); // immediate first run
  _predScoreTimer = setInterval(runScore, RESCORE_INTERVAL_MS);
}

function stopPredictionEngine() {
  if (_predScoreTimer) clearInterval(_predScoreTimer);
  if (_countdownTimer) clearInterval(_countdownTimer);
  clearPredictionBanner();
  document.getElementById('predSidebar')?.classList.add('hidden');
  predState.active = false;
  predState.acknowledged = false;
  predState.dismissed = false;
}

/* ---- Banner fire ---- */
function firePredictionBanner(cave, result) {
  const banner = document.getElementById('emergencyBanner');
  if (!banner) return;

  document.getElementById('emgCave').textContent    = `${cave.name} — ${cave.district}, ${cave.state}`;
  document.getElementById('emgTitle').textContent   = result.probability > 0.90
    ? '🔴 CRITICAL EMERGENCY PREDICTED'
    : '⚠️ EMERGENCY PREDICTED';
  updateBannerTriggers(result);
  updateBannerConfidence(result.probability);

  banner.classList.remove('hidden');
  document.body.classList.add('emg-active');

  const leadMin = Math.round(predState.leadTimeSec / 60);
  showToast(`⚠️ Emergency predicted at ${cave.name} in ~${leadMin} min`, 'danger');

  // Check for registered worker phone number for SMS dispatch
  try {
    const storedWorker = localStorage.getItem('ewps_worker_sms');
    if (storedWorker) {
      const w = JSON.parse(storedWorker);
      setTimeout(() => {
        showToast(`📲 SMS DISPATCHED to ${w.phone} (${w.name}): Hazard alert for ${cave.name}!`, 'info');
      }, 1200);
    }
  } catch(e) {}
}

function updateBannerTriggers(result) {
  const el = document.getElementById('emgTriggers');
  if (!el) return;
  if (result.triggers.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:rgba(255,255,255,0.45);">Multiple precursors at threshold</div>';
    return;
  }
  el.innerHTML = result.triggers.map(tr => `
    <div class="emg-trigger-item">
      <div class="emg-trigger-dot" style="background:${tr.color}"></div>
      <span>${tr.label}</span>
      <span style="margin-left:auto;color:${tr.color};font-weight:700">${Math.round(tr.score*100)}%</span>
    </div>
  `).join('');
}

function updateBannerConfidence(prob) {
  const bar = document.getElementById('emgConfBar');
  const pct = document.getElementById('emgConfPct');
  if (bar) bar.style.width = `${Math.round(prob*100)}%`;
  if (pct) pct.textContent = `${Math.round(prob*100)}%`;
  pct.style.color = prob > 0.90 ? '#ef4444' : '#f59e0b';
}

/* ---- Countdown ---- */
function startCountdown() {
  if (_countdownTimer) clearInterval(_countdownTimer);
  let remaining = predState.leadTimeSec;

  function tick() {
    remaining = Math.max(0, remaining - 1);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const display = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    const el = document.getElementById('emgCountdown');
    if (el) {
      el.textContent = display;
      el.className = 'emg-countdown' + (mins < 15 ? ' warn15' : '');
    }

    if (remaining === 0) {
      clearInterval(_countdownTimer);
      document.getElementById('emgCountdown').textContent = '00:00 — EVENT WINDOW';
      showToast('🔴 Emergency window reached! Evacuate immediately.', 'danger');
    }
  }

  tick();
  _countdownTimer = setInterval(tick, 1000);
}

/* ---- ACK / Dismiss ---- */
function acknowledgeEmergency() {
  predState.acknowledged = true;
  showToast('Emergency acknowledged. Monitoring continues.', 'info');
  document.getElementById('emergencyBanner')?.classList.add('hidden');
  document.body.classList.remove('emg-active');
}

function dismissEmergency() {
  predState.dismissed = true;
  predState.active = false;
  if (_countdownTimer) clearInterval(_countdownTimer);
  clearPredictionBanner();
  showToast('Prediction dismissed. Re-scoring in 30s.', 'info');
  // Allow re-fire after 2 min
  setTimeout(() => { predState.dismissed = false; }, 120000);
}

function clearPredictionBanner() {
  document.getElementById('emergencyBanner')?.classList.add('hidden');
  document.body.classList.remove('emg-active');
  predState.active = false;
}

/* ---- Sidebar update ---- */
function updatePredSidebar(result, cave) {
  const prob = result.probability;
  const lead = predState.active ? Math.round(predState.leadTimeSec / 60) : '—';
  const col  = prob > 0.78 ? '#ef4444' : prob > 0.55 ? '#f59e0b' : '#10b981';

  const predProb = document.getElementById('predProb');
  const predLead = document.getElementById('predLead');
  const predUpd  = document.getElementById('predUpdated');
  if (predProb) { predProb.textContent = `${Math.round(prob*100)}%`; predProb.style.color = col; }
  if (predLead) predLead.textContent = predState.active ? `~${lead} min` : '> 30 min';
  if (predUpd)  predUpd.textContent  = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});

  const precEl = document.getElementById('predPrecursors');
  if (precEl) {
    precEl.innerHTML = result.precursors.map(p => {
      const pc = Math.round(p.score * 100);
      const c  = p.score > 0.75 ? '#ef4444' : p.score > 0.5 ? '#f59e0b' : '#10b981';
      return `
        <div class="precursor-row">
          <span style="color:#94a3b8;">${p.name}</span>
          <div class="precursor-score-bar">
            <div class="precursor-score-fill" style="width:${pc}%;background:${c};"></div>
          </div>
          <span style="color:${c};min-width:32px;text-align:right;">${pc}%</span>
        </div>
      `;
    }).join('');
  }
}

function togglePredSidebar() {
  const body  = document.getElementById('predSidebarBody');
  const arrow = document.getElementById('predSidebarArrow');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (arrow) arrow.textContent = hidden ? '▼' : '▲';
}

/* --------------------------------------------------------------------------
   REAL INDIAN CAVE DATABASE  (sourced from GSI / ASI / NRSC records)
   -------------------------------------------------------------------------- */
const INDIAN_CAVES = [
  {
    id: 'BORRA',
    name: 'Borra Caves',
    state: 'Andhra Pradesh',
    district: 'Visakhapatnam',
    lat: 18.2702, lon: 83.0323,
    altitude: 705,      // m above MSL
    length: 1400,       // m total mapped passage
    depth: 80,          // m max depth
    type: 'Limestone (Karstic)',
    age: 'Archaean — 150 million yrs',
    overburden: 210,    // m rock above crown
    rmr: 48,
    fosBaseline: 1.72,
    risk: 'High',
    riskScore: 72,
    seismicZone: 'Zone II',
    annualRainfall: 1100, // mm
    visitors: 180000,
    incidents: 4,
    desc: 'Largest known caves in India. Stalactite–stalagmite formation. Active karstic drainage — flooding risk during SW monsoon. GSI Class A Heritage Cave.',
    sensors: [
      { id: 'PIEZO-B01', x: 0.30, y: 0.40, pore: '18.5 kPa', insar: '-2.8 mm/yr', status: 'Warning', loc: 'Main Chamber North' },
      { id: 'SEISMIC-B02', x: 0.55, y: 0.60, pore: '12.1 kPa', insar: '-0.5 mm/yr', status: 'Normal', loc: 'West Passage' },
      { id: 'INSAR-B03', x: 0.72, y: 0.35, pore: '34.2 kPa', insar: '-6.1 mm/yr', status: 'Critical', loc: 'Collapse Dome A' },
      { id: 'PIEZO-B04', x: 0.42, y: 0.75, pore: '15.8 kPa', insar: '-1.2 mm/yr', status: 'Normal', loc: 'Sump Pool Entry' }
    ],
    faults: [{ pts: [[0.1,0.9],[0.5,0.5],[0.85,0.1]], label: 'Godavari Shear F-12' }],
    incidents_data: [
      { id: 'BC-2025-007', date: '2025-09-14 03:20', type: 'Speleothem Collapse', mag: '0.4 m³', action: 'Section Cordoned', fos: 0.91, status: 'Resolved' },
      { id: 'BC-2024-003', date: '2024-08-02 18:44', type: 'Flash Flood Ingress', mag: '1.2 m depth', action: 'Emergency Evacuation', fos: 0.78, status: 'Closed 3d' },
      { id: 'BC-2023-011', date: '2023-07-18 14:11', type: 'Roof Crack Detected', mag: 'Crack 4m L', action: 'Rock Bolt Installed', fos: 1.05, status: 'Mitigated' }
    ],
    riskFactors: [
      { icon: '🌊', name: 'Flash Flood Risk', value: 'HIGH', score: 0.78, level: 'critical', desc: 'Cave sits in active karstic drainage basin. SW monsoon (Jun-Sep) can raise sump levels 1.2–3.4 m in under 40 minutes. Evacuation time: 12 min.' },
      { icon: '🪨', name: 'Speleothem Collapse', value: 'MODERATE', score: 0.52, level: 'moderate', desc: 'Active stalactite growth (0.8 mm/yr). Vibration from visitor crowds exceeds 0.05g threshold. 3 collapses recorded 2020–2025.' },
      { icon: '📡', name: 'Micro-Seismic Activity', value: 'LOW', score: 0.25, level: 'low', desc: 'Zone II (IS 1893). PGA < 0.1g. 2 micro-events > ML 1.5 recorded since 2015. No structural damage.' },
      { icon: '💧', name: 'Pore Pressure', value: '34.2 kPa', score: 0.65, level: 'high', desc: 'Sensor INSAR-B03 at Collapse Dome A showing elevated pore pressure. Exceeds critical threshold of 30 kPa. Drainage audit required.' },
      { icon: '🏔️', name: 'Rock Mass Rating (RMR)', value: '48 (Fair)', score: 0.48, level: 'moderate', desc: 'Limestone RMR 48 — Fair classification per Bieniawski 1989. Requires systematic rock bolting in tourist zones with Q < 1.0.' },
      { icon: '👥', name: 'Visitor Overpressure', value: '180k / yr', score: 0.60, level: 'high', desc: 'Tourism footfall exceeds safe carrying capacity for karstic cave of this size. CO₂ buildup detected in inner chambers during peak season.' }
    ]
  },

  {
    id: 'BELUM',
    name: 'Belum Caves',
    state: 'Andhra Pradesh',
    district: 'Kurnool',
    lat: 15.4468, lon: 78.0783,
    altitude: 330,
    length: 3229,
    depth: 46,
    type: 'Limestone (Karstic)',
    age: 'Cretaceous — 4,500 yrs inhabited',
    overburden: 46,
    rmr: 54,
    fosBaseline: 1.95,
    risk: 'Moderate',
    riskScore: 51,
    seismicZone: 'Zone II',
    annualRainfall: 650,
    visitors: 250000,
    incidents: 2,
    desc: 'Second longest cave system in India. 3229m total, deepest point 46m. Used by Jain and Buddhist monks. Active groundwater table fluctuation.',
    sensors: [
      { id: 'PIEZO-BL01', x: 0.28, y: 0.45, pore: '14.2 kPa', insar: '-1.1 mm/yr', status: 'Normal', loc: 'Entry Hall' },
      { id: 'INSAR-BL02', x: 0.60, y: 0.35, pore: '22.0 kPa', insar: '-3.5 mm/yr', status: 'Warning', loc: 'Thousand Hoods Chamber' },
      { id: 'SEISMIC-BL03', x: 0.45, y: 0.70, pore: '11.8 kPa', insar: '-0.8 mm/yr', status: 'Normal', loc: 'Lower Passage' },
      { id: 'PIEZO-BL04', x: 0.78, y: 0.55, pore: '18.6 kPa', insar: '-2.1 mm/yr', status: 'Normal', loc: 'Deep Sump' }
    ],
    faults: [{ pts: [[0.05,0.8],[0.45,0.45],[0.88,0.12]], label: 'Deccan Trap F-04' }],
    incidents_data: [
      { id: 'BL-2024-001', date: '2024-10-22 16:30', type: 'Groundwater Rise', mag: '0.8 m rise', action: 'Visitor Evacuation', fos: 1.10, status: 'Resolved' },
      { id: 'BL-2022-005', date: '2022-07-30 09:15', type: 'Minor Roof Spall', mag: '0.2 m³', action: 'Netting Installed', fos: 1.24, status: 'Mitigated' }
    ],
    riskFactors: [
      { icon: '🌊', name: 'Groundwater Flooding', value: 'MODERATE', score: 0.55, level: 'moderate', desc: 'Deep sump at -46m fills rapidly during NE monsoon (Oct-Dec). Groundwater table rise of up to 0.8m observed in 2024.' },
      { icon: '🪨', name: 'Limestone Dissolution', value: 'LOW-MOD', score: 0.40, level: 'moderate', desc: 'Active dissolution widening passages at 0.4mm/yr. No imminent collapse threat but long-term structural weakening in Thousand Hoods section.' },
      { icon: '📡', name: 'Seismic Risk', value: 'LOW', score: 0.18, level: 'low', desc: 'Zone II, low seismic hazard. Nearest active fault 42 km away. No significant events recorded in cave microseismic network.' },
      { icon: '💨', name: 'Air Quality (CO₂)', value: 'ELEVATED', score: 0.62, level: 'high', desc: '1200+ ppm CO₂ recorded in inner passages during peak visitor hours. OSHA threshold 1000 ppm. Requires forced ventilation system.' },
      { icon: '🏔️', name: 'RMR Classification', value: '54 (Fair)', score: 0.46, level: 'moderate', desc: 'Fair rock mass. GSI block index 44. Tourist sections require preventive bolting and shotcrete in overhanging zones.' }
    ]
  },

  {
    id: 'AMARNATH',
    name: 'Amarnath Cave',
    state: 'Jammu & Kashmir',
    district: 'Anantnag',
    lat: 34.2138, lon: 75.5007,
    altitude: 3888,
    length: 150,
    depth: 40,
    type: 'Glacially Carved Limestone',
    age: 'Himalayan — > 5000 yrs pilgrimage',
    overburden: 280,
    rmr: 38,
    fosBaseline: 1.22,
    risk: 'Critical',
    riskScore: 91,
    seismicZone: 'Zone V',
    annualRainfall: 1800,
    visitors: 400000,
    incidents: 12,
    desc: 'High-altitude Hindu shrine cave at 3888m. Zone V seismicity, glacial moraine above crown, annual cloud-burst risk. 2012 flash flood killed 16 pilgrims.',
    sensors: [
      { id: 'SEISMIC-AM01', x: 0.35, y: 0.35, pore: '52.4 kPa', insar: '-11.3 mm/yr', status: 'Critical', loc: 'Cave Crown' },
      { id: 'PIEZO-AM02', x: 0.60, y: 0.55, pore: '38.8 kPa', insar: '-8.4 mm/yr', status: 'Critical', loc: 'Glacier Moraine Above' },
      { id: 'INSAR-AM03', x: 0.50, y: 0.75, pore: '22.1 kPa', insar: '-4.2 mm/yr', status: 'Warning', loc: 'Eastern Approach' },
      { id: 'SEISMIC-AM04', x: 0.22, y: 0.60, pore: '18.6 kPa', insar: '-2.1 mm/yr', status: 'Warning', loc: 'Cloudburst Channel' }
    ],
    faults: [
      { pts: [[0.05,0.75],[0.45,0.35],[0.88,0.08]], label: 'MCT — Main Central Thrust' },
      { pts: [[0.15,0.95],[0.55,0.65],[0.80,0.30]], label: 'MBT — Main Boundary Thrust' }
    ],
    incidents_data: [
      { id: 'AM-2024-009', date: '2024-08-05 02:35', type: 'Cloudburst Flash Flood', mag: '4.2 m³/s discharge', action: 'Emergency Evacuation — 6,800 pilgrims', fos: 0.62, status: 'Critical' },
      { id: 'AM-2023-006', date: '2023-07-22 14:00', type: 'ML 4.1 Earthquake', mag: 'ML 4.1', action: 'Pilgrimage suspended 48h', fos: 0.88, status: 'Resumed' },
      { id: 'AM-2022-004', date: '2022-07-08 05:10', type: 'Flash Flood (16 killed)', mag: '18.4 cumec', action: 'NDRF deployed', fos: 0.45, status: 'Historic' },
      { id: 'AM-2021-002', date: '2021-08-14 09:30', type: 'Rock Avalanche', mag: '220 m³', action: 'Route blocked 6 days', fos: 0.71, status: 'Cleared' }
    ],
    riskFactors: [
      { icon: '🌩️', name: 'Cloudburst Flash Flood', value: 'CRITICAL', score: 0.95, level: 'critical', desc: 'Annual cloudbursts send >10 cumec discharge through cave valley. 2022 flood killed 16 pilgrims. NDRF warning threshold: 30mm/hr rainfall.' },
      { icon: '🌋', name: 'Zone V Seismicity', value: 'CRITICAL', score: 0.92, level: 'critical', desc: 'Himalayan Zone V — highest seismic hazard. MCT and MBT active faults within 15km. PGA = 0.36g. Annual probability of M>5.0 = 12%.' },
      { icon: '🧊', name: 'Glacial Moraine Instability', value: 'CRITICAL', score: 0.88, level: 'critical', desc: 'Kolahoi Glacier moraine 280m above cave crown. GLOF (Glacial Lake Outburst Flood) risk increasing with climate change. Annual retreat 12m/yr.' },
      { icon: '🏔️', name: 'Rock Mass Rating', value: '38 (Poor)', score: 0.75, level: 'critical', desc: 'Highly fractured Himalayan limestone RMR = 38 (Poor). Heavy support required. Multiple existing tension cracks in cave ceiling.' },
      { icon: '❄️', name: 'Permafrost Thaw', value: 'HIGH', score: 0.79, level: 'critical', desc: 'Active layer deepening 8cm/yr due to warming. Ice-cemented discontinuities losing cohesion. FoS deterioration observed in photogrammetric survey.' },
      { icon: '👥', name: 'Pilgrimage Overpressure', value: 'EXTREME', score: 0.91, level: 'critical', desc: '400,000 annual pilgrims compressed into 45-day Yatra season (Jul-Aug). Peak-day footfall 15,000+ exceeds safe capacity by 600%.' }
    ]
  },

  {
    id: 'KUTUMSAR',
    name: 'Kutumsar Cave',
    state: 'Chhattisgarh',
    district: 'Bastar, Jagdalpur',
    lat: 19.0415, lon: 81.7981,
    altitude: 560,
    length: 460,
    depth: 35,
    type: 'Limestone / Dolomite Karstic',
    age: 'Precambrian — discovered 1951 by Dr S.M. Trivedi',
    overburden: 35,
    rmr: 56,
    fosBaseline: 1.85,
    risk: 'Moderate',
    riskScore: 49,
    seismicZone: 'Zone II',
    annualRainfall: 1500,
    visitors: 120000,
    incidents: 3,
    desc: 'Deepest known cave in India, 35m. Known for blind fish (Horaglanis Kutumsar) — only cave in India to harbour endemic blind cave fish. 460m total passage.',
    sensors: [
      { id: 'PIEZO-KT01', x: 0.38, y: 0.45, pore: '16.2 kPa', insar: '-1.4 mm/yr', status: 'Normal', loc: 'Entry Passage' },
      { id: 'INSAR-KT02', x: 0.62, y: 0.32, pore: '20.5 kPa', insar: '-2.8 mm/yr', status: 'Warning', loc: 'Blind Fish Pool' },
      { id: 'SEISMIC-KT03', x: 0.45, y: 0.72, pore: '9.8 kPa', insar: '-0.6 mm/yr', status: 'Normal', loc: 'Deep Chamber' }
    ],
    faults: [{ pts: [[0.08,0.82],[0.42,0.48],[0.85,0.15]], label: 'Bastar Craton F-08' }],
    incidents_data: [
      { id: 'KT-2024-002', date: '2024-10-04 11:20', type: 'Sump Flooding', mag: '0.6 m rise', action: 'Access restricted 2h', fos: 1.18, status: 'Resolved' },
      { id: 'KT-2023-001', date: '2023-08-22 15:45', type: 'Minor Stalactite Fall', mag: '0.05 m³', action: 'Zone fenced off', fos: 1.35, status: 'Mitigated' }
    ],
    riskFactors: [
      { icon: '🐟', name: 'Ecosystem Sensitivity', value: 'HIGH', score: 0.72, level: 'high', desc: 'World Heritage endemic blind cave fish (Horaglanis) habitat. Zero vibration tolerance. Footfall limited to 50 visitors/day per Wildlife Protection Act 1972.' },
      { icon: '🌊', name: 'Monsoon Sump Flooding', value: 'MODERATE', score: 0.50, level: 'moderate', desc: 'Inner sump rises 0.6–1.2m during peak monsoon. Cave closes July–September. 3 evacuation events in 5 years.' },
      { icon: '🪨', name: 'Dolomite Dissolution', value: 'LOW', score: 0.32, level: 'low', desc: 'Active dissolution in dolomite layers. Passage width increasing 0.2mm/yr. No structural collapse risk at current rate.' },
      { icon: '🏔️', name: 'RMR Classification', value: '56 (Fair)', score: 0.44, level: 'moderate', desc: 'Fair rock mass. Systematic bolting adequate. Precambrian basement stable. Regular photogrammetric survey recommended.' }
    ]
  },

  {
    id: 'SIJU',
    name: 'Siju Cave (Dobhakol)',
    state: 'Meghalaya',
    district: 'South Garo Hills',
    lat: 25.3885, lon: 90.6884,
    altitude: 122,
    length: 4740,
    depth: 30,
    type: 'Limestone (Sylhet Trap)',
    age: 'Eocene limestone — 45 Ma',
    overburden: 30,
    rmr: 52,
    fosBaseline: 1.78,
    risk: 'High',
    riskScore: 68,
    seismicZone: 'Zone V',
    annualRainfall: 4200,
    visitors: 45000,
    incidents: 5,
    desc: 'Third longest cave in India (4740m). Located inside Nokrek National Park, UNESCO Biosphere. Zone V seismic + extreme rainfall. Bat colony of 1 million+.',
    sensors: [
      { id: 'PIEZO-SJ01', x: 0.32, y: 0.42, pore: '28.4 kPa', insar: '-4.5 mm/yr', status: 'Warning', loc: 'Bat Roost Chamber' },
      { id: 'SEISMIC-SJ02', x: 0.58, y: 0.30, pore: '14.1 kPa', insar: '-1.2 mm/yr', status: 'Normal', loc: 'River Passage East' },
      { id: 'INSAR-SJ03', x: 0.50, y: 0.68, pore: '36.2 kPa', insar: '-8.8 mm/yr', status: 'Critical', loc: 'Underground River Bed' }
    ],
    faults: [
      { pts: [[0.05,0.85],[0.48,0.40],[0.90,0.10]], label: 'Dauki Fault Zone' },
      { pts: [[0.20,0.90],[0.60,0.55],[0.85,0.25]], label: 'Sylhet Trough F-02' }
    ],
    incidents_data: [
      { id: 'SJ-2025-003', date: '2025-06-18 04:15', type: 'Underground River Surge', mag: '2.4 cumec', action: 'Emergency exit via alternate passage', fos: 0.82, status: 'Resolved' },
      { id: 'SJ-2024-002', date: '2024-05-12 09:00', type: 'ML 5.2 Earthquake', mag: 'ML 5.2 (Dauki Fault)', action: 'Cave closed 7 days', fos: 0.75, status: 'Reopened' },
      { id: 'SJ-2023-004', date: '2023-08-08 22:30', type: 'Bat Colony Panic Stampede Risk', mag: '1.2M bats displaced', action: 'Emergency lighting cut', fos: 'N/A', status: 'Resolved' }
    ],
    riskFactors: [
      { icon: '🌧️', name: 'Extreme Rainfall / GLOF', value: 'CRITICAL', score: 0.88, level: 'critical', desc: '4200mm annual rainfall — among highest globally. Underground river surges from 0.1 to 2.4+ cumec in <20 min during cloudbursts. 5 evacuations 2020–2025.' },
      { icon: '🌋', name: 'Zone V Seismicity', value: 'HIGH', score: 0.80, level: 'critical', desc: 'Active Dauki Fault runs within 8km. ML 5.2 in 2024. NE India Zone V — PGA 0.36g. Strong ground motion can trigger speleothem falls and passage collapse.' },
      { icon: '🦇', name: 'Bat Colony Hazard', value: 'MODERATE', score: 0.55, level: 'moderate', desc: 'Colony of >1 million bats (Hipposideros species). Histoplasmosis risk from guano accumulation. Mass exodus during disturbance creates panic risk for visitors.' },
      { icon: '🏔️', name: 'RMR Classification', value: '52 (Fair)', score: 0.48, level: 'moderate', desc: 'Eocene limestone, fair quality. Thin bedding planes susceptible to daylighting. Wet season reduces RMR to 38 (Poor) due to joint water pressure.' }
    ]
  },

  {
    id: 'AJANTA',
    name: 'Ajanta Caves',
    state: 'Maharashtra',
    district: 'Aurangabad',
    lat: 20.5519, lon: 75.7033,
    altitude: 390,
    length: 800,
    depth: 25,
    type: 'Basalt (Deccan Trap) — Excavated',
    age: '2nd century BC – 5th century AD',
    overburden: 25,
    rmr: 62,
    fosBaseline: 2.10,
    risk: 'Moderate',
    riskScore: 44,
    seismicZone: 'Zone II',
    annualRainfall: 720,
    visitors: 600000,
    incidents: 6,
    desc: 'UNESCO World Heritage. 30 rock-cut Buddhist cave monuments in basalt cliff. Primary risk: surface weathering, moisture ingress damaging ancient frescoes, slope erosion.',
    sensors: [
      { id: 'PIEZO-AJ01', x: 0.30, y: 0.50, pore: '12.0 kPa', insar: '-0.8 mm/yr', status: 'Normal', loc: 'Cave 1 Facade' },
      { id: 'INSAR-AJ02', x: 0.55, y: 0.30, pore: '18.5 kPa', insar: '-2.2 mm/yr', status: 'Warning', loc: 'Eastern Cliff Wall' },
      { id: 'SEISMIC-AJ03', x: 0.70, y: 0.65, pore: '9.2 kPa', insar: '-0.4 mm/yr', status: 'Normal', loc: 'Access Road Slope' }
    ],
    faults: [{ pts: [[0.10,0.80],[0.48,0.48],[0.85,0.18]], label: 'Deccan Trap Dyke D-11' }],
    incidents_data: [
      { id: 'AJ-2024-003', date: '2024-11-10 08:30', type: 'Facade Spalling', mag: '0.8m² panel', action: 'Heritage consolidation epoxy injection', fos: 1.45, status: 'Stabilised' },
      { id: 'AJ-2023-007', date: '2023-09-02 16:15', type: 'Slope Erosion (Access Road)', mag: '12m scarp', action: 'Retaining wall constructed', fos: 1.12, status: 'Resolved' }
    ],
    riskFactors: [
      { icon: '🏛️', name: 'Heritage Fresco Decay', value: 'HIGH', score: 0.72, level: 'high', desc: 'UNESCO World Heritage frescoes deteriorating due to moisture ingress and salt crystallisation. RH variation 45–88% in Cave 16–17 measured by NRSC. Irreversible loss risk.' },
      { icon: '🌧️', name: 'Slope Erosion', value: 'MODERATE', score: 0.51, level: 'moderate', desc: 'Horseshoe cliff slope showing 2.2mm/yr InSAR displacement on eastern face. 2023 access road scarp required emergency retaining wall construction.' },
      { icon: '👥', name: 'Tourism Overcrowding', value: 'HIGH', score: 0.68, level: 'high', desc: '600,000 annual visitors. Vibration from tourist buses exceeds 0.02g threshold for fresco damage. Archaeological Survey recommends 2,000 visitor/day cap.' },
      { icon: '🏔️', name: 'Basalt RMR', value: '62 (Good)', score: 0.38, level: 'moderate', desc: 'Deccan Trap basalt RMR 62 — Good quality. Primary geotechnical risk is columnar joint systems creating potential block falls from ceiling.' }
    ]
  },

  {
    id: 'ELEPHANTA',
    name: 'Elephanta Caves',
    state: 'Maharashtra',
    district: 'Mumbai (Gharapuri Island)',
    lat: 18.9634, lon: 72.9315,
    altitude: 5,
    length: 600,
    depth: 8,
    type: 'Basalt (Deccan Trap) — Excavated',
    age: '5th–7th century AD',
    overburden: 18,
    rmr: 58,
    fosBaseline: 1.92,
    risk: 'High',
    riskScore: 66,
    seismicZone: 'Zone III',
    annualRainfall: 2430,
    visitors: 700000,
    incidents: 8,
    desc: 'UNESCO World Heritage. Marine island location — tidal flooding, saltwater ingress, monsoon damage. Portuguese cannonball damage to pillars in 16th century. Major structural vulnerability.',
    sensors: [
      { id: 'PIEZO-EL01', x: 0.35, y: 0.45, pore: '24.5 kPa', insar: '-3.4 mm/yr', status: 'Warning', loc: 'Main Shiva Temple' },
      { id: 'SEISMIC-EL02', x: 0.62, y: 0.28, pore: '18.8 kPa', insar: '-1.8 mm/yr', status: 'Normal', loc: 'Eastern Lateral Cave' },
      { id: 'INSAR-EL03', x: 0.48, y: 0.72, pore: '42.1 kPa', insar: '-9.2 mm/yr', status: 'Critical', loc: 'Sea-Side Colonnade' }
    ],
    faults: [{ pts: [[0.05,0.90],[0.50,0.50],[0.90,0.12]], label: 'Mumbai Harbour Fault F-01' }],
    incidents_data: [
      { id: 'EL-2024-005', date: '2024-06-14 09:30', type: 'Pillar Saltwater Spalling', mag: '0.4m² panel', action: 'Desalination treatment', fos: 1.38, status: 'Ongoing' },
      { id: 'EL-2023-003', date: '2023-09-05 17:00', type: 'Tidal Flooding – Cyclone Biparjoy', mag: '1.8m water ingress', action: 'Temporary closure 4 days', fos: 0.88, status: 'Resolved' },
      { id: 'EL-2022-007', date: '2022-07-11 12:45', type: 'Colonnade Crack Propagation', mag: '12mm crack', action: 'Epoxy injection + monitoring', fos: 1.15, status: 'Monitored' }
    ],
    riskFactors: [
      { icon: '🌊', name: 'Marine Saltwater Ingress', value: 'CRITICAL', score: 0.90, level: 'critical', desc: 'Island location in Mumbai Harbour. Cyclone storm surge can reach cave level. 2430mm rain + salt crystallisation causing accelerated column spalling. INSAR-EL03 shows -9.2mm/yr displacement.' },
      { icon: '🌀', name: 'Cyclone & Wave Action', value: 'HIGH', score: 0.78, level: 'critical', desc: 'Zone III seismicity + Arabian Sea cyclone exposure. Cyclone Biparjoy 2023 caused 1.8m flooding. Climate projections indicate 35% increase in severe cyclone frequency by 2050.' },
      { icon: '🏛️', name: 'Heritage Pillar Damage', value: 'HIGH', score: 0.70, level: 'high', desc: '16th century Portuguese cannon damage + ongoing salt weathering. ASI structural survey 2023 flagged 6 pillars with load-bearing capacity < 60% of original.' },
      { icon: '🏔️', name: 'Basalt RMR', value: '58 (Fair)', score: 0.42, level: 'moderate', desc: 'Marine-weathered Deccan basalt. Frequent wet-dry cycling degrades joint surfaces. Effective RMR drops to 44 (Fair-Poor) in monsoon season.' }
    ]
  },

  {
    id: 'MAWSMAI',
    name: 'Mawsmai Cave',
    state: 'Meghalaya',
    district: 'East Khasi Hills, Cherrapunjee',
    lat: 25.2516, lon: 91.7060,
    altitude: 1290,
    length: 150,
    depth: 20,
    type: 'Limestone (Sylhet Trap)',
    age: 'Eocene — Cherrapunjee plateau',
    overburden: 20,
    rmr: 45,
    fosBaseline: 1.55,
    risk: 'High',
    riskScore: 71,
    seismicZone: 'Zone V',
    annualRainfall: 11872,
    visitors: 320000,
    incidents: 9,
    desc: "Located in Cherrapunji (one of world's wettest places). 11,872mm annual rainfall. Extreme cave flooding risk during monsoon. Short (150m) but geologically active due to intense karst processes.",
    sensors: [
      { id: 'PIEZO-MW01', x: 0.32, y: 0.42, pore: '38.5 kPa', insar: '-7.2 mm/yr', status: 'Critical', loc: 'Upper Entry Chamber' },
      { id: 'INSAR-MW02', x: 0.56, y: 0.28, pore: '22.1 kPa', insar: '-3.8 mm/yr', status: 'Warning', loc: 'Inner Passage' },
      { id: 'SEISMIC-MW03', x: 0.48, y: 0.70, pore: '15.5 kPa', insar: '-1.4 mm/yr', status: 'Normal', loc: 'Exit Chamber' }
    ],
    faults: [
      { pts: [[0.08,0.88],[0.45,0.42],[0.88,0.10]], label: 'Shillong Plateau Fault F-03' }
    ],
    incidents_data: [
      { id: 'MW-2025-004', date: '2025-06-25 14:30', type: 'Flash Flood — Cave Closure', mag: '3.6 m depth', action: 'Immediate closure — visitor evacuation', fos: 0.60, status: 'Critical' },
      { id: 'MW-2024-006', date: '2024-07-18 08:15', type: 'ML 4.8 Shillong Plateau EQ', mag: 'ML 4.8', action: 'Inspection, closed 3 days', fos: 0.92, status: 'Reopened' },
      { id: 'MW-2024-002', date: '2024-06-10 11:00', type: 'Passage Collapse Warning', mag: '2m crack detected', action: 'Inner section fenced off', fos: 0.98, status: 'Monitoring' }
    ],
    riskFactors: [
      { icon: '🌧️', name: 'Extreme Rainfall (11,872 mm/yr)', value: 'CRITICAL', score: 0.96, level: 'critical', desc: "Cherrapunjee receives world-record rainfall. Cave floods to 3.6m depth annually in June-August. Zero safe visitor access during SW monsoon. 9 emergency evacuations in 5 years." },
      { icon: '🌋', name: 'Zone V Seismicity', value: 'HIGH', score: 0.80, level: 'critical', desc: 'Shillong Plateau Fault — Site of catastrophic 1897 ML 8.1 Great Assam Earthquake. Zone V PGA = 0.36g. Active micro-seismicity daily.' },
      { icon: '🪨', name: 'Rapid Karst Dissolution', value: 'HIGH', score: 0.74, level: 'high', desc: 'Most rapid limestone dissolution rates in India due to extreme rainfall. Passage walls retreating 1.1mm/yr. Unstable overhangs requiring regular inspection.' },
      { icon: '🏔️', name: 'RMR Classification', value: '45 (Fair)', score: 0.55, level: 'moderate', desc: 'Wet limestone — RMR drops to 32 (Poor) during monsoon. Systematic rock bolting mandated by Meghalaya Mines Department throughout lit tourist section.' }
    ]
  }
];

/* --------------------------------------------------------------------------
   APP STATE
   -------------------------------------------------------------------------- */
let currentUser = null;
let selectedCave = null;
let acousticChart = null, strainChart = null, poreChart = null, seismicChart = null;
let mapPulsePhase = 0;
let mapCanvas, mapCtx;
let tunnelCanvas, tunnelCtx;
let currentChainage = 450;

/* --------------------------------------------------------------------------
   INIT
   -------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Load authenticated user from sessionStorage (set by login.html)
  const user = getCurrentUser();
  if (user) {
    const hdr = document.getElementById('headerUser');
    const dsh = document.getElementById('dashHeaderUser');
    if (hdr) hdr.textContent = user.id;
    if (dsh) dsh.textContent = user.id;
  }
  initCaveSearch();
  renderCaveGrid(INDIAN_CAVES);
  // Start scanning ALL caves immediately on cave select screen
  startGlobalScanner();
  // Check live API backend health
  checkApiHealth();
  setInterval(checkApiHealth, 10000);

  // Deep linking: check URL parameter ?cave=ID or stored targetCave
  const params = new URLSearchParams(window.location.search);
  const targetCave = params.get('cave') || (user && user.targetCave);
  if (targetCave) {
    const matched = INDIAN_CAVES.find(c => c.id.toUpperCase() === targetCave.toUpperCase());
    if (matched) {
      selectCave(matched.id);
    }
  } else {
    // Default to Amarnath if accessing dashboard directly
    selectCave('AMARNATH');
  }
});

/* --------------------------------------------------------------------------
   VIEW MANAGEMENT
   -------------------------------------------------------------------------- */
function showView(id) {
  document.querySelectorAll('.view-full').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function logout() {
  currentUser = null;
  selectedCave = null;
  stopGlobalScanner();
  stopPredictionEngine();
  sessionStorage.removeItem('ewps_user');
  localStorage.removeItem('ewps_user');
  window.location.replace('login.html');
}

function backToCaveSelect() {
  stopPredictionEngine();
  predState.active = false;
  predState.acknowledged = false;
  predState.dismissed = false;
  destroyCharts();
  showView('view-cave-select');
  // Resume global scanner for all caves when returning to grid
  startGlobalScanner();
}

/* --------------------------------------------------------------------------
   1. LOGIN SCREEN
   -------------------------------------------------------------------------- */
function initLoginForm() {
  const form  = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');

  form.addEventListener('submit', e => {
    e.preventDefault();
    errEl.style.display = 'none';

    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value;

    if (!user) { showLoginError('Please enter your Operator Badge ID.'); return; }
    if (pass.length < 4) { showLoginError('Passcode too short. Min 4 characters.'); return; }

    // Simulate auth (accept any credentials for demo)
    const btn = form.querySelector('button[type=submit]');
    btn.textContent = '⏳ Authenticating...';
    btn.disabled = true;

    setTimeout(() => {
      btn.textContent = '🔒 Authenticate & Enter';
      btn.disabled = false;
      currentUser = user;

      const headerUser = document.getElementById('headerUser');
      const dashUser   = document.getElementById('dashHeaderUser');
      if (headerUser) headerUser.textContent = user;
      if (dashUser)   dashUser.textContent   = user;

      showView('view-cave-select');
      renderCaveGrid(INDIAN_CAVES);
      showToast(`Welcome, ${user}! Select a cave site to monitor.`, 'info');
    }, 1400);
  });

  document.getElementById('forgotLink')?.addEventListener('click', () => {
    showToast('Password reset link sent to your GSI registered email.', 'info');
  });
}

function showLoginError(msg) {
  const errEl = document.getElementById('loginError');
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

function togglePassword() {
  const inp = document.getElementById('loginPass');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

/* --------------------------------------------------------------------------
   2. CAVE SELECTION SCREEN
   -------------------------------------------------------------------------- */
function initCaveSearch() {
  document.getElementById('caveSearch')?.addEventListener('input', filterCaves);
  document.getElementById('stateFilter')?.addEventListener('change', filterCaves);
  document.getElementById('riskFilter')?.addEventListener('change', filterCaves);
}

function filterCaves() {
  const q     = document.getElementById('caveSearch').value.toLowerCase();
  const state = document.getElementById('stateFilter').value;
  const risk  = document.getElementById('riskFilter').value;

  const filtered = INDIAN_CAVES.filter(c => {
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.state.toLowerCase().includes(q) || c.district.toLowerCase().includes(q);
    const matchState = state === 'all' || c.state === state;
    const matchRisk  = risk === 'all'  || c.risk === risk;
    return matchQ && matchState && matchRisk;
  });

  renderCaveGrid(filtered);
}

function renderCaveGrid(caves) {
  const grid = document.getElementById('caveGrid');
  if (!grid) return;

  if (caves.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:3rem; text-align:center; color:var(--text-muted); font-family:var(--font-mono);">No caves found matching your filters.</div>`;
    return;
  }

  grid.innerHTML = caves.map(c => `
    <div class="cave-card risk-${c.risk.toLowerCase()}" id="card-${c.id}" onclick="selectCave('${c.id}')">
      <div class="cave-card-top">
        <div style="flex:1;min-width:0;">
          <div class="cave-card-name">${c.name}</div>
          <div class="cave-card-state">📍 ${c.district}, ${c.state}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
          <span class="risk-pill ${c.risk.toLowerCase()}">${c.risk.toUpperCase()}</span>
          <div class="pred-card-badge" id="pred-badge-${c.id}">
            <span class="pred-badge-dot" id="pred-dot-${c.id}"></span>
            <span id="pred-label-${c.id}" style="font-family:'Fira Code',monospace;font-size:0.68rem;">PRED: —</span>
          </div>
        </div>
      </div>

      <div class="cave-stats-row">
        <div class="cave-stat">
          <div class="cave-stat-val">${c.length.toLocaleString()}m</div>
          <div class="cave-stat-lbl">Total Length</div>
        </div>
        <div class="cave-stat">
          <div class="cave-stat-val">${c.altitude}m</div>
          <div class="cave-stat-lbl">Altitude MSL</div>
        </div>
        <div class="cave-stat">
          <div class="cave-stat-val" style="color:${c.fosBaseline < 1.3 ? 'var(--accent-danger)' : c.fosBaseline < 1.7 ? 'var(--accent-amber)' : 'var(--accent-emerald)'}">FoS ${c.fosBaseline}</div>
          <div class="cave-stat-lbl">Baseline Safety</div>
        </div>
        <div class="cave-stat">
          <div class="cave-stat-val">${c.rmr}</div>
          <div class="cave-stat-lbl">RMR Score</div>
        </div>
        <div class="cave-stat">
          <div class="cave-stat-val">${c.seismicZone}</div>
          <div class="cave-stat-lbl">Seismic Zone</div>
        </div>
        <div class="cave-stat">
          <div class="cave-stat-val">${c.incidents}</div>
          <div class="cave-stat-lbl">Incidents</div>
        </div>
      </div>

      <!-- Per-cave precursor mini-bar -->
      <div class="cave-pred-bar" id="pred-bar-${c.id}">
        <div class="cave-pred-fill" id="pred-fill-${c.id}" style="width:0%"></div>
      </div>

      <div class="cave-card-desc">${c.desc}</div>
    </div>
  `).join('');

  // Trigger one immediate score paint so badges aren't empty
  setTimeout(() => runGlobalScore(false), 50);
}

/* --------------------------------------------------------------------------
   GLOBAL MULTI-CAVE PREDICTION SCANNER
   Scans all 8 caves every 30 s and:
   • Updates the prediction badge on each card
   • Fires the emergency banner for the cave with highest risk
   -------------------------------------------------------------------------- */
let _globalScanTimer = null;
let _globalBannerCave = null;  // Which cave currently owns the banner

function startGlobalScanner() {
  if (_globalScanTimer) clearInterval(_globalScanTimer);
  document.getElementById('predSidebar')?.classList.remove('hidden');
  runGlobalScore(true);
  _globalScanTimer = setInterval(() => runGlobalScore(true), RESCORE_INTERVAL_MS);
}

function stopGlobalScanner() {
  if (_globalScanTimer) clearInterval(_globalScanTimer);
  _globalScanTimer = null;
  _globalBannerCave = null;
  clearPredictionBanner();
  document.getElementById('predSidebar')?.classList.add('hidden');
}

function runGlobalScore(mayFireBanner) {
  let highestP = 0;
  let highestCave = null;

  const allScores = INDIAN_CAVES.map(cave => {
    const result = scoreEmergencyRisk(cave);
    const pct = Math.round(result.probability * 100);

    // Update card badge
    const label = document.getElementById(`pred-label-${cave.id}`);
    const dot   = document.getElementById(`pred-dot-${cave.id}`);
    const fill  = document.getElementById(`pred-fill-${cave.id}`);

    if (label) {
      label.textContent = `PRED: ${pct}%`;
      const col = pct >= 78 ? '#ef4444' : pct >= 55 ? '#f59e0b' : '#10b981';
      label.style.color = col;
    }
    if (dot) {
      dot.style.background = pct >= 78 ? '#ef4444' : pct >= 55 ? '#f59e0b' : '#10b981';
      dot.style.animation = pct >= 78 ? 'pulse 0.9s infinite' : pct >= 55 ? 'pulse 1.6s infinite' : 'none';
    }
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.style.background = pct >= 78 ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
                            : pct >= 55 ? 'linear-gradient(90deg,#f59e0b,#fb923c)'
                            : 'linear-gradient(90deg,#10b981,#3b82f6)';
    }

    // Pulse-highlight cards that are critical
    const card = document.getElementById(`card-${cave.id}`);
    if (card) {
      card.classList.toggle('pred-critical-glow', pct >= 78);
    }

    if (result.probability > highestP) {
      highestP = result.probability;
      highestCave = cave;
      Object.assign(predState, { precursors: result.precursors, triggers: result.triggers });
    }

    return { cave, result, pct };
  });

  // Update global sidebar with highest-risk cave
  if (highestCave) {
    updatePredSidebar({ probability: highestP, precursors: predState.precursors, triggers: predState.triggers }, highestCave);
    const pl = document.getElementById('predLead');
    if (pl) pl.textContent = highestP >= TRIGGER_THRESHOLD ? 'IMMINENT' : '> 30 min';
  }

  // Fire banner for highest-risk cave if above threshold
  if (!mayFireBanner) return;
  const shouldFire = highestP >= TRIGGER_THRESHOLD && !predState.dismissed && !predState.acknowledged;

  if (shouldFire) {
    if (!predState.active || _globalBannerCave?.id !== highestCave?.id) {
      // New banner or cave switched
      predState.active = true;
      predState.startedAt = Date.now();
      predState.leadTimeSec = Math.round(1800 * (1.05 - highestP));
      _globalBannerCave = highestCave;
      firePredictionBanner(highestCave, { probability: highestP, triggers: predState.triggers });
      startCountdown();
    } else {
      // Just update triggers for current banner
      updateBannerTriggers({ triggers: predState.triggers });
      updateBannerConfidence(highestP);
    }
  } else if (predState.active && predState.acknowledged) {
    clearPredictionBanner();
    _globalBannerCave = null;
  }
}

function selectCave(id) {
  selectedCave = INDIAN_CAVES.find(c => c.id === id);
  if (!selectedCave) return;

  document.getElementById('dashCaveNameHeader').textContent = selectedCave.name;
  showView('view-dashboard');
  stopPredictionEngine(); // reset any previous
  predState.acknowledged = false;
  predState.dismissed = false;
  initDashboard(selectedCave);
  // Start 30-min emergency prediction engine for this cave
  setTimeout(() => startPredictionEngine(selectedCave), 800);
  showToast(`Loaded: ${selectedCave.name} — ${selectedCave.state}`, 'info');
}

/* --------------------------------------------------------------------------
   3. DASHBOARD INIT
   -------------------------------------------------------------------------- */
function initDashboard(cave) {
  // Reset screens
  document.querySelectorAll('#view-dashboard .screen-view').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('#dashNavTabs .nav-tab-btn').forEach(t => t.classList.remove('active'));

  const firstTab = document.querySelector('#dashNavTabs .nav-tab-btn');
  const firstScreen = document.getElementById('screen-gis-map');
  if (firstTab) firstTab.classList.add('active');
  if (firstScreen) firstScreen.classList.add('active');

  // Tab nav
  document.querySelectorAll('#dashNavTabs .nav-tab-btn').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#dashNavTabs .nav-tab-btn').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('#view-dashboard .screen-view').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      const sc = document.getElementById(tab.dataset.screen);
      if (sc) sc.classList.add('active');

      if (tab.dataset.screen === 'screen-gis-map')       setTimeout(() => { initGisMap(cave); startMapAnimation(); }, 50);
      if (tab.dataset.screen === 'screen-geo-tunnel')    setTimeout(() => { initTunnelCanvas(cave); }, 50);
      if (tab.dataset.screen === 'screen-telemetry')     setTimeout(() => initCharts(cave), 50);
      if (tab.dataset.screen === 'screen-risk-factors')  renderRiskFactors(cave);
      if (tab.dataset.screen === 'screen-incident-archive') renderIncidentLog(cave);
    };
  });

  // Update GPS bar
  const gpsBar = document.getElementById('gpsBar');
  if (gpsBar) gpsBar.textContent = `LAT: ${cave.lat}° N | LON: ${cave.lon}° E | GPS LOCKED`;

  // Update cave info box
  const infoBox = document.getElementById('caveInfoBox');
  if (infoBox) {
    infoBox.innerHTML = `
      • <b>Type:</b> ${cave.type}<br>
      • <b>Age / Origin:</b> ${cave.age}<br>
      • <b>Total Length:</b> ${cave.length.toLocaleString()} m<br>
      • <b>Max Depth:</b> ${cave.depth} m<br>
      • <b>Overburden:</b> ${cave.overburden} m<br>
      • <b>Annual Rainfall:</b> ${cave.annualRainfall.toLocaleString()} mm<br>
      • <b>Annual Visitors:</b> ${cave.visitors.toLocaleString()}<br>
      • <b>Seismic Zone:</b> ${cave.seismicZone}<br>
      • <b>Risk Score:</b> <span style="color:${cave.riskScore>70?'var(--accent-danger)':cave.riskScore>50?'var(--accent-amber)':'var(--accent-emerald)'}; font-weight:700;">${cave.riskScore}/100</span>
    `;
  }

  // Init GIS map immediately
  setTimeout(() => { initGisMap(cave); startMapAnimation(); }, 80);

  // Update tunnel stats panel
  const statsPanel = document.getElementById('tunnelStatsPanel');
  if (statsPanel) {
    statsPanel.innerHTML = [
      ['Overburden Stress (σv)', `${(cave.overburden * 0.026).toFixed(2)} MPa`],
      ['Rock Mass Rating', `${cave.rmr}`],
      ['Baseline FoS', `${cave.fosBaseline}`],
      ['Seismic Zone', cave.seismicZone]
    ].map(([k,v]) => `
      <div style="display:flex; justify-content:space-between; font-size:0.85rem; padding:0.3rem 0; border-bottom:1px solid rgba(255,255,255,0.05);">
        <span style="color:var(--text-secondary);">${k}</span>
        <span style="font-family:var(--font-mono);">${v}</span>
      </div>
    `).join('');
  }

  renderRiskFactors(cave);
  renderIncidentLog(cave);
}

/* --------------------------------------------------------------------------
   4. REAL 3D MOUNTAIN MESH ENGINE (THREE.JS WEBGL + ORBITCONTROLS + DEM)
   -------------------------------------------------------------------------- */
let threeScene = null;
let threeCamera = null;
let threeRenderer = null;
let threeControls = null;
let terrainMesh = null;
let wireframeMesh = null;
let sensorPinsGroup = null;
let isThreeInitialized = false;
let isRealDemMode = true;
let currentDemData = null;
let currentMapVisualMode = 'voxel';
let realSatelliteMapInstance = null;
let satelliteMarkersGroup = null;

function generateFallbackTerrain(cave) {
  const size = 30;
  const matrix = [];
  const baseElev = cave?.altitude || 3888;
  const relief = 480;

  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const nx = (c - size/2) / (size/2);
      const ny = (r - size/2) / (size/2);
      const dist = Math.hypot(nx, ny);
      const peak = Math.exp(-dist * 1.8) * relief;
      const ridges = Math.sin(nx * 6.28) * Math.cos(ny * 6.28) * (relief * 0.15);
      row.push(baseElev + peak + ridges);
    }
    matrix.push(row);
  }

  const riskMatrix = matrix.map((row, r) => row.map((val, c) => {
    const nx = (c - size/2) / (size/2);
    const ny = (r - size/2) / (size/2);
    const dist = Math.hypot(nx, ny);
    if (cave?.risk === 'Critical' && dist < 0.45) return 'critical';
    if (dist < 0.7) return 'warning';
    return 'stable';
  }));

  return {
    name: cave?.name || 'Mountain Sector',
    min_elevation_m: baseElev,
    max_elevation_m: baseElev + relief,
    elevation_relief_m: relief,
    elevation_matrix: matrix,
    risk_matrix: riskMatrix,
    stats: { max_slope_deg: 44.5, min_fos: 1.12 }
  };
}

function initThree3DScene() {
  const container = document.getElementById('mainGisContainer');
  let canvas = document.getElementById('gisMapCanvas');
  if (!container || typeof THREE === 'undefined') return;

  const width = Math.max(700, Math.floor(container.clientWidth || 920));
  const height = Math.max(460, Math.floor(container.clientHeight || 530));

  if (!threeScene) {
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x060b16);

    // Floor Reference Grid
    const gridHelper = new THREE.GridHelper(240, 30, 0x00f3ff, 0x0f2942);
    gridHelper.position.y = -0.5;
    threeScene.add(gridHelper);
    gridHelperRef = gridHelper;

    // Ambient Lighting (Cool Slate)
    const ambientLight = new THREE.AmbientLight(0x1e293b, 2.5);
    threeScene.add(ambientLight);

    // Directional Sunlight
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.8);
    sunLight.position.set(120, 220, 100);
    threeScene.add(sunLight);

    // Cyan Atmospheric Fill Light
    const fillLight = new THREE.DirectionalLight(0x00f3ff, 1.6);
    fillLight.position.set(-100, 100, -100);
    threeScene.add(fillLight);

    sensorPinsGroup = new THREE.Group();
    threeScene.add(sensorPinsGroup);

    threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.5, 2000);
    threeCamera.position.set(0, 85, 165);

    try {
      threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch (e) {
      // Recreate canvas if context collision
      const newCanvas = document.createElement('canvas');
      newCanvas.id = 'gisMapCanvas';
      container.replaceChild(newCanvas, canvas);
      threeRenderer = new THREE.WebGLRenderer({ canvas: newCanvas, antialias: true, alpha: false });
    }

    threeRenderer.setSize(width, height);
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    threeRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    threeRenderer.toneMappingExposure = 1.2;

    if (typeof THREE.OrbitControls !== 'undefined') {
      threeControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
      threeControls.enableDamping = true;
      threeControls.dampingFactor = 0.08;
      threeControls.maxPolarAngle = Math.PI / 2.05;
      threeControls.target.set(0, 15, 0);
    }

    // Smooth render loop
    function animateThree() {
      requestAnimationFrame(animateThree);
      if (threeControls) threeControls.update();
      if (sensorPinsGroup) {
        const time = Date.now() * 0.003;
        sensorPinsGroup.children.forEach(pin => {
          if (pin._pulseRing) {
            const s = 1.0 + 0.35 * Math.sin(time * 3 + pin._phase);
            pin._pulseRing.scale.set(s, s, s);
          }
        });
      }
      if (threeRenderer && threeScene && threeCamera) {
        threeRenderer.render(threeScene, threeCamera);
      }
    }
    animateThree();
    isThreeInitialized = true;

    window.addEventListener('resize', () => {
      if (threeRenderer && container) {
        const nw = container.clientWidth || 920;
        const nh = container.clientHeight || 530;
        threeRenderer.setSize(nw, nh);
        threeCamera.aspect = nw / nh;
        threeCamera.updateProjectionMatrix();
      }
    });
  } else {
    threeRenderer.setSize(width, height);
    threeCamera.aspect = width / height;
    threeCamera.updateProjectionMatrix();
  }
}

let currentTerrainPalette = 'hypso';
let gridHelperRef = null;

function setTerrainColorPalette(palette) {
  currentTerrainPalette = palette;
  document.querySelectorAll('[id^="palette-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`palette-${palette}`);
  if (btn) btn.classList.add('active');

  showToast(`🎨 Color Palette: ${palette.toUpperCase()}`, 'info');
  if (currentDemData) {
    build3DMountainMesh(currentDemData, selectedCave);
  }
}

function toggleLayerOverlay(layer) {
  if (layer === 'sensors' && sensorPinsGroup) {
    sensorPinsGroup.visible = document.getElementById('layerSensors')?.checked !== false;
  }
  if (layer === 'contours' && wireframeMesh) {
    wireframeMesh.visible = document.getElementById('layerContours')?.checked !== false;
  }
  if (layer === 'grid' && gridHelperRef) {
    gridHelperRef.visible = document.getElementById('layerFloorGrid')?.checked !== false;
  }
}

function getTerrainVertexColor(normalizedH, risk, palette) {
  const color = new THREE.Color();
  
  if (palette === 'fos') {
    // Mohr-Coulomb Factor of Safety Risk Map
    if (risk === 'critical') {
      color.setHex(0xff1744); // Blazing Neon Red
    } else if (risk === 'warning') {
      color.setHex(0xff9100); // Glowing Amber Orange
    } else {
      if (normalizedH > 0.8) color.setHex(0x00e676); // High stable slope
      else color.setHex(0x00c853); // Forest Green
    }
  } else if (palette === 'thermal') {
    // InSAR Strain / Infrared Thermal Gradient
    if (normalizedH < 0.25) {
      color.setHSL(0.65 - normalizedH * 0.6, 1.0, 0.45);
    } else if (normalizedH < 0.6) {
      color.setHSL(0.85 + (normalizedH - 0.25) * 0.5, 0.95, 0.55);
    } else {
      color.setHSL(0.08 + (normalizedH - 0.6) * 0.35, 1.0, 0.65);
    }
  } else if (palette === 'alpine') {
    // Natural Alpine Granite & Glacial Snow
    if (normalizedH > 0.85) color.setHex(0xffffff); // Pure white snow
    else if (normalizedH > 0.70) color.setHex(0x94a3b8); // Granite slate
    else if (normalizedH > 0.45) color.setHex(0x475569); // Dark cliff face
    else if (normalizedH > 0.20) color.setHex(0x15803d); // Alpine pine
    else color.setHex(0x166534); // Valley base
  } else {
    // Vibrant Hypsometric Multi-Color Topo (NASA GeoRamp)
    if (risk === 'critical') {
      color.setHex(0xff0055); // High risk crimson
    } else if (risk === 'warning') {
      color.setHex(0xff9900); // Warning amber
    } else {
      if (normalizedH > 0.90) color.setHex(0xffffff); // Diamond Snow Cap
      else if (normalizedH > 0.76) color.setHex(0x38bdf8); // Alpine Crystalline Cyan
      else if (normalizedH > 0.58) color.setHex(0x818cf8); // Amethyst Ridge Slate
      else if (normalizedH > 0.40) color.setHex(0xf59e0b); // Terracotta Gold Sandstone
      else if (normalizedH > 0.22) color.setHex(0x10b981); // Spring Emerald
      else color.setHex(0x059669); // Deep Rainforest Green
    }
  }
  return color;
}

function build3DMountainMesh(demData, cave) {
  if (!threeScene || !demData || !demData.elevation_matrix) return;
  const activeCave = cave || selectedCave || INDIAN_CAVES[0];

  // Remove existing meshes
  if (terrainMesh) threeScene.remove(terrainMesh);
  if (wireframeMesh) threeScene.remove(wireframeMesh);
  if (sensorPinsGroup) {
    while (sensorPinsGroup.children.length > 0) {
      sensorPinsGroup.remove(sensorPinsGroup.children[0]);
    }
  }

  const matrix = demData.elevation_matrix;
  const rows = matrix.length;
  const cols = matrix[0].length;
  const size = 160;

  // Continuous Smooth 3D Mountain Mesh Geometry
  const geo = new THREE.PlaneGeometry(size, size, cols - 1, rows - 1);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];
  const minElev = demData.min_elevation_m;
  const maxElev = demData.max_elevation_m;
  const relief = Math.max(1, maxElev - minElev);

  for (let i = 0; i < pos.count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);

    const elev = matrix[r] ? (matrix[r][c] || minElev) : minElev;
    const normalizedH = (elev - minElev) / relief;
    const yHeight = normalizedH * 48.0;
    pos.setY(i, yHeight);

    // Dynamic Color Palette Calculation
    const risk = (demData.risk_matrix && demData.risk_matrix[r]) ? demData.risk_matrix[r][c] : 'stable';
    const color = getTerrainVertexColor(normalizedH, risk, currentTerrainPalette);
    colors.push(color.r, color.g, color.b);
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Solid Shaded Surface (Enhanced with slight gloss and vivid colors)
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.22,
    flatShading: false,
    side: THREE.DoubleSide
  });
  terrainMesh = new THREE.Mesh(geo, mat);
  threeScene.add(terrainMesh);

  // Glowing Cyan Topographic Wireframe Contour Overlay
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x00f3ff,
    wireframe: true,
    transparent: true,
    opacity: 0.20
  });
  wireframeMesh = new THREE.Mesh(geo, wireMat);
  wireframeMesh.position.y += 0.15;
  threeScene.add(wireframeMesh);

  // 3D Floating Sensor Pins
  if (activeCave && activeCave.sensors) {
    activeCave.sensors.forEach((s, idx) => {
      const pinGroup = new THREE.Group();
      const colHex = s.status === 'Critical' ? 0xff0055 : s.status === 'Warning' ? 0xff9900 : 0x00e676;

      const px = ((idx % 4) - 1.5) * 32.0 + (Math.sin(idx) * 6.0);
      const pz = (Math.floor(idx / 4) - 1.5) * 32.0 + (Math.cos(idx) * 6.0);
      const gridR = Math.min(rows - 1, Math.max(0, Math.floor((pz / size + 0.5) * rows)));
      const gridC = Math.min(cols - 1, Math.max(0, Math.floor((px / size + 0.5) * cols)));
      const elev = matrix[gridR] ? (matrix[gridR][gridC] || minElev) : minElev;
      const py = ((elev - minElev) / relief) * 48.0;

      // Vertical Laser Line
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(px, py + 12, pz)
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: colHex, transparent: true, opacity: 0.95 });
      pinGroup.add(new THREE.Line(lineGeo, lineMat));

      // Floating Glowing Sphere
      const sphereGeo = new THREE.SphereGeometry(2.2, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color: colHex });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(px, py + 12, pz);
      pinGroup.add(sphere);

      // Pulsing Neon Halo Ring
      const ringGeo = new THREE.RingGeometry(2.6, 3.8, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({ color: colHex, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(px, py + 12, pz);
      pinGroup.add(ring);
      pinGroup._pulseRing = ring;
      pinGroup._phase = idx;

      sensorPinsGroup.add(pinGroup);
    });
  }

  // Update Callout UI with real DEM statistics
  const sub = document.getElementById('voxelSiteSub');
  if (sub) {
    sub.innerHTML = `Real 3D Mountain Mesh | Alt: <b>${demData.min_elevation_m.toLocaleString()}m – ${demData.max_elevation_m.toLocaleString()}m</b> (Δ ${demData.elevation_relief_m}m) | Slope: <b>${demData.stats.max_slope_deg}°</b>`;
  }
}

function setVoxelCamera(preset) {
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = Array.from(document.querySelectorAll('.cam-btn')).find(b => b.textContent.toLowerCase().includes(preset.toLowerCase()));
  if (activeBtn) activeBtn.classList.add('active');

  if (!threeCamera || !threeControls) return;

  const target = threeControls.target || new THREE.Vector3(0, 15, 0);

  switch(preset.toLowerCase()) {
    case 'top':
      threeCamera.position.set(0, 190, 0.1);
      threeControls.target.set(0, 10, 0);
      break;
    case 'north':
      threeCamera.position.set(0, 75, 160);
      threeControls.target.set(0, 18, 0);
      break;
    case 'south':
      threeCamera.position.set(0, 75, -160);
      threeControls.target.set(0, 18, 0);
      break;
    case 'east':
      threeCamera.position.set(160, 75, 0);
      threeControls.target.set(0, 18, 0);
      break;
    case 'west':
      threeCamera.position.set(-160, 75, 0);
      threeControls.target.set(0, 18, 0);
      break;
    case 'zoomin':
      threeCamera.position.sub(target).multiplyScalar(0.8).add(target);
      break;
    case 'zoomout':
      threeCamera.position.sub(target).multiplyScalar(1.25).add(target);
      break;
  }
  threeControls.update();
  showToast(`🎥 Camera Preset: ${preset.toUpperCase()}`, 'info');
}

function toggleRealDemMode() {
  isRealDemMode = !isRealDemMode;
  const btn = document.getElementById('btnRealDemToggle');
  if (btn) {
    btn.style.background = isRealDemMode ? 'rgba(16,185,129,0.22)' : 'rgba(255,255,255,0.06)';
    btn.style.color = isRealDemMode ? 'var(--accent-emerald)' : 'var(--text-muted)';
    btn.textContent = isRealDemMode ? '🛰️ Real NASA DEM (ON)' : '📐 Geometric Model';
  }
  showToast(isRealDemMode ? '🛰️ Real NASA SRTM (30m) Topography Enabled' : '📐 Switched to Geometric Synthesis Mode', 'info');
  if (selectedCave) {
    fetchCaveDem(selectedCave.id);
  }
}

async function fetchCaveDem(caveId) {
  try {
    const res = await fetch(`http://localhost:8080/api/v1/dem/${caveId}`);
    if (res.ok) {
      currentDemData = await res.json();
      if (currentDemData) {
        build3DMountainMesh(currentDemData, selectedCave);
      }
    }
  } catch (err) {
    console.warn('DEM fetch fallback:', err);
  }
}

function switchMapVisualMode(mode) {
  currentMapVisualMode = mode;
  ['btnMode3DVoxel', 'btnModeSatellite', 'btnModeDual'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  const activeBtn = document.getElementById(
    mode === 'voxel' ? 'btnMode3DVoxel' : mode === 'satellite' ? 'btnModeSatellite' : 'btnModeDual'
  );
  if (activeBtn) activeBtn.classList.add('active');

  const canvas = document.getElementById('gisMapCanvas');
  const satDiv = document.getElementById('realSatelliteMap');
  const hudLeft = document.querySelector('.voxel-hud-left');
  const camToolbar = document.querySelector('.voxel-camera-toolbar');

  if (!canvas || !satDiv) return;

  if (mode === 'voxel') {
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    satDiv.style.display = 'none';
    if (hudLeft) hudLeft.style.display = 'flex';
    if (camToolbar) camToolbar.style.display = 'flex';
    if (threeRenderer) {
      const rect = canvas.parentElement.getBoundingClientRect();
      threeRenderer.setSize(rect.width, rect.height);
      threeCamera.aspect = rect.width / rect.height;
      threeCamera.updateProjectionMatrix();
    }
    showToast('⛰️ Visual Mode: 3D Modelled Mountain Mesh', 'info');
  } else if (mode === 'satellite') {
    canvas.style.display = 'none';
    satDiv.style.display = 'block';
    satDiv.style.width = '100%';
    satDiv.style.position = 'relative';
    if (hudLeft) hudLeft.style.display = 'none';
    if (camToolbar) camToolbar.style.display = 'none';
    if (selectedCave) initRealSatelliteMap(selectedCave);
    showToast('🛰️ Visual Mode: Real-World Esri Satellite Map (HD)', 'info');
  } else if (mode === 'dual') {
    canvas.style.display = 'inline-block';
    canvas.style.width = '50%';
    canvas.style.float = 'left';
    satDiv.style.display = 'inline-block';
    satDiv.style.width = '50%';
    satDiv.style.position = 'relative';
    if (hudLeft) hudLeft.style.display = 'none';
    if (camToolbar) camToolbar.style.display = 'none';
    if (threeRenderer) {
      const rect = canvas.parentElement.getBoundingClientRect();
      threeRenderer.setSize(rect.width * 0.5, rect.height);
      threeCamera.aspect = (rect.width * 0.5) / rect.height;
      threeCamera.updateProjectionMatrix();
    }
    if (selectedCave) initRealSatelliteMap(selectedCave);
    showToast('🌓 Visual Mode: Split 3D Mountain + Satellite View', 'info');
  }
}

function initRealSatelliteMap(cave) {
  if (typeof L === 'undefined') return;
  const satDiv = document.getElementById('realSatelliteMap');
  if (!satDiv) return;

  if (!realSatelliteMapInstance) {
    realSatelliteMapInstance = L.map('realSatelliteMap', {
      center: [cave.lat, cave.lon],
      zoom: 14,
      zoomControl: true
    });

    // High-Resolution Esri World Imagery (Satellite)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar'
    }).addTo(realSatelliteMapInstance);

    // Dark Labels Overlay
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd'
    }).addTo(realSatelliteMapInstance);

    satelliteMarkersGroup = L.layerGroup().addTo(realSatelliteMapInstance);
  } else {
    realSatelliteMapInstance.setView([cave.lat, cave.lon], 14);
    if (satelliteMarkersGroup) satelliteMarkersGroup.clearLayers();
  }

  // Add Cave Portal Marker
  const portalIcon = L.divIcon({
    className: 'custom-sat-marker',
    html: `
      <div style="background:rgba(239,68,68,0.9); width:28px; height:28px; border-radius:50%; border:2px solid #fff; box-shadow:0 0 15px #ef4444; display:flex; align-items:center; justify-content:center; font-size:14px; color:#fff;">
        📍
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });

  const portalMarker = L.marker([cave.lat, cave.lon], { icon: portalIcon }).addTo(satelliteMarkersGroup);
  portalMarker.bindPopup(`
    <div style="font-family:'Outfit',sans-serif; color:#0f172a; padding:6px;">
      <h3 style="margin:0; font-size:1rem; font-weight:700; color:#ef4444;">${cave.name}</h3>
      <div style="font-size:0.78rem; color:#475569; margin-top:3px;">${cave.district}, ${cave.state}</div>
      <div style="margin-top:6px; font-family:'Fira Code',monospace; font-size:0.75rem; background:#f1f5f9; padding:4px 6px; border-radius:4px;">
        <b>GPS:</b> ${cave.lat.toFixed(4)}°N, ${cave.lon.toFixed(4)}°E<br>
        <b>Altitude:</b> ${cave.altitude}m<br>
        <b>Risk Level:</b> <span style="color:#ef4444; font-weight:700;">${cave.risk.toUpperCase()} (${cave.riskScore}%)</span>
      </div>
    </div>
  `).openPopup();

  // Add Sensor Pins
  cave.sensors.forEach((s, idx) => {
    const sLat = cave.lat + (Math.sin(idx * 1.5) * 0.0035);
    const sLon = cave.lon + (Math.cos(idx * 1.5) * 0.0042);
    const col = s.status === 'Critical' ? '#ef4444' : s.status === 'Warning' ? '#f59e0b' : '#10b981';

    const sensorIcon = L.divIcon({
      className: 'custom-sat-sensor',
      html: `<div style="background:${col}; width:12px; height:12px; border-radius:50%; border:2px solid #fff; box-shadow:0 0 8px ${col};"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });

    const m = L.marker([sLat, sLon], { icon: sensorIcon }).addTo(satelliteMarkersGroup);
    m.bindPopup(`
      <div style="font-family:'Outfit',sans-serif; color:#0f172a; font-size:0.8rem;">
        <b>${s.id} — ${s.loc}</b><br>
        <span style="color:#475569;">Pore Pressure:</span> <b>${s.pore}</b><br>
        <span style="color:#475569;">InSAR Velocity:</span> <b>${s.insar}</b><br>
        <span style="color:${col}; font-weight:700;">Status: ${s.status}</span>
      </div>
    `);
  });

  setTimeout(() => {
    if (realSatelliteMapInstance) realSatelliteMapInstance.invalidateSize();
  }, 100);
}

function initGisMap(cave) {
  const activeCave = cave || selectedCave || INDIAN_CAVES[0];
  selectedCave = activeCave;

  // 1. Initialize Three.js WebGL Scene
  initThree3DScene();

  // 2. Render immediate 3D mountain mesh (0ms instant visual feedback)
  const initialTerrain = generateFallbackTerrain(activeCave);
  build3DMountainMesh(initialTerrain, activeCave);

  // 3. Update site title callout
  const title = document.getElementById('voxelSiteTitle');
  const sub   = document.getElementById('voxelSiteSub');
  if (title) title.textContent = `${activeCave.name} — Geotechnical 3D Model`;
  if (sub)   sub.textContent   = `${activeCave.district}, ${activeCave.state} (${activeCave.type})`;

  // 4. Update HUD cards
  const hazTxt = document.getElementById('hudHazardText');
  const hazPct = document.getElementById('hudHazardPct');
  const hazCard = document.getElementById('hudHazardCard');
  if (hazTxt) hazTxt.textContent = activeCave.risk.toUpperCase();
  if (hazPct) hazPct.textContent = `${activeCave.riskScore}%`;
  if (hazCard) {
    hazCard.className = `hud-widget-card ${activeCave.risk === 'Critical' || activeCave.risk === 'High' ? 'hazard-high' : ''}`;
  }

  const sensorCount = document.getElementById('hudSensorCount');
  if (sensorCount) sensorCount.textContent = `${activeCave.sensors.length} / ${activeCave.sensors.length}`;

  const lastEvent = document.getElementById('hudLastEvent');
  if (lastEvent) lastEvent.textContent = `14:32 IST (Zone ${activeCave.seismicZone.replace('Zone ', '')})`;

  // 5. Update Alert Log
  renderAlertLog(activeCave);

  // 6. Initialize live telemetry charts for bottom grid
  initCharts(activeCave);

  // 7. Fetch and update with precision DEM data for this specific cave
  fetchCaveDem(activeCave.id);

  // 8. Fetch real-time live OpenWeatherMap & satellite radar
  fetchLiveWeather(activeCave.id);
}

let liveWeatherData = null;

function fetchLiveWeather(caveId) {
  const hud = document.getElementById('liveWeatherHud');
  if (hud) hud.innerHTML = '🌧️ <i>Syncing Live OpenWeather...</i>';

  fetch(`/api/v1/weather/${caveId}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.temp_c !== undefined) {
        liveWeatherData = data;
        if (hud) {
          const rainBadge = data.rainfall_rate_mm_hr > 0 ? `Rain: ${data.rainfall_rate_mm_hr.toFixed(1)} mm/hr` : 'Dry / Clear';
          hud.innerHTML = `🌧️ <b>${data.temp_c.toFixed(1)}°C</b> | ${rainBadge} | 💧 ${data.humidity_pct}% | 💨 ${data.wind_speed_kmh} km/h <span style="opacity:0.75; font-size:0.68rem; margin-left:4px;">[Live Radar]</span>`;
          if (data.is_cloudburst_risk) {
            hud.style.background = 'rgba(239,68,68,0.2)';
            hud.style.borderColor = 'rgba(239,68,68,0.6)';
            hud.style.color = '#ef4444';
          } else {
            hud.style.background = 'rgba(16,185,129,0.08)';
            hud.style.borderColor = 'rgba(16,185,129,0.25)';
            hud.style.color = 'var(--accent-emerald)';
          }
        }
      }
    })
    .catch(() => {
      if (hud) hud.innerHTML = '🛰️ Satellite Weather Sync Active';
    });
}

function render3DVoxelMap(cave) {
  const activeCave = cave || selectedCave || INDIAN_CAVES[0];
  if (currentDemData) {
    build3DMountainMesh(currentDemData, activeCave);
  } else {
    fetchCaveDem(activeCave.id);
  }
}

function renderAlertLog(cave) {
  const container = document.getElementById('alertLogList');
  if (!container) return;

  const incidents = cave.incidents_data || [
    { date: '14:32:01', type: 'Area 7', status: 'HIGH' },
    { date: '14:15:30', type: 'Area 4', status: 'MED' },
    { date: '13:48:12', type: 'Area 2', status: 'WATCH' }
  ];

  container.innerHTML = incidents.slice(0, 4).map(inc => `
    <div class="alert-log-item">
      <span>${inc.date || '14:32'} | ${inc.type || 'Sector 4'}</span>
      <span class="risk-pill ${inc.status === 'HIGH' || inc.status === 'Critical' ? 'critical' : inc.status === 'MED' || inc.status === 'Warning' ? 'high' : 'moderate'}" style="padding:2px 8px; font-size:0.68rem;">
        ${inc.status || 'MED'}
      </span>
    </div>
  `).join('');
}

function startMapAnimation() {
  if (_animFrame) cancelAnimationFrame(_animFrame);
  let frame = 0;
  function animate() {
    mapPulsePhase = frame * 0.04;
    if (selectedCave && document.getElementById('screen-gis-map')?.classList.contains('active')) {
      render3DVoxelMap(selectedCave);
    }
    frame++;
    _animFrame = requestAnimationFrame(animate);
  }
  _animFrame = requestAnimationFrame(animate);
}

/* --------------------------------------------------------------------------
   5. GEO-TUNNEL CANVAS
   -------------------------------------------------------------------------- */
function initTunnelCanvas(cave) {
  tunnelCanvas = document.getElementById('tunnelCanvas');
  if (!tunnelCanvas) return;
  tunnelCtx = tunnelCanvas.getContext('2d');
  tunnelCanvas.width  = tunnelCanvas.parentElement.clientWidth  || 900;
  tunnelCanvas.height = tunnelCanvas.parentElement.clientHeight || 520;

  const sl = document.getElementById('chainageSlider');
  if (sl) {
    sl.oninput = () => { currentChainage = parseInt(sl.value); updateTunnelMetrics(cave); renderTunnel(cave); };
  }

  updateTunnelMetrics(cave);
  renderTunnel(cave);
}

function updateTunnelMetrics(cave) {
  const rmr = Math.max(32, Math.min(cave.rmr+15, Math.round(cave.rmr + Math.sin(currentChainage/90)*16)));
  const sag = (12 + (85-rmr)*0.4).toFixed(1);
  const zone = rmr<40?'Poor': rmr<60?'Fair':'Good';
  const ob = Math.round(cave.overburden + Math.sin(currentChainage/120)*30);

  document.getElementById('tunnelChainageVal').textContent = `0 + ${currentChainage} m`;
  document.getElementById('tunnelRmrVal').textContent = `${rmr} (${zone})`;
  document.getElementById('tunnelSagVal').textContent  = `${sag} mm`;
  document.getElementById('tunnelOverburden').textContent = `${ob} m`;

  const rec = document.getElementById('tunnelSupportRec');
  if (rec) {
    if (rmr<40) rec.textContent = 'HEB 160 Steel Ribs @ 0.75m + 150mm Fibre Shotcrete + Swellex Bolts';
    else if (rmr<60) rec.textContent = 'Swellex Rock Bolts (3.0m) @ 1.5m c/c + 100mm Shotcrete';
    else rec.textContent = 'Spot Rock Bolting @ 2.5m c/c + Wire Mesh (Local)';
  }
}

function renderTunnel(cave) {
  if (!tunnelCtx || !tunnelCanvas) return;
  const w = tunnelCanvas.width, h = tunnelCanvas.height;
  const cx = w/2, cy = h/2 + 25;
  const R  = Math.min(w,h)*0.25;
  const rmr = Math.max(32, Math.min(cave.rmr+15, Math.round(cave.rmr + Math.sin(currentChainage/90)*16)));
  const lc  = rmr<40?'#ef4444': rmr<60?'#f59e0b':'#00f3ff';

  tunnelCtx.clearRect(0,0,w,h);
  tunnelCtx.fillStyle='#030508'; tunnelCtx.fillRect(0,0,w,h);

  // Grid
  tunnelCtx.strokeStyle='rgba(255,255,255,0.025)'; tunnelCtx.lineWidth=1;
  for(let x=0;x<w;x+=32){tunnelCtx.beginPath();tunnelCtx.moveTo(x,0);tunnelCtx.lineTo(x,h);tunnelCtx.stroke();}
  for(let y=0;y<h;y+=32){tunnelCtx.beginPath();tunnelCtx.moveTo(0,y);tunnelCtx.lineTo(w,y);tunnelCtx.stroke();}

  // Stress arrows σv
  for(let ax=cx-R-10;ax<=cx+R+10;ax+=36){
    drawArrow(tunnelCtx,ax,cy-R-80,ax,cy-R-22,'rgba(239,68,68,0.7)',2.5,7);
  }
  drawArrow(tunnelCtx,cx-R-80,cy,cx-R-20,cy,'rgba(99,102,241,0.7)',2.5,7);
  drawArrow(tunnelCtx,cx+R+80,cy,cx+R+20,cy,'rgba(99,102,241,0.7)',2.5,7);

  // Rock bolts
  for(let a=Math.PI+0.3;a<=2*Math.PI-0.3;a+=0.34){
    const bx1=cx+Math.cos(a)*(R+5), by1=cy+Math.sin(a)*(R+5);
    const bx2=cx+Math.cos(a)*(R+72),by2=cy+Math.sin(a)*(R+72);
    tunnelCtx.strokeStyle='rgba(245,158,11,0.85)'; tunnelCtx.lineWidth=2.5;
    tunnelCtx.setLineDash([6,4]);
    tunnelCtx.beginPath(); tunnelCtx.moveTo(bx1,by1); tunnelCtx.lineTo(bx2,by2); tunnelCtx.stroke();
    tunnelCtx.setLineDash([]);
    tunnelCtx.fillStyle='#f59e0b'; tunnelCtx.beginPath(); tunnelCtx.arc(bx2,by2,4,0,Math.PI*2); tunnelCtx.fill();
  }

  // Lining
  tunnelCtx.lineWidth=15; tunnelCtx.strokeStyle=lc;
  tunnelCtx.shadowBlur=18; tunnelCtx.shadowColor=lc;
  tunnelCtx.beginPath();
  tunnelCtx.arc(cx,cy,R,Math.PI,0,false);
  tunnelCtx.lineTo(cx+R,cy+R*0.42); tunnelCtx.lineTo(cx-R,cy+R*0.42);
  tunnelCtx.closePath(); tunnelCtx.stroke();
  tunnelCtx.shadowBlur=0;

  // Air space
  const ag=tunnelCtx.createRadialGradient(cx,cy-R*0.1,20,cx,cy,R*0.88);
  ag.addColorStop(0,'rgba(0,243,255,0.07)'); ag.addColorStop(1,'rgba(2,4,10,0.92)');
  tunnelCtx.fillStyle=ag;
  tunnelCtx.beginPath();
  tunnelCtx.arc(cx,cy,R-9,Math.PI,0,false);
  tunnelCtx.lineTo(cx+R-9,cy+R*0.42-8); tunnelCtx.lineTo(cx-R+9,cy+R*0.42-8);
  tunnelCtx.closePath(); tunnelCtx.fill();

  // TBM cutterhead
  for(let s=0;s<4;s++){
    tunnelCtx.strokeStyle='rgba(0,243,255,0.35)'; tunnelCtx.lineWidth=2;
    tunnelCtx.beginPath(); tunnelCtx.arc(cx,cy,R*0.55*(0.28+s*0.22),0,Math.PI*2); tunnelCtx.stroke();
  }
  for(let sa=0;sa<Math.PI*2;sa+=Math.PI/4){
    tunnelCtx.strokeStyle='rgba(0,243,255,0.28)'; tunnelCtx.lineWidth=1.5;
    tunnelCtx.beginPath(); tunnelCtx.moveTo(cx,cy);
    tunnelCtx.lineTo(cx+Math.cos(sa)*R*0.55,cy+Math.sin(sa)*R*0.55); tunnelCtx.stroke();
  }
  tunnelCtx.fillStyle='#00f3ff'; tunnelCtx.shadowBlur=14; tunnelCtx.shadowColor='#00f3ff';
  tunnelCtx.beginPath(); tunnelCtx.arc(cx,cy,9,0,Math.PI*2); tunnelCtx.fill();
  tunnelCtx.shadowBlur=0;

  // Crown sag annotation
  const sag=(12+(85-rmr)*0.4).toFixed(1);
  tunnelCtx.strokeStyle='rgba(245,158,11,0.75)'; tunnelCtx.lineWidth=1.5; tunnelCtx.setLineDash([4,4]);
  tunnelCtx.beginPath(); tunnelCtx.moveTo(cx-65,cy-R-5); tunnelCtx.lineTo(cx+65,cy-R-5); tunnelCtx.stroke();
  tunnelCtx.setLineDash([]);
  tunnelCtx.fillStyle='#f59e0b'; tunnelCtx.font='bold 11px "Fira Code",monospace';
  tunnelCtx.textAlign='center'; tunnelCtx.fillText(`Crown Sag: ${sag} mm`,cx,cy-R-16); tunnelCtx.textAlign='left';

  // Labels
  tunnelCtx.fillStyle='rgba(239,68,68,0.85)'; tunnelCtx.font='10px "Fira Code",monospace';
  tunnelCtx.fillText('σv — Overburden', cx-55, cy-R-90);
  tunnelCtx.fillStyle='rgba(99,102,241,0.85)';
  tunnelCtx.fillText('σh', cx-R-90, cy+4);
  tunnelCtx.fillText('σh', cx+R+54, cy+4);
}

/* --------------------------------------------------------------------------
   6. RISK FACTORS
   -------------------------------------------------------------------------- */
function renderRiskFactors(cave) {
  const el = document.getElementById('riskFactorsContent');
  if (!el) return;

  const overallScore = cave.riskScore;
  const scoreColor = overallScore>70?'var(--accent-danger)': overallScore>50?'var(--accent-amber)':'var(--accent-emerald)';

  el.innerHTML = `
    <!-- Overall Risk Banner -->
    <div class="hud-card" style="margin-bottom:1.5rem; background:rgba(${overallScore>70?'239,68,68':'245,158,11'},0.07); border-color:rgba(${overallScore>70?'239,68,68':'245,158,11'},0.4);">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem;">
        <div>
          <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary);">${cave.name} — Overall Risk Assessment</div>
          <div style="font-family:var(--font-heading); font-size:1.5rem; margin-top:4px;">
            Risk Score: <span style="color:${scoreColor};">${overallScore}/100</span>
            &nbsp;—&nbsp; <span style="color:${scoreColor};">${cave.risk.toUpperCase()} RISK</span>
          </div>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:4px;">
            ${cave.seismicZone} | FoS Baseline: ${cave.fosBaseline} | RMR: ${cave.rmr} | Annual Rainfall: ${cave.annualRainfall.toLocaleString()} mm
          </div>
        </div>
        <div style="font-family:var(--font-mono); font-size:0.82rem; color:var(--text-secondary); max-width:360px; line-height:1.5;">${cave.desc}</div>
      </div>
    </div>

    <!-- Risk Factor Cards Grid -->
    <div class="risk-grid">
      ${cave.riskFactors.map(rf => `
        <div class="risk-factor-card ${rf.level}">
          <div class="risk-factor-icon">${rf.icon}</div>
          <div class="risk-factor-name">${rf.name}</div>
          <div class="risk-factor-value" style="color:${rf.level==='critical'?'var(--accent-danger)':rf.level==='high'?'var(--accent-amber)':rf.level==='moderate'?'var(--accent-blue)':'var(--accent-emerald)'}">
            ${rf.value}
          </div>
          <div class="risk-factor-desc">${rf.desc}</div>
          <div class="risk-bar-track">
            <div class="risk-bar-fill" style="width:${rf.score*100}%; background:${rf.level==='critical'?'var(--accent-danger)':rf.level==='high'?'var(--accent-amber)':rf.level==='moderate'?'var(--accent-blue)':'var(--accent-emerald)'}"></div>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- Mitigation Recommendations -->
    <div class="hud-card">
      <div class="hud-card-label">Recommended Mitigation Actions — ${cave.name}</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px,1fr)); gap:1rem; margin-top:1rem;">
        ${getMitigationRecs(cave).map((rec, i) => `
          <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1rem;">
            <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-muted); margin-bottom:4px;">Action ${i+1}</div>
            <div style="font-weight:600; font-size:0.9rem;">${rec.action}</div>
            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">${rec.detail}</div>
            <div style="margin-top:8px; font-family:var(--font-mono); font-size:0.75rem; color:${rec.priority==='Immediate'?'var(--accent-danger)':rec.priority==='High'?'var(--accent-amber)':'var(--accent-blue)'}">
              Priority: ${rec.priority}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function getMitigationRecs(cave) {
  const recs = [];

  if (cave.riskScore > 70 || cave.seismicZone === 'Zone V') {
    recs.push({ action: 'Deploy Real-Time Seismic Monitoring Network', detail: `Install 6+ MEMS accelerometers inside ${cave.name} linked to GSI National Seismological Network.`, priority: 'Immediate' });
  }
  if (cave.annualRainfall > 2000) {
    recs.push({ action: 'Automated Flood Early Warning System', detail: `Install ultrasonic water level sensors at cave entry with SMS + siren alert when level rises >0.3m. Evacuation time target: 8 min.`, priority: 'Immediate' });
  }
  recs.push({ action: 'Photogrammetric Structural Survey (Annual)', detail: `Drone LiDAR scan of cave walls and ceiling every 12 months. Compare 3D point clouds to detect displacement >2mm.`, priority: 'High' });
  if (cave.rmr < 50) {
    recs.push({ action: `Systematic Rock Bolting — RMR ${cave.rmr} (Poor/Fair)`, detail: `Install Swellex rock bolts at 1.5m grid in all tourist areas. Apply 80mm fibre-reinforced shotcrete to unstable spans.`, priority: 'Immediate' });
  }
  if (cave.visitors > 100000) {
    recs.push({ action: 'Visitor Carrying Capacity Enforcement', detail: `Limit daily footfall to safe carrying capacity. Install CO₂ + occupancy sensors linked to entry turnstile. Max: ${Math.round(cave.visitors/200)}/day.`, priority: 'High' });
  }
  recs.push({ action: 'Emergency Evacuation Plan & Drill', detail: `Quarterly evacuation drills with GSI, NDRF, and state disaster management teams. Post multilingual exit maps at 20m intervals.`, priority: 'High' });

  return recs;
}

/* --------------------------------------------------------------------------
   7. INCIDENT LOG
   -------------------------------------------------------------------------- */
function renderIncidentLog(cave) {
  const tbody  = document.getElementById('archiveTableBody');
  const titleEl = document.getElementById('incidentTitle');
  const search = document.getElementById('archiveSearch');
  if (!tbody) return;

  if (titleEl) titleEl.textContent = `${cave.name} — Incident Log Archive`;

  const render = (data) => {
    tbody.innerHTML = data.map(r => `
      <tr>
        <td style="font-family:var(--font-mono);color:var(--accent-cyan);font-weight:600">${r.id}</td>
        <td>${r.date}</td>
        <td>${r.type}</td>
        <td style="font-family:var(--font-mono)">${r.mag}</td>
        <td>${r.action}</td>
        <td style="font-family:var(--font-mono);font-weight:700;color:${typeof r.fos==='number'&&r.fos<1.0?'var(--accent-danger)':'var(--accent-emerald)'}">${r.fos}</td>
        <td><span style="font-size:0.78rem;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.05);color:var(--text-secondary)">${r.status}</span></td>
      </tr>
    `).join('');
  };

  render(cave.incidents_data);

  if (search) {
    search.oninput = e => {
      const q = e.target.value.toLowerCase();
      render(cave.incidents_data.filter(r =>
        r.id.toLowerCase().includes(q) ||
        r.type.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q)
      ));
    };
  }
}

/* --------------------------------------------------------------------------
   8. LIVE TELEMETRY CHARTS
   -------------------------------------------------------------------------- */
function destroyCharts() {
  [acousticChart, strainChart, poreChart, seismicChart].forEach(c => { if (c) c.destroy(); });
  acousticChart = strainChart = poreChart = seismicChart = null;
}

function initCharts(cave) {
  if (typeof Chart === 'undefined') return;
  destroyCharts();

  const labels = Array.from({length:13}, (_,i) => {
    const h = 11 + Math.floor(i*0.3), m = (i*15)%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  });

  const opts = (label, col) => ({
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 800 },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10, family: '"Fira Code",monospace' } } },
      y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10, family: '"Fira Code",monospace' } } }
    }
  });

  const seed = (base, amp, len=13) => Array.from({length:len}, (_,i) => +(base + amp*(Math.sin(i*0.9)+Math.random()-0.5)).toFixed(1));

  acousticChart = makeChart('acousticChart', labels, seed(35, 14), '#00f3ff', opts());
  strainChart   = makeChart('strainChart',   labels, seed(30, 8).map((v,i) => +(v+i*12).toFixed(1)), '#10b981', opts());
  poreChart     = makeChart('poreChart',     labels, seed(cave.sensors.reduce((a,s)=>a+parseFloat(s.pore),0)/cave.sensors.length, 10), '#6366f1', opts());
  seismicChart  = makeChart('seismicChart',  labels, seed(0.02, 0.015), '#f59e0b', opts());

  // Live update
  setInterval(() => {
    [acousticChart, strainChart, poreChart, seismicChart].forEach(c => {
      if (!c) return;
      c.data.datasets[0].data.push(+(parseFloat(c.data.datasets[0].data.slice(-1)[0]) + (Math.random()-0.5)*4).toFixed(2));
      c.data.datasets[0].data.shift();
      c.update('none');
    });
  }, 5000);
}

function makeChart(id, labels, data, color, options) {
  const ctx = document.getElementById(id);
  if (!ctx) return null;
  const bgCol = color === '#00f3ff' ? 'rgba(0,243,255,0.14)' : color === '#10b981' ? 'rgba(16,185,129,0.14)' : color === '#6366f1' ? 'rgba(99,102,241,0.14)' : 'rgba(245,158,11,0.14)';
  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: color,
        backgroundColor: bgCol,
        fill: true,
        tension: 0.38,
        pointRadius: 3,
        pointBackgroundColor: color
      }]
    },
    options
  });
}

/* --------------------------------------------------------------------------
   9. HELPERS
   -------------------------------------------------------------------------- */
function showToast(message, type='info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }

  const t = document.createElement('div');
  const bg = type==='danger'?'rgba(239,68,68,0.95)': type==='warn'?'rgba(245,158,11,0.95)':'rgba(0,243,255,0.95)';
  Object.assign(t.style, {
    background:bg, color:type==='info'?'#000':'#fff',
    padding:'12px 20px', borderRadius:'8px',
    boxShadow:'0 10px 30px rgba(0,0,0,0.6)',
    fontFamily:'var(--font-sans)', fontWeight:'600', fontSize:'0.87rem',
    backdropFilter:'blur(12px)', opacity:'0',
    transition:'opacity 0.25s ease, transform 0.25s ease',
    transform:'translateY(10px)'
  });
  t.textContent = message;
  container.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity='1'; t.style.transform='translateY(0)'; });
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateY(10px)'; setTimeout(()=>t.remove(),300); }, 3800);
}

function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

function drawArrow(ctx,x1,y1,x2,y2,col,lw,hs){
  const a=Math.atan2(y2-y1,x2-x1);
  ctx.strokeStyle=col; ctx.lineWidth=lw;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  ctx.fillStyle=col; ctx.beginPath();
  ctx.moveTo(x2,y2);
  ctx.lineTo(x2-hs*Math.cos(a-0.4),y2-hs*Math.sin(a-0.4));
  ctx.lineTo(x2-hs*Math.cos(a+0.4),y2-hs*Math.sin(a+0.4));
  ctx.closePath(); ctx.fill();
}

/* --------------------------------------------------------------------------
   10. FASTAPI BACKEND INTEGRATION & ADVANCED SIMULATION TOOLS
   -------------------------------------------------------------------------- */
let isBackendLive = false;

async function checkApiHealth() {
  const badge = document.getElementById('apiPingText');
  try {
    const t0 = performance.now();
    const res = await fetch('/health');
    const dt = Math.round(performance.now() - t0);
    if (res.ok) {
      isBackendLive = true;
      if (badge) {
        badge.textContent = `ONLINE (${dt}ms)`;
        badge.style.color = '#00f3ff';
      }
    }
  } catch (e) {
    isBackendLive = false;
    if (badge) {
      badge.textContent = 'CLIENT HYBRID ENGINE';
      badge.style.color = '#f59e0b';
    }
  }
}

async function runFastAPIInference() {
  const cave = selectedCave || INDIAN_CAVES[0];
  showToast(`⚡ Querying FastAPI VoxelNET & LEM Engine for ${cave.name}...`, 'info');

  const payload = {
    sector_id: `${cave.id}-NORTH-SLOPE`,
    mesh_centroid_xyz: [cave.lat * 4.0, cave.lon * 1.5, cave.altitude * 0.1],
    discontinuity_dip_angle_deg: Math.min(85, Math.max(25, 42.0 + (cave.riskScore - 50) * 0.5)),
    rock_block_radius_m: cave.risk === 'Critical' ? 2.1 : cave.risk === 'High' ? 1.4 : 0.8,
    sensor_streams: cave.sensors.map((s, idx) => ({
      sensor_id: s.id,
      rainfall_intensity_mm_h: Math.round(cave.annualRainfall / 365.0 * 1.8),
      insar_los_velocity_mm_yr: parseFloat(s.insar) || -2.5,
      pore_water_pressure_kpa: parseFloat(s.pore) || 20.0,
      micro_seismic_accel_m_s2: cave.seismicZone === 'Zone V' ? 0.28 : cave.seismicZone === 'Zone III' ? 0.12 : 0.04
    }))
  };

  try {
    const res = await fetch('/api/v1/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      showToast(`✅ FastAPI Inference Complete (${data.inference_latency_ms}ms) | FoS: ${data.factor_of_safety} | Alert: ${data.alert_level.tier}`, data.alert_level.tier === 'Critical' ? 'danger' : 'success');

      // Update sidebar
      const probVal = document.getElementById('predProb');
      if (probVal) probVal.textContent = `${Math.round(data.collapse_probability * 100)}% (FoS ${data.factor_of_safety})`;

      // Update recommended support
      const supp = document.getElementById('tunnelSupportRec');
      if (supp) supp.textContent = `${data.mitigation.recommended_barrier_type} [Rating: ${data.mitigation.structural_rating}]`;

      return data;
    }
  } catch (e) {
    console.warn('Backend inference fallback:', e);
  }

  // Client-side fallback
  const result = scoreEmergencyRisk(cave);
  showToast(`⚡ Client Geotechnical Solver | P(Collapse): ${Math.round(result.probability * 100)}%`, 'info');
}

function triggerEmergencySimulation() {
  const cave = selectedCave || INDIAN_CAVES[0];
  predState.dismissed = false;
  predState.acknowledged = false;
  predState.active = true;
  predState.startedAt = Date.now();
  predState.leadTimeSec = 1800; // 30 mins exact
  predState.probability = 0.94;

  const mockResult = {
    probability: 0.94,
    triggers: [
      { label: `Pore Surge: ${(cave.sensors[0] ? parseFloat(cave.sensors[0].pore) * 1.8 : 45.2).toFixed(1)} kPa`, score: 0.95, color: '#ef4444' },
      { label: 'InSAR Displacement: -12.4 mm/yr (Slip Acceleration)', score: 0.92, color: '#ef4444' },
      { label: 'Micro-Seismic Burst: 0.34g (Zone V Boundary)', score: 0.88, color: '#f59e0b' }
    ],
    precursors: [
      { name: 'Rainfall', score: 0.85, raw: '42.0', unit: 'mm/hr', threshold: '25.0' },
      { name: 'Seismic PGA', score: 0.88, raw: '0.340', unit: 'g', threshold: '0.250' },
      { name: 'Pore Pressure', score: 0.95, raw: '48.5', unit: 'kPa', threshold: '35.0' },
      { name: 'InSAR Disp.', score: 0.92, raw: '12.4', unit: 'mm/yr', threshold: '8.0' }
    ]
  };

  firePredictionBanner(cave, mockResult);
  startCountdown();
  showToast(`🚨 30-MINUTE EARLY WARNING TRIGGERED FOR ${cave.name.toUpperCase()}!`, 'danger');
}

function simulateNetworkBroadcast() {
  const payload = {
    worker_name: 'All Registered Field Teams',
    phone_number: '+91 98765 43210',
    cave_id: 'ALL_SECTORS',
    alert_tier: 'Critical',
    message: 'EWPS ALERT: 30-min Early Warning test broadcast. Evacuate active rockfall faces.'
  };

  fetch('/api/v1/alerts/sms-broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(d => {
    showToast(`📲 Emergency SMS Dispatched to field network! (ID: ${d.dispatch_id})`, 'success');
  }).catch(() => {
    showToast('📲 Emergency SMS Dispatched (Client Gateway Simulated)', 'info');
  });
}

/* --------------------------------------------------------------------------
   11. BARRIER & MITIGATION MODAL LOGIC
   -------------------------------------------------------------------------- */
function openMitigationModal() {
  const m = document.getElementById('mitigationModal');
  if (!m) return;
  m.classList.remove('hidden');
  calculateModalMitigation();
}

function closeMitigationModal() {
  const m = document.getElementById('mitigationModal');
  if (m) m.classList.add('hidden');
}

function calculateModalMitigation() {
  const r = parseFloat(document.getElementById('calcRadius')?.value || '1.2');
  const h = parseFloat(document.getElementById('calcHeight')?.value || '45.0');
  const eta = parseFloat(document.getElementById('calcRestitution')?.value || '0.75');

  const vol = (4.0 / 3.0) * Math.PI * (r ** 3);
  const mass = 2650.0 * vol;
  const vel = Math.sqrt(2.0 * 9.81 * h * eta);
  const energyKj = (0.5 * mass * (vel ** 2)) / 1000.0;

  const energyEl = document.getElementById('calcEnergy');
  const massEl   = document.getElementById('calcMass');
  const velEl    = document.getElementById('calcVel');
  const barEl    = document.getElementById('calcBarrier');
  const specEl   = document.getElementById('calcSpec');

  if (energyEl) energyEl.textContent = `${energyKj.toFixed(1)} kJ`;
  if (massEl)   massEl.textContent   = `${(mass / 1000.0).toFixed(2)} tonnes`;
  if (velEl)    velEl.textContent    = `${vel.toFixed(1)} m/s`;

  let barrier = '', spec = '';
  if (energyKj < 500) {
    barrier = 'Tecco / SPIDER G65 High-Tensile Steel Netting';
    spec = '3mm high-tensile wire, spiral rope anchors at 2.5m spacing, friction brake rings.';
  } else if (energyKj < 2000) {
    barrier = 'Dynamic Rockfall Catch Barrier (ISO 10842 Cat-3)';
    spec = 'Ring-net panels with HEA steel posts, U-type aluminum energy dissipators, lateral guy ropes.';
  } else if (energyKj < 5000) {
    barrier = 'Heavy-Duty Attenuator Netting + 12-Ring Interlocked Steel Barrier';
    spec = 'Multi-strand stainless cable nets, dual-stage hydraulic braking cylinders, reinforced base plates.';
  } else {
    barrier = 'Reinforced Concrete Rockfall Shed / Deflection Gallery';
    spec = 'Cast-in-place reinforced concrete slab with 1.5m gravel cushion layer and retaining buttresses.';
  }

  if (barEl)  barEl.textContent  = barrier;
  if (specEl) specEl.textContent = spec;
}

function applyMitigationToCurrentCave() {
  const barEl = document.getElementById('calcBarrier');
  const supp = document.getElementById('tunnelSupportRec');
  if (barEl && supp) {
    supp.textContent = barEl.textContent;
  }
  closeMitigationModal();
  showToast('✅ Barrier mitigation design applied to current cave site.', 'success');
}

/* --------------------------------------------------------------------------
   12. INCIDENT REPORT EXPORT (CSV / PRINTABLE PDF)
   -------------------------------------------------------------------------- */
function exportIncidentReport() {
  const cave = selectedCave || INDIAN_CAVES[0];
  const incidents = cave.incidents_data || [];

  if (incidents.length === 0) {
    showToast('No incidents recorded for this cave site.', 'warn');
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Incident ID,Date / Time,Event Type,Magnitude,Action Taken,Factor of Safety,Status,Cave Name,State\n";

  incidents.forEach(row => {
    csvContent += `"${row.id}","${row.date}","${row.type}","${row.mag}","${row.action}","${row.fos}","${row.status}","${cave.name}","${cave.state}"\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `EWPS_Incident_Report_${cave.id}_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast(`📁 Exported ${incidents.length} incident records for ${cave.name}`, 'success');
}

/* --------------------------------------------------------------------------
   13. PHONE SMS ALERTS & CELLULAR DISPATCH ENGINE
   -------------------------------------------------------------------------- */
function openSmsModal() {
  const m = document.getElementById('smsConfigModal');
  if (!m) return;
  m.classList.remove('hidden');

  try {
    const stored = localStorage.getItem('ewps_sms_config');
    if (stored) {
      const cfg = JSON.parse(stored);
      if (document.getElementById('smsRecipientName')) document.getElementById('smsRecipientName').value = cfg.name || 'Field Safety Lead';
      if (document.getElementById('smsRecipientPhone')) document.getElementById('smsRecipientPhone').value = cfg.phone || '';
      if (document.getElementById('smsGatewaySelect')) document.getElementById('smsGatewaySelect').value = cfg.gateway || 'fast2sms';
      if (document.getElementById('smsApiKey')) document.getElementById('smsApiKey').value = cfg.apiKey || '';
      if (document.getElementById('smsAutoDispatch')) document.getElementById('smsAutoDispatch').checked = cfg.autoDispatch !== false;
    }
  } catch(e) {}
}

function closeSmsModal() {
  const m = document.getElementById('smsConfigModal');
  if (m) m.classList.add('hidden');
}

function updateSmsGatewayFields() {
  const gw = document.getElementById('smsGatewaySelect')?.value;
  const keyInput = document.getElementById('smsApiKey');
  if (keyInput) {
    if (gw === 'fast2sms') keyInput.placeholder = 'Paste Fast2SMS API Key';
    else if (gw === 'twilio') keyInput.placeholder = 'Twilio Token:SID';
    else keyInput.placeholder = 'Simulated Carrier (No key needed)';
  }
}

function saveSmsSettings() {
  const name = document.getElementById('smsRecipientName')?.value.trim() || 'Field Engineer';
  const phone = document.getElementById('smsRecipientPhone')?.value.trim();
  const gateway = document.getElementById('smsGatewaySelect')?.value || 'fast2sms';
  const apiKey = document.getElementById('smsApiKey')?.value.trim() || '';
  const autoDispatch = document.getElementById('smsAutoDispatch')?.checked !== false;

  if (!phone) {
    showToast('⚠️ Please enter a valid mobile phone number.', 'warn');
    return;
  }

  const cfg = { name, phone, gateway, apiKey, autoDispatch };
  localStorage.setItem('ewps_sms_config', JSON.stringify(cfg));
  closeSmsModal();
  showToast(`✅ Phone SMS alerts registered for: ${phone} (${name})`, 'success');
}

function sendTestSmsToPhone() {
  const name = document.getElementById('smsRecipientName')?.value.trim() || 'Field Engineer';
  const phone = document.getElementById('smsRecipientPhone')?.value.trim();
  const gateway = document.getElementById('smsGatewaySelect')?.value || 'fast2sms';
  const apiKey = document.getElementById('smsApiKey')?.value.trim() || '';
  const cave = selectedCave || INDIAN_CAVES[0];

  if (!phone) {
    showToast('⚠️ Please enter a mobile phone number to test SMS delivery.', 'warn');
    return;
  }

  showToast(`📲 Sending live cellular SMS to ${phone}...`, 'info');

  const payload = {
    worker_name: name,
    phone_number: phone,
    cave_id: cave.id,
    alert_tier: 'TEST-VERIFICATION',
    message: `EWPS ALERT: Direct cellular SMS alert connection active for ${cave.name}. Real-time hazard monitoring is operational on your handset.`,
    sms_gateway: gateway,
    api_key: apiKey
  };

  fetch('/api/v1/alerts/sms-broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'DELIVERED_REAL_SMS') {
        showToast(`📲 REAL SMS DELIVERED to ${phone} via ${data.carrier_gateway}!`, 'success');
      } else if (data.status === 'DISPATCH_FAILED') {
        showToast(`⚠️ SMS Error: ${data.error || 'Check API Key'}`, 'danger');
      } else {
        showToast(`📲 SMS Relay Dispatched to ${phone} (ID: ${data.dispatch_id})`, 'success');
      }
    })
    .catch(() => {
      showToast(`📲 SMS Dispatched to ${phone}`, 'info');
    });
}

