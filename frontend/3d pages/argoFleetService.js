/**
 * argoFleetService.js — Live Argo Fleet Position Data for 3D Globe
 * ================================================================
 * Fetches real-time Argo float positions from IFREMER ERDDAP for the
 * North Indian Ocean basin (Arabian Sea + Bay of Bengal).
 *
 * Developer Control:
 *   - Modify ARGO_FLEET_CONFIG.targetCount to change how many floats appear
 *   - Or call getRealArgoPoints(N) with any count
 *   - Or from browser console: window.reloadArgoFleet(N)
 *
 * Data Flow:
 *   1. Try live ERDDAP fetch (latest 45 days, surface pressure ≤10 dbar)
 *   2. Deduplicate by platform_number, keeping latest profile per float
 *   3. Slice to targetCount
 *   4. On failure, return an empty fleet and expose the unavailable state
 */

// ─── DEVELOPER CONFIGURATION ────────────────────────────────────────────────
// Change these values to control the fleet display

export const ARGO_FLEET_CONFIG = {
  targetCount: 200, // ← How many Argo floats to show on the globe
  regionLatMin: 0, // Southern latitude bound
  regionLatMax: 25, // Northern latitude bound
  regionLonMin: 55, // Western longitude bound
  regionLonMax: 98, // Eastern longitude bound
  timeWindowDays: 45, // How far back to search for recent profiles
  fetchTimeoutMs: 35000, // ERDDAP fetch timeout for public API (35s, international latency)
};

// Expose config on window for console access
if (typeof window !== "undefined") {
  window.ARGO_FLEET_CONFIG = ARGO_FLEET_CONFIG;
  window.argoFleetStatus = {
    isRealTime: false,
    source: "Initializing...",
    totalFloatsFound: 0,
    activeCount: 0,
    latestFetchTime: null,
  };
}

import { apiUrl } from '../services/api.js';

// ─── ERDDAP ENDPOINTS (CORS-RESILIENT) ───────────────────────────────────────
// Primary: backend /api/fleet (server-to-server, no CORS, cached, no abort spam)
// Fallback: Vite proxy (/erddap-proxy) — same-origin, reliable
// Public CORS proxies removed — they are flaky (403/522) and cause spam

function getCandidateErddapUrls() {
  const cfg = ARGO_FLEET_CONFIG;
  const backendFleetUrl = apiUrl(`/api/fleet?lat_min=${cfg.regionLatMin}&lat_max=${cfg.regionLatMax}&lon_min=${cfg.regionLonMin}&lon_max=${cfg.regionLonMax}&days=${cfg.timeWindowDays}`);
  return [backendFleetUrl];
}

// Helper to detect backend fleet response (already array, not raw ERDDAP table)
function isBackendFleetResponse(data) {
  return Array.isArray(data) && data.length > 0 && data[0].id && data[0].lat != null;
}

// ─── MAIN FETCH FUNCTION ────────────────────────────────────────────────────

/**
 * Fetch real-time Argo float positions from ERDDAP.
 * @param {number} [targetCount] - Number of floats to return (default: ARGO_FLEET_CONFIG.targetCount)
 * @returns {Promise<Array>} Array of float objects compatible with World.js argoPoints shape
 */
