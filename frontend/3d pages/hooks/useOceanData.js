import { useEffect, useState } from 'react';

/**
 * Backend base URL — from frontend/.env VITE_BACKEND_URL.
 * - Local dev: VITE_BACKEND_URL=http://localhost:8000 (direct)
 * - Prod: VITE_BACKEND_URL= (empty) → same-origin /api via Vite proxy / Vercel rewrite
 * Falls back to localhost:8000 for SSR/tests when window is undefined.
 */
import { apiUrl } from '../../services/api.js';
import { useOceanStore } from '../useOceanStore.js';

export function useOceanData() {
  const [isLive, setIsLive] = useState(false);
  const [fleet, setFleet] = useState([]);

  // 1. Fetch Fleet Coordinates
  useEffect(() => {
    fetch(apiUrl('/api/fleet'))
      .then((res) => {
        if (!res.ok) throw new Error('API failed');
        return res.json();
      })
      .then((data) => {
        if (!Array.isArray(data)) throw new Error('Fleet response was not an array');
        setFleet(data);
        useOceanStore.getState().setLiveFleet(data);
        setIsLive(Array.isArray(data) && data.length > 0);
      })
      .catch((err) => {
        console.warn('Argo fleet unavailable:', err.message);
        setIsLive(false);
      });
  }, []);

  return { isLive, fleet, validationData: null, telemetryStatus: isLive ? 'LIVE STREAM' : 'UNAVAILABLE' };
}
