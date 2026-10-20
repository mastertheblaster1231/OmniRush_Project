import { useEffect, useState } from "react";
import { apiUrl } from "../../services/api.js";

/**
 * ArgoTelemetryFetcher.jsx — Lightweight Argo float telemetry fetcher.
 *
 * Fetches GET /api/telemetry?platform=<id>[&depth=<m>][&date=<iso>] from
 * the backend (server/routes/telemetry.js) whenever `selectedArgoId`
 * changes, and renders the depth-first match it returns. Pass `null` for
 * `selectedArgoId` (the default, before anything is clicked on the globe)
 * to show the empty-state message instead of fetching.
 *
 * This is a lightweight companion to the full TelemetryPanel.jsx (which is
 * Zustand-driven and lives in panels/). Use this directly wherever you just
 * need to surface /api/telemetry data for a selected float ID, e.g. wired
 * to `useSelectedArgoFloat()`:
 *
 *   const [selectedArgoId] = useSelectedArgoFloat();
 *   <ArgoTelemetryFetcher selectedArgoId={selectedArgoId} />
 *
 * NOTE ON FIELD NAMES: telemetry.js's own console.log lines read
 * `location.lat` / `location.lon` and `telemetry.temp` / `telemetry.salinity`
 * — that's what this component reads first. Some versions of the Python
 * engine instead emit `latitude` / `longitude` and
 * `temperature_c` / `salinity_psu`; the getField() fallbacks below cover
 * both so a schema mismatch shows real data instead of silent blanks.
 * Once you've confirmed which schema your deployed engine actually
 * returns, feel free to drop the fallback you don't need.
 */
export default function ArgoTelemetryFetcher({ selectedArgoId, depth, date }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selectedArgoId) {
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ platform: selectedArgoId });
    if (depth !== undefined && depth !== null) params.set("depth", String(depth));
    if (date) params.set("date", date);

    fetch(apiUrl(`/api/telemetry?${params.toString()}`), {
      signal: controller.signal,
    })
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload || payload.success === false) {
          throw new Error(payload?.error || `Request failed (${res.status})`);
        }
        return payload;
      })
      .then((payload) => setData(payload))
      .catch((err) => {
        if (err.name === "AbortError") return; // selection changed mid-fetch — ignore
        setError(err.message || "Failed to load telemetry");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [selectedArgoId, depth, date]);

  if (!selectedArgoId) {
    return (
      <div className="telemetry-panel telemetry-panel--empty">
        Select an Argo float on the map to view telemetry.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="telemetry-panel telemetry-panel--loading">
        Loading telemetry for {selectedArgoId}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="telemetry-panel telemetry-panel--error">
        Couldn&apos;t load telemetry for {selectedArgoId}: {error}
      </div>
    );
  }

  if (!data) return null;

  const ts = data.time_status || {};
  const loc = data.location || {};
  const ds = data.depth_status || {};
  const tel = data.telemetry || {};

  const lat = getField(loc, "lat", "latitude");
  const lon = getField(loc, "lon", "longitude");
  const temp = getField(tel, "temp", "temperature_c");
  const salinity = getField(tel, "salinity", "salinity_psu");
  const matchedDepth = getField(ds, "matched", "matched_dbar");
  const requestedDepth = getField(ds, "requested", "requested_meters");

  return (
    <div className="telemetry-panel">
      <h3 className="telemetry-panel__title">Argo Float {data.platform_id}</h3>

      <div className="telemetry-panel__row">
        <span>Location</span>
        <span>
          {fmt(lat)}°, {fmt(lon)}°
        </span>
      </div>

      <div className="telemetry-panel__row">
        <span>Matched time</span>
        <span>{ts.matched ?? "—"}</span>
      </div>
      {ts.match_type && (
        <div className="telemetry-panel__row telemetry-panel__row--muted">
          <span>{ts.match_type}</span>
          {ts.days_difference ? <span>Δ {ts.days_difference} day(s)</span> : null}
        </div>
      )}

      <div className="telemetry-panel__row">
        <span>Depth</span>
        <span>
          {fmt(matchedDepth)} m (requested {fmt(requestedDepth)} m)
        </span>
      </div>

      <hr className="telemetry-panel__divider" />

      <div className="telemetry-panel__row">
        <span>Temperature</span>
        <span>{fmt(temp)} °C</span>
      </div>
      <div className="telemetry-panel__row">
        <span>Salinity</span>
        <span>{fmt(salinity)} PSU</span>
      </div>
      <div className="telemetry-panel__row">
        <span>Dissolved O₂</span>
        <span>{fmt(tel.dissolved_o2)} µmol/kg</span>
      </div>
      <div className="telemetry-panel__row">
        <span>Chlorophyll</span>
        <span>{fmt(tel.chlorophyll)} mg/m³</span>
      </div>
    </div>
  );
}

function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function fmt(value) {
  if (value === undefined || value === null) return "—";
  return typeof value === "number" ? value.toFixed(2) : value;
}
