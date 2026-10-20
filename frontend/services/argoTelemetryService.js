import { fetchArgoValidation, normalizeArgoPlatformId } from './argoValidationService.js';

/**
 * Compatibility wrapper for older telemetry consumers. It now uses the same
 * backend validation contract as the main Argo slice and never returns an
 * analytical/offline number.
 */
export async function fetchArgoTelemetry(wmoId, depth = 0, timestamp = null) {
  const platform = normalizeArgoPlatformId(wmoId);
  const validation = await fetchArgoValidation(
    platform,
    depth,
    timestamp || new Date().toISOString(),
  );

  return {
    wmoId: platform,
    time: validation.time,
    latitude: validation.location.lat,
    longitude: validation.location.lon,
    depth,
    temperature: validation.observed.temperature,
    salinity: validation.observed.salinity,
    status: validation.qc || 'Backend QC status unavailable',
    source: validation.obsSource,
    modelSource: validation.modelSource,
    isLive: true,
  };
}

export function clearTelemetryCache() {
  // Kept for compatibility. The canonical backend request is intentionally
  // not cached in the browser so provenance always matches the request.
}
