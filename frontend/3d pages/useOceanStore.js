import { create } from "zustand";
import { DEMO_INSTRUMENTS } from "./instruments.js";
import {
  fetchLiveArgoProfile,
} from "../services/argoService.js";
import {
  fetchArgoValidation,
  normalizeArgoPlatformId,
} from "../services/argoValidationService.js";
import { apiUrl } from "../services/api.js";
import {
  getComparisonStatus,
  SUPPORTED_VARIABLES,
  calculateRealisticObservedProfile,
} from "./deltaMath.js";

/**
 * useOceanStore.js — Global Zustand State Management Store
 * =========================================================
 * INCOIS Ocean Visualization Dashboard — SIH Problem 26067
 *
 * This store is the single source of truth for ALL UI state.
 * It coordinates:
 *   - Data layer toggles (Argo, model, currents, gliders)
 *   - Model controls (active variable, depth slider, colorbar)
 *   - Visualization settings (depth slice, isosurface, exaggeration)
 *   - Active instrument telemetry (live float clicked on map)
 *   - Live vs. model data comparison (Delta = Observation - Model)
 *
 * ── NEW IN PHASE 3 ───────────────────────────────────────────────────────────
 *   selectFloat(floatId)    — async: fetches ERDDAP + model, calculates Delta
 *   setDepth(newDepth)      — recalculates model prediction + Delta on slider move
 *   modelComparison state   — holds { observed, model, delta } for UI panels
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SYNTHETIC_INSTRUMENTS = DEMO_INSTRUMENTS.filter(
  (instrument) => instrument.type !== "argo",
);

let argoRequestSerial = 0;
let argoValidationController = null;
const MAX_ARGO_DEPTH_METRES = 2100;

function emptyVariables() {
  return Object.fromEntries(
    SUPPORTED_VARIABLES.map((variable) => [
      variable.key,
      {
        key: variable.key,
        obs: null,
        model: null,
        delta: null,
        status: "UNAVAILABLE",
      },
    ]),
  );
}

function emptyModelComparison(depth = 15) {
  return {
    targetDepth: depth,
    observationDepth: null,
    modelDepth: null,
    matchingMethod: null,
    provenance: {
      targetDepth: depth,
      observationDepth: null,
      modelDepth: null,
      matchingMethod: null,
      observationSource: null,
      modelSource: null,
    },
    variables: emptyVariables(),
    observed: Object.fromEntries(SUPPORTED_VARIABLES.map((variable) => [variable.key, null])),
    model: Object.fromEntries(SUPPORTED_VARIABLES.map((variable) => [variable.key, null])),
    delta: Object.fromEntries(SUPPORTED_VARIABLES.map((variable) => [variable.key, null])),
    depth,
    isLoading: false,
    error: null,
    modelSource: null,
    obsSource: null,
    qc: null,
    modelAvailable: false,
  };
}

// ─── STORE ───────────────────────────────────────────────────────────────────
export const useOceanStore = create((set, get) => ({
  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: ARGO FLOAT REAL-TIME STATE
  // ═══════════════════════════════════════════════════════════════════════════
  activeGlobeFloat: {
    id: null,
    coordinates: { lat: null, lon: null },
    latestObservation: { time: null, temp: null, salinity: null },
    isFetching: false,
  },
  setSelectedGlobeFloat: (floatData) => {
    set((state) => ({ 
      activeGlobeFloat: { 
        ...state.activeGlobeFloat, 
        ...floatData,
        latestObservation: {
          ...state.activeGlobeFloat.latestObservation,
          ...(floatData.latestObservation || {})
        }
      } 
    }));
  },
  fetchRealTimeGlobeFloat: async (id, lat, lon) => {
    get().setSelectedGlobeFloat({
      id,
      coordinates: { lat, lon },
      latestObservation: { time: null, temp: null, salinity: null },
      isFetching: true,
    });
    return get().selectFloat(id);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. REUSABLE LAYER REGISTRY (Extensible for INCOIS HF-Radar, ADCP, etc.)
  // ═══════════════════════════════════════════════════════════════════════════
  layers: {
    bathymetry: true,
    argoFloats: true,
    currents: false,
    hfRadar: false,
    adcp: false,
  },

  /**
   * Dynamic reusable action that updates any layer by key without rewriting store
   * @param {string} layerId - e.g. 'bathymetry', 'argoFloats', 'currents'
   * @param {boolean} [isVisible] - Explicit boolean, or toggles current if undefined
   */
  toggleLayer: (layerId, isVisible) => {
    set((state) => {
      const nextVisible =
        typeof isVisible === "boolean" ? isVisible : !state.layers[layerId];

      const updatedLayers = {
        ...state.layers,
        [layerId]: nextVisible,
      };

      // Two-way synchronization with vanilla Three.js / window bridges
      if (layerId === "bathymetry") {
        if (window.OCEAN_STATE) window.OCEAN_STATE.showBathymetry = nextVisible;
      } else if (layerId === "currents") {
        if (window.OCEAN_STATE) window.OCEAN_STATE.showCurrents = nextVisible;
      }

      return {
        layers: updatedLayers,
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 1b. LEGACY DATA LAYERS (Backwards-compatibility bridge)
  // ═══════════════════════════════════════════════════════════════════════════
  dataLayers: {
    showModel: true,
    showCurrents: true,
    showArgo: true,
    showGliders: true,
  },

  setDataLayer: (layerKey, value) => {
    set((state) => {
      const updated = {
        ...state.dataLayers,
        [layerKey]:
          typeof value === "boolean" ? value : !state.dataLayers[layerKey],
      };
      // Synchronize with window.OCEAN_STATE for Three.js vanilla bridge
      if (window.OCEAN_STATE) window.OCEAN_STATE.layers = updated;
      return { dataLayers: updated };
    });
  },

  toggleDataLayer: (layerKey) => get().setDataLayer(layerKey),

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. MODEL CONTROLS
  // ═══════════════════════════════════════════════════════════════════════════
  modelControls: {
    activeVariable: "temperature", // 'temperature' | 'salinity' | 'current' | 'chlorophyll'
    currentDepth: 500, // 0 – 4000 metres
    opacity: 0.7, // 0.0 – 1.0
    colorbar: {
      min: 5,
      max: 30,
      palette: "thermal",
    },
  },

  setModelControl: (key, value) => {
    set((state) => ({
      modelControls: { ...state.modelControls, [key]: value },
    }));
  },

  setActiveVariable: (activeVariable) => {
    set((state) => {
      const minMaxMap = {
        temperature: { min: 5, max: 30, palette: "thermal" },
        salinity: { min: 32, max: 37, palette: "haline" },
        current: { min: 0, max: 2.0, palette: "viridis" },
        currentSpeed: { min: 0, max: 2.0, palette: "viridis" },
        currentDirection: { min: 0, max: 360, palette: "cyclic" },
        chlorophyll: { min: 0.01, max: 5.0, palette: "chlorophyll" },
        dissolvedOxygen: { min: 40, max: 300, palette: "plasma" },
      };
      const colorbar =
        minMaxMap[activeVariable] || state.modelControls.colorbar;
      if (typeof window !== "undefined" && window.OCEAN_STATE) {
        window.OCEAN_STATE.variableType = activeVariable;
        window.OCEAN_STATE.variable = activeVariable;
        if (typeof window.updateVolumeVariable === "function") {
          window.updateVolumeVariable(activeVariable);
        }
        if (typeof window.updateParticlesVariable === "function") {
          window.updateParticlesVariable(activeVariable);
        }
      }
      return {
        modelControls: { ...state.modelControls, activeVariable, colorbar },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5a. CURRENT VECTOR FIELD STATE
  // ═══════════════════════════════════════════════════════════════════════════
  currentField: null,
  currentStatus: "idle",
  currentError: null,
  currentLastUpdated: null,
  currentDepth: 0,
  currentTime: "latest",
  currentSourceMode: null,
  currentSpeedMax: 1.5,
  currentAnimationSpeed: 1,
  currentVisible: true,

  setCurrentDepth: (depth) => {
    const currentActiveInstrument = get().activeInstrument;
    const maxDepth = currentActiveInstrument?.type === "argo" ? MAX_ARGO_DEPTH_METRES : 4000;
    const clampedDepth = Math.max(0, Math.min(maxDepth, Math.round(depth)));

    set((state) => ({
      modelControls: { ...state.modelControls, currentDepth: clampedDepth },
      targetDepth: clampedDepth,
      activeInstrumentDepth: clampedDepth,
      currentDepth: clampedDepth,
    }));

    // Notify Three.js scene of the new depth ratio for the vertical slice mesh
    const ratio = clampedDepth / 4000.0;
    if (window.setOceanDepth) window.setOceanDepth(ratio);
    if (window.OCEAN_STATE) {
      window.OCEAN_STATE.currentDepth = clampedDepth;
      window.OCEAN_STATE.depthRatio = ratio;
    }

    // Update vanilla DOM depth slider elements (legacy bridge)
    const depthInput = document.getElementById("depthInput");
    if (depthInput && document.activeElement !== depthInput)
      depthInput.value = clampedDepth;
    const fill = document.getElementById("depthTrackFill");
    const thumb = document.getElementById("depthThumb");
    const pct = (ratio * 100).toFixed(1);
    if (fill) fill.style.height = `${pct}%`;
    if (thumb) thumb.style.top = `${pct}%`;

    // Update depth zone label and indicator dot
    if (typeof _updateDepthZoneUI === "function") {
      _updateDepthZoneUI(clampedDepth);
    }

    // Dynamically update model comparison, observation, and realtime residuals when diving
    const { _activeArgoProfile, activeInstrument } = get();
    if (activeInstrument) {
      get()._recalculateModelComparison(
        _activeArgoProfile,
        activeInstrument,
        clampedDepth,
      );
    }
  },

  setCurrentTime: (time) => {
    set({ currentTime: time });
    get().fetchCurrentField();
  },

  setCurrentVisible: (visible) => {
    set({ currentVisible: visible });
  },

  setCurrentAnimationSpeed: (speed) => {
    set({ currentAnimationSpeed: speed });
  },

  clearCurrentField: () => {
    set({ currentField: null, currentStatus: "idle", currentError: null });
  },

  fetchCurrentField: async () => {
    const { currentDepth, currentTime } = get();
    set({ currentStatus: "loading", currentError: null });

    try {
      // This backend product is a daily surface geostrophic field; it has no
      // depth/time query dimension. Do not label it as a selected-depth Argo measurement.
      const response = await fetch(apiUrl('/api/currents'));
      if (!response.ok) throw new Error("Failed to fetch currents");
      
      const data = await response.json();
      if (!data || !Array.isArray(data.vectors)) {
        throw new Error(data?.error || "Invalid vector field format");
      }

      // /api/currents is a surface snapshot. The current-layer renderer uses
      // its vectors directly; it is intentionally not converted into a
      // selected-depth Argo field.
      if (data.grid && data.grid.width == null) {
        const field = {
          vectors: data.vectors,
          grid: data.grid,
          timestamp: data.time || null,
          provider: data.source || null,
          mode: "surface-geostrophic",
        };
        set({
          currentField: field,
          currentStatus: "success",
          currentSourceMode: field.mode,
          currentLastUpdated: new Date().toISOString(),
        });
        if (typeof window !== "undefined") window.currentField = field;
        return;
      }

      // Convert vectors array into typed arrays for fast interpolation in World.js
      const { width, height, west, north, longitudeStep, latitudeStep } = data.grid;
      const count = width * height;
      
      const u = new Float32Array(count);
      const v = new Float32Array(count);
      // Initialize with NaN for missing values
      u.fill(NaN);
      v.fill(NaN);

      // We need lats and lons arrays for bilinear interpolation
      const lats = new Float32Array(height);
      const lons = new Float32Array(width);
      const south = data.grid.south;
      for(let j=0; j<height; j++) lats[j] = south + j * latitudeStep;
      for(let i=0; i<width; i++) lons[i] = west + i * longitudeStep;

      for (let vec of data.vectors) {
        // Find indices
        const i = Math.round((vec.lon - west) / longitudeStep);
        const j = Math.round((vec.lat - south) / latitudeStep);
        if (i >= 0 && i < width && j >= 0 && j < height) {
           u[j * width + i] = vec.u;
           v[j * width + i] = vec.v;
        }
      }

      const field = {
        width, height, west, south, east: data.grid.east, north: data.grid.north,
        longitudeStep, latitudeStep,
        u, v, lats, lons,
        timestamp: data.source.time,
        provider: data.source.provider,
        mode: data.source.mode
      };

      set({ 
        currentField: field, 
        currentStatus: "success", 
        currentSourceMode: data.source.mode,
        currentLastUpdated: data.source.retrievedAt
      });

      // Also expose it to window for vanilla JS access in World.js
      if (typeof window !== "undefined") {
         window.currentField = field;
      }
    } catch (err) {
      console.error("[useOceanStore] fetchCurrentField error:", err);
      set({ currentStatus: "error", currentError: err.message });
    }
  },

  setOpacity: (opacity) => {
    const clamped = Math.max(0, Math.min(1, opacity));
    set((state) => ({
      modelControls: { ...state.modelControls, opacity: clamped },
    }));
    if (window.OCEAN_STATE) window.OCEAN_STATE.sliceOpacity = clamped;
  },

  setColorbar: (colorbarUpdate) => {
    set((state) => ({
      modelControls: {
        ...state.modelControls,
        colorbar: { ...state.modelControls.colorbar, ...colorbarUpdate },
      },
    }));
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. VISUALIZATION SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  visualization: {
    showDepthSlice: true,
    verticalExaggeration: 10.0, // 1x – 100x
  },

  setVisualization: (key, value) => {
    set((state) => ({
      visualization: { ...state.visualization, [key]: value },
    }));
  },

  setShowDepthSlice: (showDepthSlice) => {
    set((state) => ({
      visualization: { ...state.visualization, showDepthSlice },
    }));
    if (window.OCEAN_STATE) window.OCEAN_STATE.showSlice = showDepthSlice;
  },

  setVerticalExaggeration: (verticalExaggeration) => {
    const clamped = Math.max(1, Math.min(100, verticalExaggeration));
    set((state) => ({
      visualization: { ...state.visualization, verticalExaggeration: clamped },
    }));
    if (window.OCEAN_STATE) {
      window.OCEAN_STATE.verticalExaggeration = clamped;
      if (window.setOceanDepth)
        window.setOceanDepth(window.OCEAN_STATE.depthRatio || 0.125);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SECTOR FLEET REGISTRY & ACTIVE INSTRUMENT TELEMETRY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Argo entries come only from the backend fleet. Glider/CTD entries are
   * clearly marked synthetic presentation instruments.
   */
  fleet: SYNTHETIC_INSTRUMENTS.map((instrument) => ({
    ...instrument,
    source: "synthetic-demo",
    isSynthetic: true,
    qcStatus: "Synthetic demo — not Argo data",
  })),

  setLiveFleet: (floats = []) => {
    const liveArgo = floats.map((float) => {
      const floatId = normalizeArgoPlatformId(float.platform_number || float.floatId || float.id);
      return {
        ...float,
        id: `argo-${floatId}`,
        floatId,
        type: "argo",
        platform: "Argo Profiling Float",
        isSynthetic: false,
        source: float.source || "ifremer-erddap",
        // Scene coordinates are visual placement, never geographic metadata.
        position: [0, -0.2, 1.5],
        depth: null,
        depthMeters: null,
        telemetry: {
          temperatureC: float.surfaceTemp ?? null,
          salinityPSU: float.surfaceSalinity ?? null,
        },
      };
    });
    set((state) => ({
      fleet: [...liveArgo, ...state.fleet.filter((instrument) => instrument.isSynthetic)],
    }));
  },

  activeInstrument: null,

  isLoadingInstrument: false,
  instrumentError: null,

  /**
   * _activeArgoProfile — internal state holding the raw ArgoProfile object
   * returned by fetchLiveArgoProfile(). NOT exposed directly to UI components;
   * only used by _recalculateModelComparison to interpolate at the selected depth.
   */
  _activeArgoProfile: null,

  setActiveInstrument: (activeInstrument) => {
    const enriched = activeInstrument
      ? {
          x:
            activeInstrument.x ??
            (activeInstrument.position ? activeInstrument.position[0] : 0.0),
          y:
            activeInstrument.y ??
            (activeInstrument.position ? activeInstrument.position[1] : 0.0),
          z:
            activeInstrument.z ??
            (activeInstrument.position ? activeInstrument.position[2] : 1.5),
          ...activeInstrument,
        }
      : null;
    set({ activeInstrument: enriched, instrumentError: null });
    if (window.OCEAN_STATE && enriched) {
      window.OCEAN_STATE.selectedInstrument = enriched;
    }
  },

  /**
   * selectInstrument
   * ----------------
   * Dynamic action to switch the active instrument platform from the fleet.
   * Updates activeInstrument in Zustand, resets activeInstrumentDepth,
   * switches the telemetry drawer and bottom analytics cards, and notifies
   * the 3D camera / Three.js bridge.
   *
   * @param {string} instrumentId - e.g. 'argo-2902351', 'glider-slocum-04', 'ctd-rosette-01'
   */
  selectInstrument: (instrumentId) => {
    const currentFleet = get().fleet;
    const inst =
      currentFleet.find((i) => i.id === instrumentId) ||
      currentFleet.find(
        (i) => i.id.includes(instrumentId) || instrumentId.includes(i.id),
      );

    if (!inst) {
      console.warn(
        `[useOceanStore] Instrument "${instrumentId}" not found in fleet.`,
      );
      return;
    }

    if (inst.type === "argo") {
      return get().selectFloat(inst.floatId || inst.id);
    }

    const instSavedCoord = get().instruments?.[inst.id] || {};
    const targetDepth =
      instSavedCoord.depth ??
      inst.depth ??
      inst.depthMeters ??
      (inst.type === "glider" ? 190 : inst.type === "ctd" ? 1200 : 15);
    const targetTransect =
      instSavedCoord.transectDistance ?? (inst.type === "glider" ? 25 : 0);
    const realisticObs = calculateRealisticObservedProfile(
      targetDepth,
      inst.type || "argo",
      inst,
    );

    // 1. INSTANT SYNCHRONOUS UPDATE (0ms latency, eliminates frozen UI and lag)
    const enriched = {
      x: inst.position ? inst.position[0] : 0.0,
      y: inst.position ? inst.position[1] : -0.2,
      z: inst.position ? inst.position[2] : 1.5,
      depth: targetDepth,
      depthMeters: targetDepth,
      temp: realisticObs.temperature,
      salinity: realisticObs.salinity,
      dissolvedOxygen: realisticObs.dissolvedOxygen,
      currentSpeed: realisticObs.currentSpeed,
      currentDirection: realisticObs.currentDirection,
      chlorophyll: realisticObs.chlorophyll,
      battery: inst.telemetry?.batteryPct ?? 80,
      ...inst,
    };

    set((state) => ({
      activeInstrument: enriched,
      targetDepth: targetDepth,
      activeInstrumentDepth: targetDepth,
      activeInstrumentHorizontal: targetTransect,
      instruments: {
        ...state.instruments,
        [inst.id]: {
          ...(state.instruments[inst.id] || { x: 0, z: 0 }),
          depth: targetDepth,
          ...(inst.type === "glider"
            ? { transectDistance: targetTransect }
            : {}),
        },
      },
      modelControls: { ...state.modelControls, currentDepth: targetDepth },
      isLoadingInstrument: false,
      instrumentError: null,
    }));

    if (typeof window !== "undefined" && window.OCEAN_STATE) {
      window.OCEAN_STATE.selectedInstrument = enriched;
      window.OCEAN_STATE.currentDepth = targetDepth;
      window.OCEAN_STATE.depthRatio = targetDepth / 4000.0;
      window.OCEAN_STATE.activeInstrumentHorizontal = targetTransect;
    }

    // Trigger multi-variable validation engine
    get()._recalculateModelComparison(null, enriched, targetDepth);

    // Sync with 3D camera / Three.js bridge (guarded against recursive re-entrancy)
    if (
      typeof window !== "undefined" &&
      typeof window.focusInstrument === "function" &&
      !window.__syncingInstrument
    ) {
      window.__syncingInstrument = true;
      try {
        window.focusInstrument(inst.id);
      } finally {
        window.__syncingInstrument = false;
      }
    }
  },

  clearActiveInstrument: () => {
    argoRequestSerial += 1;
    argoValidationController?.abort();
    set({
      activeInstrument: null,
      instrumentError: null,
      _activeArgoProfile: null,
      activeInstrumentHorizontal: 0,
      modelComparison: emptyModelComparison(get().targetDepth),
      argoTelemetry: null,
      bgcOptics: null,
      hydraulicsTelemetry: null,
    });
  },

  // ─── TEMPORAL QUERY STATE ───────────────────────────────────────────────
  selectedTimestamp: new Date().toISOString(),

  /**
   * setSelectedTimestamp
   * --------------------
   * Updates the requested timestamp and retrieves the backend's real matched
   * observation/model. Values are never perturbed locally.
   *
   * @param {string|Date|number} timestamp
   */
  setSelectedTimestamp: (timestamp) => {
    let dateObj;
    try {
      dateObj = new Date(timestamp);
      if (isNaN(dateObj.getTime())) dateObj = new Date();
    } catch {
      dateObj = new Date();
    }
    const isoString = dateObj.toISOString();

    const { activeInstrument, targetDepth } = get();
    set({ selectedTimestamp: isoString });

    if (typeof window !== "undefined" && window.OCEAN_STATE) {
      window.OCEAN_STATE.selectedTimestamp = isoString;
    }

    const { _activeArgoProfile } = get();
    if (activeInstrument) {
      get()._recalculateModelComparison(
        _activeArgoProfile,
        activeInstrument,
        targetDepth,
      );
    }
  },

  // ─── MULTI-DEVICE COMPARISON STATE (Requirement 3) ──────────────────────
  comparedInstruments: ["glider-slocum-04"],

  setComparedInstruments: (instruments) => {
    const list = Array.isArray(instruments) ? instruments : [instruments];
    set({ comparedInstruments: list });
  },

  addComparedInstrument: (instrumentId) => {
    if (!instrumentId) return;
    set((state) => ({
      comparedInstruments: Array.from(
        new Set([...state.comparedInstruments, instrumentId]),
      ),
    }));
  },

  removeComparedInstrument: (instrumentId) => {
    set((state) => ({
      comparedInstruments: state.comparedInstruments.filter(
        (id) => id !== instrumentId,
      ),
    }));
  },

  toggleComparedInstrument: (instrumentId) => {
    if (!instrumentId) return;
    set((state) => {
      const exists = state.comparedInstruments.includes(instrumentId);
      const updated = exists
        ? state.comparedInstruments.filter((id) => id !== instrumentId)
        : [...state.comparedInstruments, instrumentId];
      return {
        comparedInstruments: updated.length > 0 ? updated : [instrumentId],
      };
    });
  },

  // ─── DEPTH AS A FIRST-CLASS STATE FILTER ─────────────────────────────────
  /**
   * targetDepth
   * -----------
   * Primary user-defined depth filter for the Multi-Variable Validation Engine.
   * Tracks the target vertical coordinate (0 – 4000 m) used to align in-situ
   * observations with 4D NetCDF ocean model vertical grid levels.
   */
  // ─── INDEPENDENT INSTRUMENT SPATIAL COORDINATES ─────────────────────────
  instruments: {
    "glider-slocum-04": { depth: 190, transectDistance: 25, x: 0, z: 0 },
    "ctd-rosette-01": { depth: 1200, x: 0, z: 0 },
  },

  targetDepth: 15,
  activeInstrumentDepth: 15, // synchronized alias for backwards compatibility
  activeInstrumentHorizontal: 25, // 0 - 50 km horizontal transect for autonomous gliders

  /**
   * setActiveInstrumentTransect
   * --------------------------
   * Updates instruments['glider-slocum-04'].transectDistance.
   *
   * @param {number} km Distance in km (0 - 50)
   */
  setActiveInstrumentTransect: (km) => {
    const clamped = Math.max(
      0,
      Math.min(50, typeof km === "number" ? km : parseFloat(km) || 0),
    );
    set((state) => ({
      instruments: {
        ...state.instruments,
        "glider-slocum-04": {
          ...(state.instruments["glider-slocum-04"] || {
            depth: 190,
            x: 0,
            z: 0,
          }),
          transectDistance: clamped,
        },
      },
      activeInstrumentHorizontal: clamped,
    }));
    if (typeof window !== "undefined" && window.OCEAN_STATE) {
      window.OCEAN_STATE.activeInstrumentHorizontal = clamped;
    }
  },

  /** Alias for backward compatibility */
  setActiveInstrumentHorizontal: (horizontal) => {
    get().setActiveInstrumentTransect(horizontal);
  },

  /**
   * setActiveInstrumentDepth
   * ------------------------
   * Updates instruments[activeInstrumentId].depth.
   * Isolates depth so modifying one instrument never alters another instrument.
   */
  setActiveInstrumentDepth: (depth) => {
    const activeInstrument = get().activeInstrument;
    const maxDepth = activeInstrument?.type === "argo" ? MAX_ARGO_DEPTH_METRES : 4000;
    const clampedDepth = Math.max(
      0,
      Math.min(maxDepth, Math.round(Number(depth) || 0)),
    );
    const activeId = activeInstrument?.id;

    set((state) => ({
      instruments: {
        ...state.instruments,
        ...(activeId ? { [activeId]: {
          ...(state.instruments[activeId] || { x: 0, z: 0 }),
          depth: clampedDepth,
        } } : {}),
      },
      activeInstrumentDepth: clampedDepth,
      targetDepth: clampedDepth,
      modelControls: { ...state.modelControls, currentDepth: clampedDepth },
    }));

    if (typeof window !== "undefined" && window.OCEAN_STATE) {
      window.OCEAN_STATE.currentDepth = clampedDepth;
      window.OCEAN_STATE.depthRatio = clampedDepth / 4000.0;
    }

    if (
      typeof window !== "undefined" &&
      window.setOceanDepth &&
      !window.__syncingDepth
    ) {
      window.__syncingDepth = true;
      try {
        window.setOceanDepth(clampedDepth / 4000.0);
      } finally {
        window.__syncingDepth = false;
      }
    }

    const { _activeArgoProfile } = get();
    if (activeInstrument) {
      get()._recalculateModelComparison(
        _activeArgoProfile,
        activeInstrument,
        clampedDepth,
      );
    }
  },

  /**
   * setTargetDepth
   * --------------
   * Updates targetDepth, synchronizes 3D depth, and runs the depth-alignment engine.
   *
   * @param {number} depth User-requested depth in metres (0 – 4000)
   */
  setTargetDepth: (depth) => {
    const clampedDepth = Math.max(
      0,
      Math.min(4000, Math.round(Number(depth) || 0)),
    );
    get().setActiveInstrumentDepth(clampedDepth);

    const ratio = clampedDepth / 4000.0;
    if (window.setOceanDepth && !window.__syncingDepth) {
      window.__syncingDepth = true;
      try {
        window.setOceanDepth(ratio);
      } finally {
        window.__syncingDepth = false;
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. MULTI-VARIABLE MODEL VALIDATION ENGINE (Δ = Observation - Model)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * modelComparison
   * ---------------
   * Complete multi-variable validation state comparing in-situ observations against
   * NetCDF supercomputer models across 6 physical parameters at the user-filtered targetDepth.
   */
  modelComparison: emptyModelComparison(),
  argoValidation: null,

  // ═══════════════════════════════════════════════════════════════════════════
  // 5b. BGC ARGO & FLOAT HYDRAULICS TELEMETRY (FastAPI /api/argo/depth-slice)
  // ═══════════════════════════════════════════════════════════════════════════
  argoTelemetry: null,
  bgcOptics: null,
  hydraulicsTelemetry: null,
  isFetchingArgoTelemetry: false,

  fetchArgoBGCTelemetry: async (
    depthMeters = 15,
    timestamp = null,
    platformNumber = null,
  ) => {
    const instrument = get().activeInstrument;
    if (instrument?.type !== "argo") return null;
    if (platformNumber && normalizeArgoPlatformId(platformNumber) !== instrument.floatId) return null;
    return get()._recalculateModelComparison(null, instrument, depthMeters, timestamp);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. ASYNC ACTIONS — PHASE 3 CORE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * selectFloat
   * -----------
   * The primary entry point called when the user clicks an Argo float marker
   * on the 3D globe or the fleet sidebar.
   *
   * Execution sequence:
   *   1. Set loading state to true
   *   2. Await fetchLiveArgoProfile(floatId)  ← ERDDAP or offline cache
   *   3. Map the ArgoProfile to the existing activeInstrument shape
   *   4. Await _recalculateModelComparison()  ← FastAPI model point extraction
   *   5. Set all state atomically via a single set() call
   *
   * The two async calls (ERDDAP + FastAPI) are kicked off concurrently with
   * Promise.allSettled so a FastAPI outage doesn't block the instrument panel.
   *
   * @param {string|number} floatId  WMO platform number, e.g. "2902351"
   */
  selectFloat: async (floatId) => {
    const rawId = normalizeArgoPlatformId(floatId);
    if (!rawId) return null;
    const liveMeta = get().fleet.find((instrument) => instrument.floatId === rawId);
    const selectedDepth = Math.min(
      MAX_ARGO_DEPTH_METRES,
      get().instruments[`argo-${rawId}`]?.depth ?? get().targetDepth,
    );
    const instrumentData = {
      ...(liveMeta || {}),
      id: `argo-${rawId}`,
      floatId: rawId,
      type: "argo",
      name: liveMeta?.name || `Argo Float #${rawId}`,
      platform: "Argo Profiling Float",
      lat: liveMeta?.lat ?? null,
      lon: liveMeta?.lon ?? null,
      depth: selectedDepth,
      depthMeters: selectedDepth,
      position: [0, -0.2, 1.5],
      temp: null,
      salinity: null,
      dissolvedOxygen: null,
      chlorophyll: null,
      currentSpeed: null,
      currentDirection: null,
      cycle: null,
      battery: null,
      telemetry: {},
      timestamp: null,
      source: liveMeta?.source || null,
      qcStatus: null,
      status: "Loading real profile",
      isSynthetic: false,
    };
    argoRequestSerial += 1;
    argoValidationController?.abort();
    set((state) => ({
      _activeArgoProfile: null,
      activeInstrument: instrumentData,
      targetDepth: selectedDepth,
      activeInstrumentDepth: selectedDepth,
      activeInstrumentHorizontal: 0,
      isLoadingInstrument: true,
      instrumentError: null,
      argoValidation: null,
      argoTelemetry: null,
      bgcOptics: null,
      hydraulicsTelemetry: null,
      modelComparison: { ...emptyModelComparison(selectedDepth), isLoading: true },
      comparedInstruments: [...new Set([
        `argo-${rawId}`,
        ...state.comparedInstruments.filter((id) => !id.startsWith("argo-")),
      ])],
      instruments: {
        ...state.instruments,
        [`argo-${rawId}`]: { depth: selectedDepth, x: 0, z: 0 },
      },
    }));
    if (typeof window !== "undefined" && window.OCEAN_STATE) {
      window.OCEAN_STATE.selectedInstrument = instrumentData;
    }
    // Profile/provenance and selected-depth validation are independent real
    // backend requests. A later slider request must not be replaced by this
    // selection's initial depth when the profile finishes.
    const profileRequest = fetchLiveArgoProfile(rawId)
      .then((profile) => {
        if (get().activeInstrument?.id !== instrumentData.id) return;
        set((state) => ({
          _activeArgoProfile: profile,
          isLoadingInstrument: false,
          activeInstrument: {
            ...state.activeInstrument,
            lat: profile.lat,
            lon: profile.lon,
            cycle: profile.cycle,
            timestamp: profile.timestamp,
            source: profile.source,
            qcStatus: profile.qcStatus,
            status: "Real Argo profile",
          },
        }));
      })
      .catch((error) => {
        if (get().activeInstrument?.id !== instrumentData.id) return;
        set({ isLoadingInstrument: false, instrumentError: error.message });
      });
    await Promise.all([
      profileRequest,
      get()._recalculateModelComparison(null, instrumentData, selectedDepth),
    ]);
    return get().activeInstrument;
  },

  /**
   * _recalculateModelComparison
   * ---------------------------
   * Multi-Variable Validation Engine (Observation vs 4D NetCDF Model).
   * Supports: Temperature, Salinity, Chlorophyll-a, Current Speed, Current Direction, Dissolved Oxygen.
   *
   * 1. Aligns targetDepth with in-situ observation profile and NetCDF vertical model grid.
   * 2. Stores provenance metadata: targetDepth, observationDepth, modelDepth, matchingMethod.
   * 3. Handles missing data gracefully: if either side is missing, delta = null.
   * 4. Applies vector circular math for Current Direction to prevent wrap-around errors.
   */
  _recalculateModelComparison: async (profile, instrument, targetDepthM, timestampOverride = null) => {
    const maxDepth = instrument?.type === "argo" ? MAX_ARGO_DEPTH_METRES : 4000;
    const depthM = Math.max(
      0,
      Math.min(maxDepth, Math.round(Number(targetDepthM) || 0)),
    );

    if (!instrument) return null;
    if (instrument.type !== "argo") {
      // Synthetic instruments are a presentation-only demo. They must not
      // issue an Argo request or be labelled as a real model comparison.
      argoRequestSerial += 1;
      argoValidationController?.abort();
      const demo = getInstrumentComparisonData(instrument.id, depthM);
      set({
        argoValidation: null,
        argoTelemetry: null,
        bgcOptics: null,
        hydraulicsTelemetry: null,
        modelComparison: {
          ...emptyModelComparison(depthM),
          ...demo,
          obsSource: "synthetic-demo",
          qc: "Synthetic demo — not Argo data",
          modelSource: null,
          modelAvailable: false,
        },
      });
      return null;
    }

    const requestSerial = ++argoRequestSerial;
    argoValidationController?.abort();
    const controller = new AbortController();
    argoValidationController = controller;
    const timestamp = timestampOverride || get().selectedTimestamp;
    set({
      argoValidation: null,
      argoTelemetry: null,
      bgcOptics: null,
      hydraulicsTelemetry: null,
      isFetchingArgoTelemetry: true,
      modelComparison: { ...emptyModelComparison(depthM), isLoading: true },
    });

    try {
      const validation = await fetchArgoValidation(
        instrument.floatId || instrument.id,
        depthM,
        timestamp,
        { signal: controller.signal },
      );
      if (requestSerial !== argoRequestSerial || get().activeInstrument?.id !== instrument.id) return null;

      const variables = Object.fromEntries(validation.variables.map((variable) => [
        variable.key,
        {
          ...variable,
          obs: variable.observed,
          status: getComparisonStatus(variable.observed, variable.model),
        },
      ]));
      const comparison = {
        ...emptyModelComparison(depthM),
        ...validation.provenance,
        provenance: validation.provenance,
        variables,
        observed: validation.observed,
        model: validation.modelValues,
        delta: validation.delta,
        depth: depthM,
        modelSource: validation.modelSource,
        obsSource: validation.obsSource,
        modelAvailable: validation.model.available,
        modelUnavailableReason: validation.model.reason,
        qc: validation.qc,
        timestamp: validation.time,
      };

      set((state) => ({
        argoValidation: validation,
        modelComparison: comparison,
        isFetchingArgoTelemetry: false,
        targetDepth: depthM,
        activeInstrumentDepth: depthM,
        modelControls: { ...state.modelControls, currentDepth: depthM },
        activeInstrument: {
          ...state.activeInstrument,
          depth: depthM,
          depthMeters: depthM,
          observationDepth: validation.provenance.observationDepth,
          temp: validation.observed.temperature,
          salinity: validation.observed.salinity,
          dissolvedOxygen: validation.observed.dissolvedOxygen,
          chlorophyll: validation.observed.chlorophyll,
          currentSpeed: null,
          currentDirection: null,
          timestamp: validation.time,
          lat: validation.location.lat,
          lon: validation.location.lon,
          cycle: validation.cycle_number ?? state.activeInstrument.cycle,
          source: validation.obsSource,
          qcStatus: validation.qc,
          status: "Real Argo observation",
        },
        activeGlobeFloat: {
          id: instrument.floatId,
          coordinates: validation.location,
          latestObservation: {
            time: validation.time,
            temp: validation.observed.temperature,
            salinity: validation.observed.salinity,
          },
          isFetching: false,
        },
      }));
      return validation;
    } catch (error) {
      if (error.name === "AbortError" || requestSerial !== argoRequestSerial) return null;
      set({
        argoValidation: null,
        isFetchingArgoTelemetry: false,
        modelComparison: { ...emptyModelComparison(depthM), error: error.message },
      });
      return null;
    }
  },

  /**
   * setDepth
   * --------
   * Public action for the depth slider UI component.
   * Wraps setCurrentDepth — the recalculation logic lives there so
   * the same Delta update happens regardless of how depth is changed.
   *
   * @param {number} newDepth  New depth in metres (0 – 4000)
   */
  setDepth: (newDepth) => {
    get().setCurrentDepth(newDepth);
  },

  // ─── LEGACY COMPAT: fetchAndSetInstrument ────────────────────────────────
  // Retained for any existing components that call this directly.
  fetchAndSetInstrument: async (instrumentId) => {
    const currentFleet = get().fleet;
    const inst = currentFleet.find(
      (i) => i.id === instrumentId || i.id.includes(instrumentId),
    );
    if (inst && inst.type !== "argo") {
      return get().selectInstrument(instrumentId);
    }
    return get().selectFloat(instrumentId);
  },
}));

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE MODULE-LEVEL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Synthetic glider/CTD comparison data is kept only for those explicitly
 * synthetic instruments. Argo never enters this helper.
 */
export function getInstrumentComparisonData(instrumentId, depthM = 15) {
  const instrument = SYNTHETIC_INSTRUMENTS.find((item) => item.id === instrumentId);
  const depth = Math.max(0, Math.min(4000, Number(depthM) || 0));
  if (!instrument) {
    return { instrument: null, depth, observed: {}, model: {}, delta: {}, variables: {} };
  }

  const observed = calculateRealisticObservedProfile(depth, instrument.type, instrument);
  const variables = Object.fromEntries(
    SUPPORTED_VARIABLES.map((variable) => [
      variable.key,
      {
        key: variable.key,
        obs: observed[variable.key] ?? null,
        model: null,
        delta: null,
        status: "MISSING_MODEL",
      },
    ]),
  );
  return {
    instrument,
    depth,
    observed,
    model: Object.fromEntries(SUPPORTED_VARIABLES.map((variable) => [variable.key, null])),
    delta: Object.fromEntries(SUPPORTED_VARIABLES.map((variable) => [variable.key, null])),
    variables,
  };
}

/**
 * _updateDepthZoneUI
 * ------------------
 * Updates the depth zone text label and indicator dot color in the vanilla DOM.
 * Called by setCurrentDepth to keep the legacy Three.js UI in sync with Zustand.
 *
 * @param {number} depth  Current depth in metres
 */
function _updateDepthZoneUI(depth) {
  const zoneText = document.getElementById("zoneText");
  const zoneDot = document.getElementById("zoneDot");
  if (!zoneText || !zoneDot) return;

  if (depth === 0) {
    zoneText.textContent = "0m • Surface / Top Level (Sun & Clouds)";
    zoneDot.style.background = "#ffe042";
    zoneDot.style.boxShadow = "0 0 8px #ffe042";
  } else if (depth <= 200) {
    zoneText.textContent = `${depth}m • Sunlight Zone (Epipelagic)`;
    zoneDot.style.background = "#00f0ff";
    zoneDot.style.boxShadow = "0 0 8px #00f0ff";
  } else if (depth <= 1000) {
    zoneText.textContent = `${depth}m • Twilight Zone (Mesopelagic)`;
    zoneDot.style.background = "#0077b6";
    zoneDot.style.boxShadow = "0 0 8px #0077b6";
  } else if (depth <= 3000) {
    zoneText.textContent = `${depth}m • Midnight Zone (Bathypelagic)`;
    zoneDot.style.background = "#03045e";
    zoneDot.style.boxShadow = "0 0 8px #0077b6";
  } else {
    zoneText.textContent = `${depth}m • Abyssal Plain (Abyssopelagic)`;
    zoneDot.style.background = "#0a2d54";
    zoneDot.style.boxShadow = "0 0 10px #00b4d8";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE SELECTORS (memoized shallow selectors for React component subscriptions)
// ═══════════════════════════════════════════════════════════════════════════════

export const selectDataLayers = (state) => state.dataLayers;
export const selectModelControls = (state) => state.modelControls;
export const selectVisualization = (state) => state.visualization;
export const selectActiveInstrument = (state) => state.activeInstrument;
export const selectModelComparison = (state) => state.modelComparison;
export const selectFleet = (state) => state.fleet;
export const selectTargetDepth = (state) => state.targetDepth;
export const selectActiveInstrumentDepth = (state) =>
  state.activeInstrumentDepth;
export const selectActiveInstrumentHorizontal = (state) =>
  state.activeInstrumentHorizontal;
export const selectActiveVariable = (state) =>
  state.modelControls.activeVariable;

if (typeof window !== "undefined") {
  window.addEventListener("argoFleetLoaded", (event) => {
    useOceanStore.getState().setLiveFleet(event.detail?.floats || window.argoAllBasinFloats || []);
  });
}

// ─── GLOBAL BRIDGE for vanilla Three.js inspector panels ────────────────────
if (typeof window !== "undefined") {
  window.oceanStore = useOceanStore;
}
