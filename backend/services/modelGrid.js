import './env.js';
import { buildGridUrl, createCache, fetchErddapJson, parseTable } from './erddap.js';
import { round, sanitize } from './sanitize.js';

/**
 * Gridded ocean model fields via ERDDAP griddap.
 *
 * The previous /model/point endpoint made no network request at all. It
 * computed  28.5 * exp(-depth/380) + 1.5  and returned it labelled
 * "INCOIS-ROMS 1/12°". This file replaces that with a real griddap client.
 *
 * griddap uses a DIFFERENT URL grammar from tabledap:
 *   tabledap   ?var1,var2&time>=X&latitude>=Y
 *   griddap    ?var[(time)][(depth)][(latMin):(latMax)][(lonMin):(lonMax)]
 * The bracket order must match the dataset's own dimension order. Check
 *   https://erddap.incois.gov.in/erddap/griddap/<datasetID>.dds
 * before configuring anything below.
 *
 * If MODEL_DATASET_ID is not configured this module returns
 * { available: false, reason: ... }. It never returns a computed number.
 */

const INCOIS_ERDDAP = process.env.ERDDAP_INCOIS_BASE || 'https://erddap.incois.gov.in/erddap';
const MODEL_DATASET_ID = process.env.MODEL_DATASET_ID || '';

/**
 * Variable names in the configured dataset, comma-separated as
 * canonical:actual, e.g. "temperature:analysed_sst,salinity:so".
 * Different INCOIS products use different names, so this stays configurable.
 */
const MODEL_VARIABLE_MAP = parseVariableMap(process.env.MODEL_VARIABLES || '');

/**
 * Dimension order of the configured dataset. Almost always one of:
 *   time,latitude,longitude          (2D surface products, e.g. SST)
 *   time,depth,latitude,longitude    (3D products)
 */
const MODEL_DIMENSIONS = (process.env.MODEL_DIMENSIONS || 'time,latitude,longitude')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL_TIME_TOLERANCE_DAYS = Math.max(
  1,
  Number(process.env.MODEL_TIME_TOLERANCE_DAYS || 120),
);

const modelCache = createCache(15 * 60 * 1000);

function parseVariableMap(raw) {
  const map = {};
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [canonical, actual] = pair.split(':').map((s) => s.trim());
    if (canonical && actual) map[canonical] = actual;
  }
  return map;
}

export function isModelConfigured() {
  return Boolean(MODEL_DATASET_ID && Object.keys(MODEL_VARIABLE_MAP).length > 0);
}

/**
 * List gridded datasets on the INCOIS ERDDAP that cover the Indian Ocean.
 * Run this once to find a dataset ID for MODEL_DATASET_ID, then hardcode it in
 * .env rather than discovering on every request.
 */
export async function discoverModelDatasets() {
  const url =
    `${INCOIS_ERDDAP}/tabledap/allDatasets.json` +
    `?datasetID,title,institution,dataStructure,minLongitude,maxLongitude,minLatitude,maxLatitude`;

  const rows = parseTable(await fetchErddapJson(url, { timeoutMs: 20000 }));

  return rows
    .filter((r) => r.dataStructure === 'grid')
    .filter((r) => {
      const lonOk = Number(r.maxLongitude) >= 60 && Number(r.minLongitude) <= 100;
      const latOk = Number(r.maxLatitude) >= 0 && Number(r.minLatitude) <= 30;
      return lonOk && latOk;
    })
    .map((r) => ({
      datasetID: r.datasetID,
      title: r.title,
      institution: r.institution,
      ddsUrl: `${INCOIS_ERDDAP}/griddap/${r.datasetID}.dds`,
    }));
}

/**
 * Model value at a single point.
 * Returns { available: false, reason } rather than a number when the model
 * cannot answer. The caller must render that as "no model data", never as zero
 * and never as an estimate.
 */
