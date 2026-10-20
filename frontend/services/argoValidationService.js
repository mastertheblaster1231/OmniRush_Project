import { apiUrl } from './api.js';

/**
 * The validation endpoint is the source of truth for an Argo observation/model
 * comparison.  This service deliberately has no numerical fallback: a missing
 * model value remains null all the way to the UI.
 */
const VALIDATION_PATH = '/api/argo/validation';
const COMPATIBILITY_VALIDATION_PATH = '/api/validation';
const MAX_ARGO_DEPTH_METRES = 2100;

export function normalizeArgoPlatformId(platformNumber) {
  return String(platformNumber || '')
    .replace(/^argo-/i, '')
    .replace(/^argo\s+/i, '')
    .trim();
}

export async function fetchArgoValidation(
  platformNumber,
  depth,
  timestamp = new Date().toISOString(),
  { signal } = {},
) {
  const platform = normalizeArgoPlatformId(platformNumber);
  if (!platform) throw new Error('An Argo platform number is required');

  const params = new URLSearchParams({
    platform_number: platform,
    depth: String(Math.max(0, Math.min(MAX_ARGO_DEPTH_METRES, Number(depth) || 0))),
    time: timestamp || new Date().toISOString(),
  });

  let response = await fetch(apiUrl(`${VALIDATION_PATH}?${params}`), { signal });

  // Some already deployed backend instances expose the same handler at the
  // pre-namespace alias. Prefer the canonical route above, but keep those
  // deployments usable without manufacturing any data in the browser.
  if (response.status === 404) {
    response = await fetch(apiUrl(`${COMPATIBILITY_VALIDATION_PATH}?${params}`), { signal });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.error) {
    throw new Error(payload?.error || `Validation API HTTP ${response.status}`);
  }

  return normalizeArgoValidation(
    payload,
    platform,
    Math.max(0, Math.min(MAX_ARGO_DEPTH_METRES, Number(depth) || 0)),
  );
}

export function normalizeArgoValidation(payload, platformNumber, requestedDepth) {
  const modelAvailable = payload?.model?.available === true;
  const modelSource = modelAvailable
    ? payload.model?.source || payload.model?.data_source || null
    : null;
  const observationSource =
    payload?.observation_source ||
    payload?.source ||
    payload?.variables?.find((variable) => variable?.observed_source)?.observed_source ||
    'ifremer-erddap';
  const qc =
    payload?.qc ||
    payload?.qc_status ||
    payload?.provenance?.qc?.policy ||
    'QC status supplied by backend';

  const location = payload?.location || payload?.metadata?.coordinates || {};
  const provenance = payload?.provenance || payload?.matching_metadata || {};
  const observationDepth =
    numericOrNull(provenance.observationDepth ?? provenance.observation_depth) ??
    parseDepth(payload?.depth_level) ??
    numericOrNull(payload?.observation_depth) ??
    numericOrNull(requestedDepth);
  const reportedModelDepth =
    numericOrNull(provenance.modelDepth ?? provenance.model_depth) ??
    numericOrNull(payload?.model_depth);
  const modelDepth = modelAvailable ? reportedModelDepth ?? requestedDepth : null;

  const variables = [
    makeVariable('temperature', 'Temperature', '°C', payload, ['temp', 'temperature']),
    makeVariable('salinity', 'Salinity', 'PSU', payload, ['psal', 'salinity']),
    makeVariable(
      'dissolvedOxygen',
      'Dissolved O₂',
      'µmol/kg',
      payload,
      ['doxy', 'dissolved_oxygen', 'dissolvedOxygen'],
    ),
    makeVariable(
      'chlorophyll',
      'Chlorophyll-a',
      'mg/m³',
      payload,
      ['chla', 'chlorophyll', 'chlorophyll_a'],
    ),
    unavailableVariable(
      'currentSpeed',
      'Current Speed',
      'm/s',
      'Argo floats do not measure current speed',
    ),
    unavailableVariable(
      'currentDirection',
      'Current Direction',
      '°',
      'Argo floats do not measure current direction',
    ),
  ];

  const observed = Object.fromEntries(variables.map((variable) => [variable.key, variable.observed]));
  const modelValues = Object.fromEntries(variables.map((variable) => [variable.key, variable.model]));
  const delta = Object.fromEntries(variables.map((variable) => [variable.key, variable.delta]));

  return {
    ...payload,
    platform_number: payload.platform_number || platformNumber,
    time: payload.time || payload.timestamp || null,
    location: {
      lat: numericOrNull(location.lat ?? location.latitude),
      lon: numericOrNull(location.lon ?? location.longitude),
    },
    variables,
    observed,
    modelValues,
    delta,
    provenance: {
      targetDepth: numericOrNull(provenance.targetDepth ?? provenance.target_depth) ?? requestedDepth,
      observationDepth,
      modelDepth,
      matchingMethod:
        provenance.matchingMethod ||
        provenance.matching_method ||
        (observationDepth === requestedDepth ? 'Exact/Interpolated' : 'Nearest Valid'),
      observationSource,
      modelSource,
    },
    model: {
      ...(payload.model || {}),
      available: modelAvailable,
      source: modelSource,
      reason: modelAvailable
        ? payload.model?.reason || null
        : payload.model?.reason || 'Model unavailable for this location/time/depth',
    },
    modelSource,
    obsSource: observationSource,
    qc,
  };
}

function makeVariable(key, name, unit, payload, aliases) {
  const backendVariable = (payload?.variables || []).find((variable) =>
    aliases.includes(variable?.key),
  );
  const observed = numericOrNull(
    backendVariable?.observed ??
      readNested(payload?.observed, aliases) ??
      readNested(payload?.primary_oceanographic_variables, aliases),
  );
  const model =
    payload?.model?.available === true
      ? numericOrNull(backendVariable?.model ?? readNested(payload?.model, aliases))
      : null;
  const delta =
    observed != null && model != null
      ? numericOrNull(backendVariable?.delta) ?? observed - model
      : null;

  return {
    key,
    name: backendVariable?.name || name,
    unit: backendVariable?.unit || unit,
    observed,
    model,
    delta,
    observedSource: backendVariable?.observed_source || 'ifremer-erddap',
    modelSource: payload?.model?.available === true ? payload.model?.source || null : null,
    qc: backendVariable?.qc || payload?.qc || null,
    reason:
      backendVariable?.reason ||
      (observed == null ? 'No QC-passing observation at the requested depth' : null) ||
      (model == null ? 'Model unavailable' : null),
  };
}

function unavailableVariable(key, name, unit, reason) {
  return {
    key,
    name,
    unit,
    observed: null,
    model: null,
    delta: null,
    observedSource: null,
    modelSource: null,
    qc: null,
    reason,
  };
}

function readNested(object, aliases) {
  if (!object) return null;
  for (const alias of aliases) {
    const value = object[alias];
    if (value !== undefined && value !== null) return value;
    const snake = alias.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (object[snake] !== undefined && object[snake] !== null) return object[snake];
  }
  return null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDepth(value) {
  if (typeof value !== 'string') return numericOrNull(value);
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? numericOrNull(match[0]) : null;
}
