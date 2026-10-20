/**
 * Live Argo profile access.
 *
 * The backend owns ERDDAP access and QC. The browser does not substitute a
 * bundled profile, analytical values, or a synthetic float when this request
 * fails.
 */

import { apiUrl } from './api.js';

const PROFILE_TIMEOUT_MS = 25000;

export async function fetchLiveArgoProfile(platformNumber) {
  const id = String(platformNumber || '').replace(/^argo-/i, '').trim();
  if (!id) throw new Error('An Argo platform number is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(`/api/profile/${encodeURIComponent(id)}`), {
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.available === false) {
      throw new Error(payload?.error || `Profile API HTTP ${response.status}`);
    }

    const levels = payload.physics?.levels || payload.profile || [];
    if (!levels.length) throw new Error(`No QC-passing profile levels for float ${id}`);

    return {
      floatId: String(payload.platform_number || id),
      name: `Argo Float #${payload.platform_number || id}`,
      timestamp: payload.time || null,
      lat: numericOrNull(payload.lat ?? payload.latitude),
      lon: numericOrNull(payload.lon ?? payload.longitude),
      cycle: payload.cycle_number ?? null,
      source: payload.source || 'ifremer-erddap',
      qcStatus: payload.qc || 'backend QC applied',
      profile: levels
        .map((level) => ({
          depth: numericOrNull(level.depth ?? level.pres),
          temperature: numericOrNull(level.temp ?? level.temperature),
          salinity: numericOrNull(level.psal ?? level.salinity),
          temperatureQc: level.temp_qc ?? null,
          salinityQc: level.psal_qc ?? null,
        }))
        .filter((level) => level.depth != null)
        .sort((a, b) => a.depth - b.depth),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return an interpolated profile value only when a real profile brackets the
 * requested depth. Outside the measured range, null is more honest than a
 * clamped value from another depth.
 */
export function getProfileAtDepth(profile, depthM) {
  const points = (profile?.profile || []).filter(
    (point) => point.depth != null && point.temperature != null && point.salinity != null,
  );
  if (!points.length) {
    return { depth: depthM, temperature: null, salinity: null };
  }

  const depth = Number(depthM);
  if (!Number.isFinite(depth) || depth < points[0].depth || depth > points[points.length - 1].depth) {
    return { depth, temperature: null, salinity: null };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const lower = points[index];
    const upper = points[index + 1];
    if (lower.depth <= depth && depth <= upper.depth) {
      if (lower.depth === upper.depth) {
        return { depth, temperature: lower.temperature, salinity: lower.salinity };
      }
      const fraction = (depth - lower.depth) / (upper.depth - lower.depth);
      return {
        depth,
        temperature: interpolate(lower.temperature, upper.temperature, fraction),
        salinity: interpolate(lower.salinity, upper.salinity, fraction),
      };
    }
  }

  return { depth, temperature: null, salinity: null };
}

function interpolate(lower, upper, fraction) {
  return Number((lower + fraction * (upper - lower)).toFixed(3));
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
