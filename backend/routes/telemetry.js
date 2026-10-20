import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

/**
 * /api/telemetry — Depth-First Argo float telemetry.
 *
 * The requested depth is locked in first; the Python engine scans the float's
 * entire history (every dive, every sensor reading) and returns the reading
 * whose pressure is closest to that depth. The optional date does NOT drive
 * the search — it only qualifies time_status (e.g.
 * "Exact Depth Match -> Nearest Time").
 *
 * Query: platform (required) | depth (meters, default 15) | date (ISO-8601, optional)
 * Response: forwards the Python engine's stdout (new schema):
 *   { success, platform_id, time_status, location, depth_status, telemetry }
 *
 * The Python output also carries legacy date-then-depth fields
 * (match_type / matched_reading / matched_date ...) which are forwarded
 * untouched so /api/argo/float-details can keep sharing this engine. The new
 * schema fields (depth-first) are the primary contract for telemetry clients.
 */
function handleTelemetry(req, res) {
  const platformId = String(
    req.query.platform || req.query.dynamicDisplayName || "",
  )
    .replace(/^argo-/i, "")
    .replace(/^Argo\s+/i, "")
    .trim();

  if (!platformId) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameter: platform (Argo platform number)",
    });
  }

  const targetDepth = parseFloat(req.query.depth) || 15;
  const targetDate =
    req.query.date && req.query.date !== "" ? req.query.date : "latest";

  const pythonScript = path.join(
    __dirname,
    "../../scripts/fleet_telemetry_engine.py",
  );
  // Prefer the project venv so the `requests` dependency is resolvable.
  const pythonExecutable =
    process.platform === "win32"
      ? path.join(__dirname, "../../.venv/Scripts/python.exe")
      : path.join(__dirname, "../../.venv/bin/python");

  const args = [
    pythonScript,
    "--platform",
    platformId,
    "--date",
    targetDate,
    "--depth",
    String(targetDepth),
  ];

  console.log("\n+-- [telemetry] ------------------------------------------");
  console.log(`|  Platform : ${platformId}`);
  console.log(`|  Depth    : ${targetDepth}m`);
  console.log(`|  Date     : ${targetDate}`);
  console.log(`|  Script   : ${pythonScript}`);
  console.log("+---------------------------------------------------------");

  execFile(
    pythonExecutable,
    args,
    { timeout: 35000 },
    (error, stdout, stderr) => {
      // Surface Python progress messages (stderr) to the backend log.
      if (stderr) {
        stderr
          .split("\n")
          .filter(Boolean)
          .forEach((line) => {
            console.log(`  [*] ${line}`);
          });
      }

      if (error) {
        console.error("  [X] Spawn error:", error.message);
        return res.status(500).json({
          success: false,
          error: "Telemetry engine failed to run",
          detail: error.message,
        });
      }

      try {
        const payload = JSON.parse(stdout);

        if (!payload.success) {
          console.log(`  [X] Error: ${payload.error}`);
          return res.status(payload.status || 500).json(payload);
        }

        // Log the depth-first match (new schema).
        const ts = payload.time_status || {};
        const ds = payload.depth_status || {};
        const loc = payload.location || {};
        const tel = payload.telemetry || {};
        console.log(`  [+] ${ts.match_type || "match"}`);
        console.log(
          `  [i] Matched time : ${ts.matched || payload.matched_date}`,
        );
        console.log(
          `  [~] Depth: ${ds.matched !== undefined ? ds.matched : payload.actual_depth}m ` +
            `(requested ${ds.requested !== undefined ? ds.requested : payload.requested_depth}m)`,
        );
        console.log(`  [@] Loc  : ${loc.lat ?? "N/A"}, ${loc.lon ?? "N/A"}`);
        console.log(`  [T] Temp : ${tel.temp ?? "N/A"} C`);
        console.log(`  [S] Sal  : ${tel.salinity ?? "N/A"} PSU`);
        console.log(`  [O] O2   : ${tel.dissolved_o2 ?? "N/A"} umol/kg`);
        console.log(`  [C] Chl  : ${tel.chlorophyll ?? "N/A"} mg/m3`);
        console.log("");
        return res.json(payload);
      } catch (parseError) {
        console.error(
          "  [X] Failed to parse Python output:",
          stdout?.slice(0, 200),
        );
        console.error("  stderr:", stderr?.slice(0, 200));
        return res.status(500).json({
          success: false,
          error:
            "Internal server error: failed to parse telemetry engine output",
        });
      }
    },
  );
}

// Primary path + an argo-namespaced alias for consistency with float-details.
router.get("/telemetry", handleTelemetry);
router.get("/argo/telemetry", handleTelemetry);

export default router;
