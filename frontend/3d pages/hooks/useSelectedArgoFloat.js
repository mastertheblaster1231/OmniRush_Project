import { useEffect, useState } from "react";

/**
 * Shared "which Argo float is selected" state, driven by the globe.
 *
 * World.js (the vanilla Three.js globe) is not a React component and
 * can't accept an `onFloatSelect` prop directly — it's a self-initializing
 * module that wires its own click handlers at import time. Instead,
 * `selectStation()` inside World.js dispatches a plain `argoFloatSelected`
 * CustomEvent on `window` every time a float is selected: single-click,
 * double-click orbital dive, a sidebar-card focus (`focusOnPoint`), and
 * the initial auto-select on load all go through `selectStation()`, so
 * this one event covers all of them.
 *
 * This hook just listens for that event and mirrors it into React state.
 *
 * Usage (e.g. in Dashboard.jsx / App.jsx):
 *
 *   const [selectedArgoId, setSelectedArgoId] = useSelectedArgoFloat();
 *   <ArgoTelemetryFetcher selectedArgoId={selectedArgoId} />
 *
 * `setSelectedArgoId` is returned too, in case something else in React
 * (a search result, a list item) needs to set the initial/default value.
 * Calling it does NOT click the globe or move the camera — it only
 * updates this piece of React state. If you also want React-driven
 * selection to move the globe, call `window.focusOnPoint(id)` (already
 * exposed by World.js) alongside `setSelectedArgoId(id)`.
 */
export function useSelectedArgoFloat(initialId = null) {
  const [selectedArgoId, setSelectedArgoId] = useState(initialId);

  useEffect(() => {
    function handleFloatSelected(event) {
      const floatId = event?.detail?.floatId;
      if (floatId) setSelectedArgoId(floatId);
    }

    window.addEventListener("argoFloatSelected", handleFloatSelected);
    return () => {
      window.removeEventListener("argoFloatSelected", handleFloatSelected);
    };
  }, []);

  return [selectedArgoId, setSelectedArgoId];
}
