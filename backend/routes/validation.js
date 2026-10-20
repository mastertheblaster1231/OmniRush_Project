import { Router } from 'express';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  CORE_DATASET,
  CORE_SOURCE_URL,
  fetchCoreProfile,
  fetchFleet,
  interpolateAt,
} from '../services/argoCore.js';
import { BGC_UNITS, BGC_VARIABLES, discoverBgcFloats, fetchBgcProfile } from '../services/argoBgc.js';
import { discoverModelDatasets, fetchModelPoint, isModelConfigured } from '../services/modelGrid.js';
import { CURRENTS_SOURCE, fetchCurrentVectors } from '../services/currentsGrid.js';
import { round } from '../services/sanitize.js';
import { fetchValidationSlice } from '../services/validation.js';

const router = Router();

/**
 * Every endpoint here returns real measurements or an explicit absence.
 *
 * What was removed and why:
 *   analyticalTemp/Sal/Oxy/Chl/Current  - generated observations
 *   deriveBGC()                         - generated PAR, backscatter, CDOM,
 *                                         oxygen saturation, and a
 *                                         hydraulics_telemetry block reporting
 *                                         bladder position and internal vacuum.
 *                                         Argo does not transmit any of that
 *                                         over ERDDAP.
 *   the hardcoded 3-float fleet fallback
 *   the /validation and /model/point analytical models
 *
 * Those made a broken pipeline indistinguishable from a working one, and
 * presenting computed numbers as float observations to an INCOIS panel is a
 * credibility problem, not just a technical one.
 *
 * Response contract: a value is either a real number or null. `source` says
 * where it came from. `available` says whether the sensor exists at all.
 */

const asError = (res, status, message, extra = {}) =>
  res.status(status).json({ error: message, available: false, ...extra });

// ---- 1. FLEET --------------------------------------------------------------
router.get('/fleet', async (req, res) => {
  const opts = {
    latMin: parseFloat(req.query.lat_min) || 0,
    latMax: parseFloat(req.query.lat_max) || 25,
    lonMin: parseFloat(req.query.lon_min) || 55,
    lonMax: parseFloat(req.query.lon_max) || 98,
    days: parseInt(req.query.days, 10) || 45,
  };

  try {
    const { floats, fetchedAt } = await fetchFleet(opts);

    // Array response preserved — the frontend maps over it directly.
    res.json(
      floats.map((f) => ({
        ...f,
        maxDepth: null,
        maxDepthNote: 'Not returned by the core Argo fleet query; use the selected profile levels for measured range.',
        status: 'Active',
        mode: 'LIVE',
        fetchedAt,
      }))
    );
  } catch (err) {
    console.error('[fleet]', err.message);
    asError(res, 502, `Could not reach Ifremer ERDDAP: ${err.message}`, {
      hint: 'Check network access to erddap.ifremer.fr, or widen the bounding box.',
      floats: [],
    });
  }
});

// ---- 2. PROFILE ------------------------------------------------------------
/**
 * Physics and BGC in one call. BGC failure does not fail the request — most
 * Argo floats carry no biogeochemical sensors, which is normal.
 */
router.get('/profile/:platform_number', async (req, res) => {
  const pid = String(req.params.platform_number).replace(/^argo-/i, '').trim();
  const days = parseInt(req.query.days, 10) || 120;

  const [core, bgc] = await Promise.allSettled([
    fetchCoreProfile(pid, { days }),
    fetchBgcProfile(pid, { days: Math.max(days, 365) }),
  ]);

  if (core.status === 'rejected') {
    return asError(res, 404, core.reason.message, { platform_number: pid });
  }

  const p = core.value;
  const errors = [];
  if (bgc.status === 'rejected') errors.push(`bgc: ${bgc.reason.message}`);

  res.json({
    platform_number: pid,
    cycle_number: p.cycle_number,
    time: p.time,
    lat: p.lat,
    lon: p.lon,
    mode: 'LIVE',
    source: 'ifremer-erddap',

    // Existing field kept so the current frontend chart keeps working.
    profile: p.levels.map((l) => ({
      depth: l.depth,
      temp: l.temp,
      salinity: l.salinity,
    })),

    physics: { levels: p.levels, available: p.available },
    bgc:
      bgc.status === 'fulfilled'
        ? { levels: bgc.value.levels, available: bgc.value.available, units: BGC_UNITS }
        : null,
    errors,
  });
});

