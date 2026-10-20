import {
  CORE_DATASET,
  CORE_SOURCE_URL,
  fetchCoreProfile,
  interpolateAt,
} from './argoCore.js';
import { normalizeModelVariables, fetchModelPoint, isModelConfigured } from './modelGrid.js';
import { round } from './sanitize.js';

const VALIDATION_VARIABLES = ['temp', 'psal'];

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function valuesWithNumbers(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => isFiniteNumber(value))
  );
}

/**
 * Compute Observed - Model without filling missing sides of the comparison.
 * The returned object contains only variables for which both inputs are real
 * finite numbers.
 */
export function buildDelta(observations = {}, model = {}) {
  const delta = {};
  for (const variable of VALIDATION_VARIABLES) {
    if (isFiniteNumber(observations[variable]) && isFiniteNumber(model[variable])) {
      delta[variable] = round(observations[variable] - model[variable], 3);
    }
  }
  return delta;
}

function variableAvailability(values) {
  return Object.fromEntries(
    VALIDATION_VARIABLES.map((variable) => [variable, isFiniteNumber(values[variable])])
  );
}

function missingVariableReasons(values, label) {
  return VALIDATION_VARIABLES
    .filter((variable) => !isFiniteNumber(values[variable]))
    .map((variable) => `${label} ${variable} is unavailable`);
}

function interpolationBracket(levels, targetDepth, variable) {
  const points = levels
    .filter((level) => isFiniteNumber(level[variable]))
    .sort((a, b) => a.depth - b.depth);

  if (!points.length || targetDepth < points[0].depth || targetDepth > points.at(-1).depth) {
    return null;
  }
  if (points.length === 1) return [points[0].depth, points[0].depth];

  for (let index = 0; index < points.length - 1; index += 1) {
    const low = points[index];
    const high = points[index + 1];
    if (low.depth <= targetDepth && targetDepth <= high.depth) {
      return [low.depth, high.depth];
    }
  }
  return null;
}

function unavailableModel(reason) {
  return {
    available: false,
    values: {},
    available_variables: { temp: false, psal: false },
    requested_depth: null,
    source: null,
    dataset: null,
    source_url: null,
    reason,
  };
}

/**
 * Fetch one real IFREMER core cycle and compare its QC-filtered, interpolated
 * temperature/salinity with the configured real model connector, if any.
 *
 * This service deliberately has no fallback values. A missing model, missing
 * sensor, failed QC value, or out-of-range interpolation remains unavailable.
 */
