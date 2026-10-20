import React, { useEffect, useState } from "react";
import { useOceanStore } from "../useOceanStore.js";

/**
 * Honest status panel for the real surface-current layer.
 * The current backend serves NOAA CoastWatch altimetry-derived geostrophic
 * vectors at the surface; it is not a Copernicus uo/vo depth profile.
 */
export function CurrentsLegend() {
  const currentField = useOceanStore((state) => state.currentField);
  const currentStatus = useOceanStore((state) => state.currentStatus);
  const currentLastUpdated = useOceanStore((state) => state.currentLastUpdated);
  const fetchCurrentField = useOceanStore((state) => state.fetchCurrentField);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    if (currentStatus === "idle") fetchCurrentField();
  }, [currentStatus, fetchCurrentField]);

  const source = currentField?.provider || "NOAA CoastWatch";
  const fieldTime = currentField?.timestamp || currentField?.time || null;
  const vectorCount = currentField?.vectors?.length ?? 0;
  const statusColor = currentStatus === "success" ? "#4ade80" : currentStatus === "error" ? "#f87171" : "#facc15";

  return (
    <div
      className="currents-legend panel-glass"
      style={{
        position: "absolute",
        left: 14,
        bottom: 70,
        zIndex: 10,
        padding: isMinimized ? "8px 12px" : "12px 16px",
        borderRadius: "8px",
        fontFamily: "Inter, sans-serif",
        fontSize: "0.75rem",
        color: "#e2e8f0",
        width: "280px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isMinimized ? 0 : 8 }}>
        <h4 style={{ margin: 0, color: "#fff", fontSize: "0.85rem" }}>Ocean Currents</h4>
        <button
          type="button"
          onClick={() => setIsMinimized((value) => !value)}
          style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", borderRadius: 4, width: 20, height: 20, cursor: "pointer" }}
        >
          {isMinimized ? "+" : "−"}
        </button>
      </div>

      {!isMinimized && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Status:</span><strong style={{ color: statusColor }}>{currentStatus}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Source:</span><span>{source}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Field:</span><span>Surface geostrophic</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Vectors:</span><span>{vectorCount || "—"}</span></div>
            {fieldTime && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Field time:</span><span>{new Date(fieldTime).toISOString().slice(0, 16)}Z</span></div>}
            {currentLastUpdated && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#94a3b8" }}>Retrieved:</span><span>{new Date(currentLastUpdated).toISOString().slice(0, 16)}Z</span></div>}
          </div>
          <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 8, color: "#94a3b8" }}>
            <div style={{ marginBottom: 4 }}>Color: current speed (m/s)</div>
            <div style={{ height: 6, width: "100%", background: "linear-gradient(90deg, #1e3a8a, #06b6d4, #fef08a, #ffffff)", borderRadius: 3 }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.65rem", color: "#64748b" }}><span>0.0</span><span>1.5+</span></div>
          </div>
          <div style={{ marginTop: 8, fontSize: "0.65rem", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>
            Surface-only geostrophic component; no depth interpolation.
          </div>
          {currentStatus === "error" && <div style={{ marginTop: 6, color: "#f87171", fontSize: "0.65rem", textAlign: "center" }}>Current vectors unavailable — no placeholder field is shown.</div>}
        </>
      )}
    </div>
  );
}

export default CurrentsLegend;