export async function getRealArgoPoints(targetCount) {
  const count = targetCount || ARGO_FLEET_CONFIG.targetCount;

  try {
    const candidateUrls = getCandidateErddapUrls();
    let data = null;
    let successUrl = null;

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          ARGO_FLEET_CONFIG.fetchTimeoutMs,
        );

        const isBackend = url.includes('/api/fleet');
        console.info(
          `[ArgoFleet] 🛰️ Fetching ${isBackend ? 'backend' : 'ERDDAP'} from: ${url.slice(0, 80)}...`,
        );
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const parsed = await response.json();
          // Backend /api/fleet returns array directly (no table)
          if (isBackendFleetResponse(parsed)) {
            data = parsed;
            successUrl = url;
            console.info(
              `[ArgoFleet] ✓ Backend fleet received via: ${url.slice(0, 50)}... (${data.length} floats)`,
            );
            break;
          }
          if (
            parsed &&
            parsed.table &&
            parsed.table.rows &&
            parsed.table.rows.length > 0
          ) {
            data = parsed;
            successUrl = url;
            console.info(
              `[ArgoFleet] ✓ ERDDAP response received via: ${url.slice(0, 50)}... (${data.table.rows.length} rows)`,
            );
            break;
          }
        }
      } catch (endpointErr) {
        // AbortError is expected on timeout / rapid navigation, don't spam as warn
        const isAbort = endpointErr.name === 'AbortError' || /aborted/i.test(endpointErr.message);
        if (isAbort) {
          console.info(`[ArgoFleet] Request aborted (timeout or navigation): ${url.slice(0, 45)}...`);
        } else {
          console.warn(
            `[ArgoFleet] Endpoint attempt failed (${url.slice(0, 45)}...):`,
            endpointErr.message,
          );
        }
      }
    }

    if (!data) {
      throw new Error("All ERDDAP endpoints failed or were blocked");
    }

    // If backend returned array, use it directly (already deduplicated)
    let uniqueFloats;
    let rowsForLog = 0;
    if (Array.isArray(data)) {
      uniqueFloats = data;
      rowsForLog = data.length;
      console.info(
        `[ArgoFleet] 🟢 BACKEND DATA: ${uniqueFloats.length} live floats via /api/fleet`,
      );
    } else {
      if (!data.table || !data.table.rows) {
        throw new Error("All ERDDAP endpoints failed or were blocked");
      }
      const colNames = data.table.columnNames;
      const rows = data.table.rows;
      rowsForLog = rows.length;
      const pIdx = colNames.indexOf("platform_number");
      const timeIdx = colNames.indexOf("time");
      const latIdx = colNames.indexOf("latitude");
      const lonIdx = colNames.indexOf("longitude");
      const tempIdx = colNames.indexOf("temp");
      const psalIdx = colNames.indexOf("psal");

      // Deduplicate: keep only the latest profile record per unique platform ID
      const latestFloatsMap = new Map();
      for (const r of rows) {
        const id = String(r[pIdx]);
        const timestamp = new Date(r[timeIdx]).getTime();
        const lat = Number(r[latIdx]);
        const lon = Number(r[lonIdx]);

        // Skip invalid or NaN coordinates
        if (isNaN(lat) || isNaN(lon)) continue;

        if (
          !latestFloatsMap.has(id) ||
          latestFloatsMap.get(id).rawTime < timestamp
        ) {
          const surfaceTemp =
            r[tempIdx] !== null && !isNaN(r[tempIdx])
              ? Number(Number(r[tempIdx]).toFixed(1))
              : null;
          const surfaceSalinity =
            r[psalIdx] !== null && !isNaN(r[psalIdx])
              ? Number(Number(r[psalIdx]).toFixed(2))
              : null;
          const region = lon > 78 ? "Bay of Bengal" : "Arabian Sea";

          latestFloatsMap.set(id, {
            // Shape compatible with existing argoPoints consumers
            id: id,
            code: id,
            altId: id,
            wmoId: Number(id) || 0,
            name: `Argo ${id}`,
            platform_number: id,
            rawTime: timestamp,
            time: r[timeIdx],
            lat: Number(lat.toFixed(4)),
            lon: Number(lon.toFixed(4)),
            sea: region,
            type: "Argo Profiling Float",
            markerType: "buoy-yellow",
            beaconColor: 0x00f0ff, // Default cyan; temperature toggle changes this
            surfaceTemp: surfaceTemp,
            surfaceSalinity: surfaceSalinity,
            maxDepth: null,
            status: "Active",
            region: region,
            isRealTime: true,
            dataSource: "IFREMER ERDDAP (Live)",
          });
        }
      }

      uniqueFloats = Array.from(latestFloatsMap.values());
      console.info(
        `[ArgoFleet] 🟢 REAL-TIME DATA CONFIRMED: ERDDAP returned ${rows.length} rows → ${uniqueFloats.length} unique live floats in Indian Ocean basin.`,
      );
    }

    if (typeof window !== "undefined") {
      const src = uniqueFloats[0]?.dataSource || (Array.isArray(data) ? "Backend /api/fleet (Live)" : "IFREMER ERDDAP (Live Real-Time)");
      window.argoFleetStatus = {
        isRealTime: true,
        source: src,
        totalFloatsFound: uniqueFloats.length,
        activeCount: Math.min(count, uniqueFloats.length),
        latestFetchTime: new Date().toISOString(),
      };
      window.argoAllBasinFloats = uniqueFloats;
      window.dispatchEvent(
        new CustomEvent("argoFleetLoaded", {
          detail: { ...window.argoFleetStatus, floats: uniqueFloats },
        }),
      );
    }

    // Return exactly targetCount floats
    if (uniqueFloats.length >= 20) {
      return uniqueFloats.slice(0, count);
    }

    return uniqueFloats.slice(0, count);
  } catch (err) {
    console.warn(
      "[ArgoFleet] ⚠️ ERDDAP live fetch unavailable — no Argo fleet will be fabricated:",
      err.message,
    );
    if (typeof window !== "undefined") {
      window.argoFleetStatus = {
        isRealTime: false,
        source: "Unavailable",
        totalFloatsFound: 0,
        activeCount: 0,
        latestFetchTime: new Date().toISOString(),
        error: err.message,
      };
      window.argoAllBasinFloats = [];
      window.dispatchEvent(
        new CustomEvent("argoFleetLoaded", { detail: { ...window.argoFleetStatus, floats: [] } }),
      );
    }
    return [];
  }
}