export async function fetchValidationSlice({ platformNumber, depth, time = null } = {}) {
  const profile = await fetchCoreProfile(platformNumber, { atTime: time });

  const observations = {
    temp: round(interpolateAt(profile.levels, depth, 'temp'), 3),
    psal: round(interpolateAt(profile.levels, depth, 'salinity'), 3),
  };
  const observationAvailability = variableAvailability(observations);

  const modelAttempted =
    isModelConfigured() && Number.isFinite(profile.lat) && Number.isFinite(profile.lon);
  let modelResult;

  if (!isModelConfigured()) {
    modelResult = unavailableModel(
      'No verified model dataset is configured; MODEL_DATASET_ID and MODEL_VARIABLES are required.'
    );
  } else if (!modelAttempted) {
    modelResult = unavailableModel(
      'Model lookup skipped because the selected Argo cycle has no valid latitude/longitude.'
    );
  } else {
    try {
      const fetchedModel = await fetchModelPoint({
        lat: profile.lat,
        lon: profile.lon,
        depth,
        time: profile.time,
      });
      const modelValues = valuesWithNumbers(normalizeModelVariables(fetchedModel.variables));
      modelResult = {
        ...fetchedModel,
        available: Object.keys(modelValues).length > 0,
        values: modelValues,
        available_variables: variableAvailability(modelValues),
        requested_depth: depth,
        dataset: fetchedModel.datasetID ?? null,
        source_url: fetchedModel.source_url ?? null,
        reason:
          fetchedModel.reason ||
          (Object.keys(modelValues).length
            ? null
            : 'The configured model returned no usable temperature or salinity values.'),
      };
    } catch (error) {
      modelResult = unavailableModel(`Model lookup failed: ${error.message}`);
      modelResult.requested_depth = depth;
    }
  }

  const modelValues = modelResult.values || {};
  const delta = buildDelta(observations, modelValues);
  const deltaAvailability = variableAvailability(delta);
  const reasons = [
    ...missingVariableReasons(observations, 'Observation'),
    ...missingVariableReasons(modelValues, 'Model'),
  ];
  if (modelResult.reason) reasons.push(`Model: ${modelResult.reason}`);
  if (!Object.keys(delta).length) {
    reasons.push('Delta is unavailable until both the observation and model value exist for a variable.');
  }

  const matchingMethod = time
    ? 'nearest real IFREMER core cycle within the requested-time search window'
    : 'latest real IFREMER core cycle in the live search window';
  const observationBrackets = Object.fromEntries(
    VALIDATION_VARIABLES.map((variable) => [
      variable,
      interpolationBracket(
        profile.levels,
        depth,
        variable === 'psal' ? 'salinity' : variable
      ),
    ])
  );
  const variableRows = [
    {
      key: 'temp',
      name: 'Temperature',
      unit: '°C',
      observed: observations.temp,
      model: modelValues.temp ?? null,
      delta: delta.temp ?? null,
      observed_source: 'ifremer-erddap',
      model_source: modelResult.source || null,
      reason: observationAvailability.temp
        ? modelValues.temp === undefined
          ? 'Model temperature is unavailable'
          : null
        : 'No QC-passing temperature bracket at the requested depth',
    },
    {
      key: 'psal',
      name: 'Salinity',
      unit: 'PSU',
      observed: observations.psal,
      model: modelValues.psal ?? null,
      delta: delta.psal ?? null,
      observed_source: 'ifremer-erddap',
      model_source: modelResult.source || null,
      reason: observationAvailability.psal
        ? modelValues.psal === undefined
          ? 'Model salinity is unavailable'
          : null
        : 'No QC-passing salinity bracket at the requested depth',
    },
  ];

  return {
    platform_number: profile.platform_number,
    cycle_number: profile.cycle_number,
    requested_time: time,
    time: profile.time,
    location: { lat: profile.lat, lon: profile.lon },
    requested_depth: depth,
    observation_depth: depth,
    model_depth: modelAttempted ? depth : null,
    observation_source: 'ifremer-erddap',
    variables: variableRows,

    observations: {
      available: Object.keys(observationAvailability).some((key) => observationAvailability[key]),
      temp: observations.temp,
      psal: observations.psal,
      values: observations,
      available_variables: observationAvailability,
      depth: depth,
      units: { temp: '°C', psal: 'PSU' },
      interpolation: 'linear between QC-passing measured levels; null outside the measured range',
      source: 'ifremer-erddap',
      dataset: CORE_DATASET,
      source_url: profile.source_url || CORE_SOURCE_URL,
      reason:
        Object.keys(observationAvailability).every((key) => observationAvailability[key])
          ? null
          : 'One or more requested observation variables had no QC-passing bracket at this depth.',
    },

    model: {
      available: modelResult.available === true,
      temp: modelValues.temp ?? null,
      psal: modelValues.psal ?? null,
      values: modelValues,
      available_variables: modelResult.available_variables || variableAvailability(modelValues),
      requested_depth: modelResult.requested_depth,
      depth: modelResult.requested_depth,
      units: { temp: '°C', psal: 'PSU' },
      source: modelResult.source || null,
      dataset: modelResult.dataset || modelResult.datasetID || null,
      source_url: modelResult.source_url || null,
      requested_time: profile.time,
      reason: modelResult.reason || null,
    },

    delta: {
      available: Object.keys(delta).length > 0,
      temp: delta.temp ?? null,
      psal: delta.psal ?? null,
      values: delta,
      available_variables: deltaAvailability,
      formula: 'observation - model',
      units: { temp: '°C', psal: 'PSU' },
      reason:
        Object.keys(delta).length > 0
          ? null
          : 'No variable has both a real observation and a real model value.',
    },

    availability: {
      observations: { ...observationAvailability },
      model: { ...(modelResult.available_variables || variableAvailability(modelValues)) },
      delta: { ...deltaAvailability },
    },

    provenance: {
      platform: profile.platform_number,
      cycle: profile.cycle_number,
      timestamp: profile.time,
      requested_time: time,
      location: { lat: profile.lat, lon: profile.lon },
      requested_depth: depth,
      observation_depth: depth,
      model_depth: modelAttempted ? depth : null,
      matching_method: matchingMethod,
      depth_method: 'linear interpolation of real QC-passing IFREMER core observations',
      observation_interpolation_brackets: observationBrackets,
      qc: {
        policy: 'Argo QC flags 1, 2, and 5 plus physical-range checks; rejected values remain absent',
        accepted_flags: ['1', '2', '5'],
        interpolation_excludes_missing_or_rejected_values: true,
      },
      source_urls: {
        observations: profile.source_url || CORE_SOURCE_URL,
        model: modelResult.source_url || null,
      },
      datasets: {
        observations: CORE_DATASET,
        model: modelResult.dataset || modelResult.datasetID || null,
      },
    },
    reasons,
  };
}

export { VALIDATION_VARIABLES };
