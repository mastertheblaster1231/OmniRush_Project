import { useState, useCallback } from 'react';
import { fetchTelemetry } from '../services/argoBackendService.js';

/**
 * useFleetTelemetry
 * -----------------
 * React hook that fetches depth-first Argo telemetry for a float.
 *
 * The backend engine (scripts/fleet_telemetry_engine.py) locks in the
 * requested depth and scans the float's ENTIRE history for the closest
 * pressure reading, so the result is always anchored to the requested depth.
 *
 * @param {string} platformId   Argo platform number (e.g. "2902351")
 * @param {number} depth        Target depth in m/dbar (default 15)
 * @param {string|null} date    Optional ISO-8601 timestamp; null/"" = latest real-time
 * @returns {{ telemetry: object|null, loading: boolean, error: string|null,
 *            refetch: (function|undefined) }}
 */
export function useFleetTelemetry(platformId, depth = 15, date = null) {
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!platformId) {
      setError('Missing platformId');
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await fetchTelemetry(platformId, depth, date);

      if (!data) {
        setError('No telemetry data returned');
        setTelemetry(null);
        return null;
      }

      if (!data.success) {
        setError(data.error || 'Telemetry request failed');
        setTelemetry(null);
        return null;
      }

      setTelemetry(data);
      return data;
    } catch (err) {
      setError(err.message || 'Failed to fetch telemetry');
      setTelemetry(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [platformId, depth, date]);

  return { telemetry, loading, error, refetch };
}

export default useFleetTelemetry;