// ---- 2b. BGC PROFILE (standalone) -----------------------------------------
router.get('/bgc/profile/:platform_number', async (req, res) => {
  try {
    res.json(await fetchBgcProfile(req.params.platform_number, {
      days: parseInt(req.query.days, 10) || 365,
    }));
  } catch (err) {
    asError(res, err.code === 'NO_BGC_DATA' ? 404 : 502, err.message, {
      hint: 'This float likely carries no BGC sensors. Use /api/bgc/floats to find one that does.',
    });
  }
});

// ---- 2c. BGC DISCOVERY -----------------------------------------------------
router.get('/bgc/floats', async (req, res) => {
  try {
    res.json(
      await discoverBgcFloats({
        latMin: parseFloat(req.query.lat_min ?? -10),
        latMax: parseFloat(req.query.lat_max ?? 30),
        lonMin: parseFloat(req.query.lon_min ?? 45),
        lonMax: parseFloat(req.query.lon_max ?? 100),
        days: parseInt(req.query.days, 10) || 180,
      })
    );
  } catch (err) {
    asError(res, 502, err.message);
  }
});

// ---- 3. DEPTH SLICE --------------------------------------------------------
/**
 * Values at one depth for one float, interpolated between the two bracketing
 * measured levels. Returns null outside the profile's measured range instead of
 * clamping to the nearest reading — asking for 15 m should not be answered with
 * a 980 m parking measurement.
 */
async function handleDepthSlice(req, res) {
  const pid = String(
    req.query.platform_number || req.query.platformNumber || req.query.floatId || ''
  )
    .replace(/^argo-/i, '')
    .trim();

  if (!pid) return asError(res, 400, 'platform_number is required');

  const depth = Math.max(0, Math.min(2100, parseFloat(req.query.depth) || 15));

  const rawTime = req.query.timestamp || req.query.time || null;
  let atTime = null;
  if (rawTime) {
    const parsed = new Date(rawTime);
    if (Number.isNaN(parsed.getTime())) {
      return asError(res, 400, `Invalid time value: ${rawTime}. Expected ISO-8601.`);
    }
    atTime = parsed.toISOString();
  }

  const [core, bgc] = await Promise.allSettled([
    fetchCoreProfile(pid, { atTime }),
    fetchBgcProfile(pid, { atTime }),
  ]);

  if (core.status === 'rejected') {
    const status = core.reason.code === 'BAD_INPUT' ? 400 : 404;
    return asError(res, status, core.reason.message, { platform_number: pid, depth });
  }

  const p = core.value;
  const bgcLevels = bgc.status === 'fulfilled' ? bgc.value.levels : [];
  const bgcAvailable = bgc.status === 'fulfilled' ? bgc.value.available : {};

  const variables = {
    temperature_c: round(interpolateAt(p.levels, depth, 'temp'), 2),
    salinity_psu: round(interpolateAt(p.levels, depth, 'salinity'), 2),
  };

  for (const v of BGC_VARIABLES) {
    variables[v] = bgcLevels.length ? round(interpolateAt(bgcLevels, depth, v), 4) : null;
  }

  // Backward-compatible aliases for the existing frontend keys.
  variables.dissolved_oxygen_umol_kg = variables.doxy;
  variables.chlorophyll_a_mg_m3 = variables.chla;

  res.json({
    platform_number: pid,
    requested_depth: depth,
    timestamp: p.time,
    interpolation: 'linear between measured levels',
    primary_oceanographic_variables: variables,
    available: {
      temperature_c: variables.temperature_c !== null,
      salinity_psu: variables.salinity_psu !== null,
      ...bgcAvailable,
    },
    units: { temperature_c: '°C', salinity_psu: 'PSU', ...BGC_UNITS },
    metadata: {
      coordinates: { lat: p.lat, lon: p.lon },
      cycle_number: p.cycle_number,
      data_source: 'ifremer-erddap',
      bgc_source: bgc.status === 'fulfilled' ? 'ifremer-erddap-bgc' : null,
      measured_depth_range: p.levels.length
        ? [p.levels[0].depth, p.levels[p.levels.length - 1].depth]
        : null,
      notes:
        'Current speed and direction are not measured by Argo floats and are ' +
        'therefore not reported here. Use a model product for currents.',
    },
    errors: bgc.status === 'rejected' ? [`bgc: ${bgc.reason.message}`] : [],
  });
}


router.get('/argo/depth-slice', handleDepthSlice);
router.get('/depth-slice', handleDepthSlice);
router.get('/argo/depth_slice', handleDepthSlice);

// ---- 3b. FLEET TELEMETRY ENGINE (Python-backed, date+depth resolution) ------
/**
 * Fetches real Argo telemetry for a specific float, resolving:
 *   - Date: latest (real-time) | exact match | nearest historical
 *   - Depth: closest pressure reading to requested depth
 *
 * Query: dynamicDisplayName (platformId), date (optional ISO), depth (meters)
 */