export async function fetchModelPoint({ lat, lon, depth = 0, time = null } = {}) {
  if (!isModelConfigured()) {
    return {
      available: false,
      reason:
        'MODEL_DATASET_ID / MODEL_VARIABLES not configured. Run discoverModelDatasets() ' +
        'or browse https://erddap.incois.gov.in/erddap/griddap/index.html to pick a dataset.',
      variables: {},
      source_url: null,
      datasetID: null,
    };
  }

  const stamp = time || 'last';
  const key = `model:${MODEL_DATASET_ID}:${lat}:${lon}:${depth}:${stamp}`;

  return modelCache.wrap(key, async () => {
    const base = `${INCOIS_ERDDAP}/griddap/${MODEL_DATASET_ID}.json`;
    const variables = {};
    const samples = {};
    const errors = [];
    const candidateTimes = stamp === 'last' ? ['last'] : [stamp, 'last'];

    const queryVariable = async (actual, candidateTime) => {
      const ranges = MODEL_DIMENSIONS.map((dim) => {
        if (dim === 'time') return [candidateTime];
        if (dim === 'depth' || dim === 'altitude' || dim === 'LEV' || dim === 'ZAX') {
          return [depth];
        }
        if (dim === 'latitude' || dim === 'lat') return [lat];
        if (dim === 'longitude' || dim === 'lon') return [lon];
        return [0];
      });

      const url = buildGridUrl(base, actual, ranges);
      const rows = parseTable(await fetchErddapJson(url, { timeoutMs: 20000 }));
      return { rows, url };
    };

    for (const [canonical, actual] of Object.entries(MODEL_VARIABLE_MAP)) {
      let answered = false;
      for (const candidateTime of candidateTimes) {
        try {
          const { rows, url } = await queryVariable(actual, candidateTime);
          if (rows.length === 0) {
            if (candidateTime === candidateTimes.at(-1)) {
              errors.push(`${canonical}: no grid cell at that position`);
            }
            continue;
          }

          const row = rows[0];
          const value = sanitize(canonical, row[actual]);
          if (value === null) {
            errors.push(`${canonical}: grid cell contains no valid value`);
            continue;
          }

          variables[canonical] = round(value, 3);
          samples[canonical] = {
            time: row.time ?? null,
            depth: row.ZAX ?? row.depth ?? row.altitude ?? null,
            lat: row.latitude ?? row.lat ?? null,
            lon: row.longitude ?? row.lon ?? null,
            query_url: url,
            requested_time: stamp,
            time_strategy: candidateTime === 'last' && stamp !== 'last'
              ? 'latest available model time'
              : 'requested model time',
          };
          answered = true;
          break;
        } catch (err) {
          if (candidateTime === candidateTimes.at(-1)) {
            errors.push(`${canonical}: ${err.message}`);
          }
        }
      }

      if (!answered && variables[canonical] === undefined) variables[canonical] = null;
    }

    const numericValues = Object.fromEntries(
      Object.entries(variables).filter(([, value]) => typeof value === 'number'),
    );
    const gotSomething = Object.keys(numericValues).length > 0;
    const sampleTimes = Object.values(samples)
      .map((sample) => sample.time)
      .filter(Boolean);
    const actualTime = sampleTimes[0] || null;
    const timeOffsetDays = time && actualTime
      ? Math.abs(new Date(actualTime).getTime() - new Date(time).getTime()) / 86400000
      : null;
    const outsideTimeTolerance = timeOffsetDays != null && timeOffsetDays > MODEL_TIME_TOLERANCE_DAYS;

    return {
      available: gotSomething,
      reason: !gotSomething
        ? errors.join(' | ') || 'model returned no usable values'
        : outsideTimeTolerance
          ? `Nearest model time is ${timeOffsetDays.toFixed(1)} days from the requested observation`
          : null,
      datasetID: MODEL_DATASET_ID,
      source: `incois-erddap-griddap:${MODEL_DATASET_ID}`,
      source_url: `${INCOIS_ERDDAP}/griddap/${MODEL_DATASET_ID}.json`,
      requested: { lat, lon, depth, time: stamp },
      variables: numericValues,
      samples,
      model_time: actualTime,
      time_offset_days: timeOffsetDays,
      time_tolerance_days: MODEL_TIME_TOLERANCE_DAYS,
      errors,
    };
  });
}

/**
 * Normalize the configured connector's variable aliases to the validation
 * contract. A model product may call these fields temp/psal, temperature/
 * salinity, thetao/so, or use the API's unit-bearing names. Missing or
 * non-numeric values stay null; this function never estimates a model value.
 */
export function normalizeModelVariables(variables = {}) {
  const valueFor = (aliases) => {
    for (const alias of aliases) {
      const value = variables[alias];
      if (value === null || value === undefined || value === '') continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  };

  return {
    temp: valueFor(['temp', 'temperature', 'temperature_c', 'thetao']),
    psal: valueFor(['psal', 'salinity', 'salinity_psu', 'salt', 'so']),
  };
}

/** node backend/services/modelGrid.js   -> lists candidate INCOIS datasets */
const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  discoverModelDatasets()
    .then((list) => {
      if (list.length === 0) {
        console.log('No gridded INCOIS datasets matched the Indian Ocean bounds.');
        return;
      }
      console.log(`${list.length} candidate datasets:\n`);
      for (const d of list.slice(0, 25)) {
        console.log(`  ${d.datasetID}\n    ${d.title}\n    dims: ${d.ddsUrl}\n`);
      }
      console.log('Open a .dds URL to read the exact dimension order and variable names,');
      console.log('then set MODEL_DATASET_ID, MODEL_VARIABLES and MODEL_DIMENSIONS in .env');
    })
    .catch((e) => {
      console.error('Discovery failed:', e.message);
      process.exit(1);
    });
}
