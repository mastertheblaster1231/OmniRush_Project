/**
 * argoBackendService.js — BGC Argo Data Fetcher for 3D Telemetry
 * Communicates with the Python FastAPI Backend
 */

import { apiUrl } from './api.js';

let fetchController = null;

/**
 * Fetches BGC Argo telemetry from the backend at a specific depth
 * Includes request cancellation to debounce rapid depth-slider events.
 */
export async function fetchArgoDepthSlice(platformNumber = '2902251', depth = 2.0, timestamp = null) {
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();

  // Primary endpoint + alias fallback chain — fixes 404 when only Python or only Node backend is running
  const endpoints = [
    apiUrl(`/api/argo/depth-slice?platform_number=${encodeURIComponent(platformNumber)}&depth=${depth}`),
    apiUrl(`/api/depth-slice?platform_number=${encodeURIComponent(platformNumber)}&depth=${depth}`),
  ];

  for (const baseUrl of endpoints) {
    let url = baseUrl;
    if (timestamp) url += `&timestamp=${encodeURIComponent(timestamp)}`;

    try {
      const response = await fetch(url, { signal: fetchController.signal });
      if (!response.ok) {
        // Try next alias endpoint before throwing
        if (response.status === 404 && baseUrl !== endpoints[endpoints.length - 1]) continue;
        throw new Error(`Backend responded with HTTP ${response.status}`);
      }
      const data = await response.json();
      fetchController = null;
      return data;
    } catch (error) {
      if (error.name === 'AbortError') return null;
      // If this was the last endpoint in the chain, fail explicitly
      if (baseUrl === endpoints[endpoints.length - 1]) {
        console.warn('[argoBackendService] All depth-slice endpoints failed:', error.message);
        fetchController = null;
        return null;
      }
      // otherwise try next endpoint
      continue;
    }
  }
    fetchController = null;
  return null;
}

/**
 * Fetches depth-first Argo telemetry from the backend.
 *
 * The backend (scripts/fleet_telemetry_engine.py) locks in the requested
 * depth and scans the float's ENTIRE history for the closest pressure
 * reading, returning { success, platform_id, time_status, location,
 * depth_status, telemetry }. The optional date only qualifies time_status
 * (e.g. "Exact Depth Match -> Nearest Time"); it does not drive the search.
 *
 * @param {string} platformId  Argo platform number (e.g. "2902351" or "argo-2902351")
 * @param {number} depth       Target depth in meters/dbar (default 15.0)
 * @param {string|null} date   Optional ISO-8601 timestamp; null/"" = latest real-time
 * @returns {Promise<Object|null>} Telemetry payload or null on failure
 */
export async function fetchTelemetry(platformId, depth = 15.0, date = null) {
  const platform = String(platformId || '')
    .replace(/^argo-/i, '')
    .replace(/^Argo\s+/i, '')
    .trim();

  if (!platform) {
    console.warn('[argoBackendService] fetchTelemetry: missing platformId');
    return null;
  }

  // Cancel any in-flight request to debounce rapid slider events.
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();

  const params = new URLSearchParams();
  params.set('platform', platform);
  params.set('depth', String(depth));
  if (date) params.set('date', date);

  // Primary endpoint + alias fallback (matches the float-details alias pattern).
  const endpoints = [
    apiUrl(`/api/telemetry?${params.toString()}`),
    apiUrl(`/api/argo/telemetry?${params.toString()}`),
  ];

  for (const baseUrl of endpoints) {
    try {
      const response = await fetch(baseUrl, { signal: fetchController.signal });
      if (!response.ok) {
        if (response.status === 404 && baseUrl !== endpoints[endpoints.length - 1]) continue;
        throw new Error(`Backend responded with HTTP ${response.status}`);
      }
      const data = await response.json();
      fetchController = null;
      return data;
    } catch (error) {
      if (error.name === 'AbortError') return null;
      if (baseUrl === endpoints[endpoints.length - 1]) {
        console.warn('[argoBackendService] All telemetry endpoints failed:', error.message);
        fetchController = null;
        return null;
      }
      continue;
    }
  }
  fetchController = null;
  return null;
}