router.get('/argo/float-details', (req, res) => {
  const { dynamicDisplayName, date, depth } = req.query;

  // Platform ID is required; date and depth have sensible defaults
  const platformId = String(dynamicDisplayName || '')
    .replace(/^argo-/i, '')
    .replace(/^Argo\s+/i, '')
    .trim();

  if (!platformId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: dynamicDisplayName (Argo platform number)',
    });
  }

  const targetDepth = parseFloat(depth) || 15;
  const targetDate = date && date !== '' ? date : 'latest';

  const pythonScript = path.join(__dirname, '../../scripts/fleet_telemetry_engine.py');

  // Use system Python (or venv if available)
  const pythonExecutable = process.platform === 'win32'
    ? 'python'
    : 'python3';

  const args = [
    pythonScript,
    '--platform', platformId,
    '--date', targetDate,
    '--depth', String(targetDepth),
  ];

  console.log(`\n┌─ [fleet-telemetry] ─────────────────────────────────────`);
  console.log(`│  Platform : ${platformId}`);
  console.log(`│  Date     : ${targetDate}`);
  console.log(`│  Depth    : ${targetDepth}m`);
  console.log(`│  Script   : ${pythonScript}`);
  console.log(`└─────────────────────────────────────────────────────────`);

  execFile(pythonExecutable, args, { timeout: 35000 }, (error, stdout, stderr) => {
    // Log Python stderr (progress messages) to backend terminal
    if (stderr) {
      stderr.split('\n').filter(Boolean).forEach(line => {
        console.log(`  📡 ${line}`);
      });
    }

    try {
      const payload = JSON.parse(stdout);

      if (!payload.success) {
        console.log(`  ❌ Error: ${payload.error}`);
        return res.status(payload.status || 500).json(payload);
      }

      // Log the successful result to the terminal
      console.log(`  ✅ Match: ${payload.match_type_label}`);
      console.log(`  📅 Date : ${payload.matched_date}`);
      console.log(`  🌊 Depth: ${payload.actual_depth}m (requested ${payload.requested_depth}m)`);
      if (payload.matched_reading) {
        const r = payload.matched_reading;
        console.log(`  🌡️  Temp : ${r.temperature_c}°C`);
        console.log(`  🧂 Sal  : ${r.salinity_psu} PSU`);
        console.log(`  💨 O₂   : ${r.dissolved_oxygen_umol_kg ?? 'N/A'} µmol/kg`);
        console.log(`  🌿 Chl-a: ${r.chlorophyll_a_mg_m3 ?? 'N/A'} mg/m³`);
      }
      console.log(`  📊 Dives available: ${payload.total_dives_available}`);
      console.log('');

      return res.json(payload);

    } catch (parseError) {
      console.error('  ❌ Failed to parse Python output:', stdout?.slice(0, 200));
      console.error('  stderr:', stderr?.slice(0, 200));
      return res.status(500).json({
        success: false,
        error: 'Internal server error: failed to parse telemetry engine output',
      });
    }
  });
});

// ---- 4. MODEL POINT --------------------------------------------------------
router.get('/model/point', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const depth = Math.max(0, Math.min(2100, parseFloat(req.query.depth) || 0));

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return asError(res, 400, 'lat and lon are required');
  }

  try {
    const result = await fetchModelPoint({ lat, lon, depth, time: req.query.time });
    res.json({
      ...result,
      model: result.variables,
      data_source: result.source ?? null,
      depth,
    });
  } catch (err) {
    asError(res, 502, err.message);
  }
});

/** One-off helper: list INCOIS gridded datasets so you can configure .env */
router.get('/model/datasets', async (_req, res) => {
  try {
    res.json({ configured: isModelConfigured(), datasets: await discoverModelDatasets() });
  } catch (err) {
    asError(res, 502, err.message);
  }
});

// ---- 5. VALIDATION ---------------------------------------------------------
/**
 * Canonical real-data validation path.
 *
 * The selected IFREMER cycle is the observation source of truth. The model is
 * queried only through the configured real connector. Missing model or sensor
 * values remain unavailable and never become zeroes or estimates.
 */
