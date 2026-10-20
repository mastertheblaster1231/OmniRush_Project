import { apiUrl } from "../services/api.js";

/**
 * Compatibility wrapper for older ocean.html callers.
 * Scientific Argo access is owned by the backend; this module has no direct
 * browser ERDDAP fallback and never synthesizes a profile.
 */
export class ErddapOceanService {
  async fetchFloatProfile(wmoId, { depth = null, time = null } = {}) {
    const platform = String(wmoId || "").replace(/^argo-/i, "").trim();
    if (!platform) throw new Error("An Argo platform number is required");

    const params = new URLSearchParams();
    params.set("platform_number", platform);
    if (depth != null) params.set("depth", String(depth));
    if (time) params.set("time", time);

    const response = await fetch(apiUrl(`/api/profile/${encodeURIComponent(platform)}`));
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.available === false) {
      throw new Error(payload?.error || `Profile API HTTP ${response.status}`);
    }

    const levels = payload.physics?.levels || payload.profile || [];
    if (!levels.length) throw new Error(`No real profile levels for float ${platform}`);

    return {
      source: payload.source || "ifremer-erddap",
      isLive: true,
      wmoId: platform,
      timestamp: payload.time || null,
      data: {
        columnNames: ["platform_number", "time", "latitude", "longitude", "pres", "temp", "psal"],
        rows: levels.map((level) => ({
          platform_number: payload.platform_number || platform,
          time: payload.time || null,
          latitude: payload.lat ?? null,
          longitude: payload.lon ?? null,
          pres: level.depth ?? level.pres ?? null,
          temp: level.temp ?? level.temperature ?? null,
          psal: level.psal ?? level.salinity ?? null,
        })),
      },
    };
  }
}

export const erddapOceanService = new ErddapOceanService();

if (typeof window !== "undefined") {
  window.erddapOceanService = erddapOceanService;
}