async function handleArgoValidation(req, res) {
  const rawPlatform = req.query.platform_number;
  const rawDepth = req.query.depth;
  const rawTime = req.query.time ?? req.query.timestamp ?? null;

  const platformNumber = String(rawPlatform ?? '')
    .replace(/^argo-/i, '')
    .trim();
  if (!platformNumber) {
    return asError(res, 400, 'platform_number is required');
  }

  if (rawDepth === undefined || rawDepth === null || String(rawDepth).trim() === '') {
    return asError(res, 400, 'depth is required');
  }
  const depth = Number(rawDepth);
  if (!Number.isFinite(depth) || depth < 0 || depth > 2100) {
    return asError(res, 400, 'depth must be a finite number between 0 and 2100 metres');
  }

  let time = null;
  if (rawTime !== undefined && rawTime !== null && String(rawTime).trim() !== '') {
    const parsed = new Date(String(rawTime));
    if (Number.isNaN(parsed.getTime())) {
      return asError(res, 400, `Invalid time value: ${rawTime}. Expected ISO-8601.`);
    }
    time = parsed.toISOString();
  }

  try {
    return res.json(await fetchValidationSlice({ platformNumber, depth, time }));
  } catch (err) {
    const status = err.code === 'BAD_INPUT' ? 400 : err.code === 'EMPTY_RESULT' ? 404 : 502;
    return asError(res, status, err.message, {
      platform_number: platformNumber,
      requested_depth: depth,
      requested_time: time,
      observations: { available: false, values: {}, reason: err.message },
      model: {
        available: false,
        values: {},
        reason: 'Model lookup was not attempted because no real observation cycle was available.',
      },
      delta: {
        available: false,
        values: {},
        reason: 'Delta requires both a real observation and a real model value.',
      },
      provenance: {
        platform: platformNumber,
        cycle: null,
        timestamp: null,
        requested_time: time,
        location: null,
        requested_depth: depth,
        observation_depth: null,
        model_depth: null,
        matching_method: 'no matching real IFREMER core cycle',
        qc: null,
        source_urls: { observations: CORE_SOURCE_URL, model: null },
        datasets: { observations: CORE_DATASET, model: null },
      },
      reasons: [err.message],
    });
  }
}

// Canonical endpoint plus the practical namespaced alias. Keep /validation so
// existing clients reach the real Node implementation without a frontend edit.
router.get(['/argo/validation', '/argo/slice', '/validation'], handleArgoValidation);

// Legacy alias so any existing frontend call keeps resolving.
router.get('/validate', (req, res) => {
  const { platform_number, depth, time } = req.query;
  const pythonScript = path.join(__dirname, '../../scripts/validation_engine.py');
  const pythonExecutable = process.platform === 'win32' 
      ? path.join(__dirname, '../../.venv/Scripts/python.exe') 
      : path.join(__dirname, '../../.venv/bin/python');
  const ncSource = process.env.NETCDF_SOURCE_URL || "";

  const args = [
      '--platform', platform_number,
      '--depth', depth,
      '--time', time,
      '--nc_source', ncSource
  ];

  execFile(pythonExecutable, [pythonScript, ...args], { timeout: 35000 }, (error, stdout, stderr) => {
      try {
          const payload = JSON.parse(stdout);
          if (payload.error) return res.status(payload.status || 500).json(payload);
          return res.json(payload);
      } catch (parseError) {
          console.error("Python Error/Stderr:", stderr);
          return res.status(500).json({ error: "Failed to parse validation data engine output." });
      }
  });
});

// ---- 6. SURFACE CURRENTS (NOAA CoastWatch, altimetry-derived geostrophic) ---
/**
 * Decimated geostrophic surface current vectors from satellite altimetry.
 * Surface only — there is no depth dimension. Values are the geostrophic
 * component only (no wind-driven or tidal currents). Never fabricated:
 * a fetch failure is surfaced as an error, not a placeholder field.
 *
 * Query: lat_min, lat_max, lon_min, lon_max (deg), stride (griddap index
 * stride; 1 = full 0.25° grid, 4 = 1° spacing, ...).
 */
router.get('/currents', async (req, res) => {
  try {
    res.json(
      await fetchCurrentVectors({
        latMin: parseFloat(req.query.lat_min) || 0,
        latMax: parseFloat(req.query.lat_max) || 25,
        lonMin: parseFloat(req.query.lon_min) || 55,
        lonMax: parseFloat(req.query.lon_max) || 98,
        stride: parseInt(req.query.stride, 10) || 4,
      })
    );
  } catch (err) {
    const status = err.code === 'BAD_INPUT' ? 400 : err.code === 'EMPTY_RESULT' ? 404 : 502;
    asError(res, status, err.message, {
      source: CURRENTS_SOURCE,
      hint:
        err.code === 'UPSTREAM'
          ? 'NOAA CoastWatch ERDDAP (coastwatch.noaa.gov) could not be reached — no placeholder field is served.'
          : undefined,
    });
  }
});

export default router;
