#!/usr/bin/env python3
"""
fleet_telemetry_engine.py
─────────────────────────
Depth-First Argo float telemetry fetcher for IFREMER ERDDAP.

Depth-First Search (primary, powers the /api/telemetry contract):
  Locks in the requested depth first, then scans the float's ENTIRE history
  (every dive, every sensor reading) and returns the single reading whose
  pressure is closest to the requested depth, plus the exact date/time the
  float was at that depth. The optional --date only qualifies time_status
  (e.g. "Exact Depth Match -> Nearest Time"); it does not drive the search.

Legacy date-then-depth resolution is retained so existing consumers of the
matched_reading / match_type contract (the /api/argo/float-details route and
the WorkspaceManager telemetry card) keep working unchanged.

Output: Strict JSON to stdout (consumed by Node.js Express via execFile).
"""

import sys
import json
import warnings
import argparse
import requests
import urllib3
from datetime import datetime, timezone

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings("ignore")


def emit_json(payload):
    """Print strict JSON to stdout and exit cleanly."""
    print(json.dumps(payload, default=str))
    sys.exit(0)


def emit_error(message, status=500):
    """Print an error JSON and exit with code 1."""
    print(json.dumps({"success": False, "error": message, "status": status}))
    sys.exit(1)


def fetch_float_data(platform_number):
    """
    Fetches ALL historical dives for a given Argo float from IFREMER ERDDAP.
    Returns a list of dive dicts grouped by time, or raises on failure.
    """
    url = (
        "https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.json"
        "?time,latitude,longitude,pres,temp,psal,doxy,chla"
        f"&platform_number=%22{platform_number}%22"
        "&orderBy(%22time,pres%22)"
    )

    try:
        res = requests.get(url, timeout=30, verify=False)
        if res.status_code != 200:
            emit_error(f"ERDDAP returned HTTP {res.status_code}", 502)

        data = res.json()
        rows = data.get("table", {}).get("rows", [])
        if not rows:
            emit_error(
                f"No telemetry data found for platform {platform_number}. "
                "The float may not exist or may have no recent profiles.",
                404,
            )

        # Group rows into dives by timestamp
        dives = {}
        for row in rows:
            time_val, lat, lon, pres, temp, psal, doxy, chla = row
            if time_val not in dives:
                dives[time_val] = {
                    "time": time_val,
                    "lat": lat,
                    "lon": lon,
                    "readings": [],
                }
            if pres is not None and temp is not None:
                dives[time_val]["readings"].append({
                    "pressure_dbar": pres,
                    "temperature_c": temp,
                    "salinity_psu": psal,
                    "dissolved_oxygen_umol_kg": doxy,
                    "chlorophyll_a_mg_m3": chla,
                })

        # Filter out empty dives
        valid_dives = [d for d in dives.values() if d["readings"]]
        if not valid_dives:
            emit_error("Float has profile data but no valid sensor readings.", 404)

        return valid_dives

    except requests.exceptions.RequestException as e:
        emit_error(f"Failed to connect to ERDDAP: {str(e)}", 502)


def resolve_dive_by_date(dives, date_str):
    """
    Resolves which dive to use based on the user's date input.

    Returns: (dive_dict, match_type, time_offset_seconds)
      match_type: "real_time" | "exact_match" | "nearest_historical"
    """
    if not date_str or date_str.lower() in ("latest", "none", ""):
        # ── REAL-TIME: return the most recent dive ──
        latest = max(dives, key=lambda d: d["time"])
        return latest, "real_time", 0

    # Parse the user-supplied date
    try:
        # Handle multiple date formats
        for fmt in (
            "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%d",
        ):
            try:
                target_dt = datetime.strptime(date_str, fmt).replace(
                    tzinfo=timezone.utc
                )
                break
            except ValueError:
                continue
        else:
            emit_error(
                f"Invalid date format: '{date_str}'. "
                "Expected ISO-8601 (e.g. 2024-09-23T10:00:00Z or 2024-09-23).",
                400,
            )
    except Exception:
        emit_error(f"Could not parse date: '{date_str}'", 400)

    # Search for exact or nearest match
    best_dive = None
    best_diff = float("inf")

    for dive in dives:
        try:
            dive_dt = datetime.strptime(dive["time"], "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue

        diff = abs((dive_dt - target_dt).total_seconds())

        if diff < best_diff:
            best_diff = diff
            best_dive = dive

    if best_dive is None:
        emit_error("No dives found matching the requested time window.", 404)

    # Exact match = within 1 hour (3600 seconds)
    if best_diff <= 3600:
        return best_dive, "exact_match", best_diff
    else:
        return best_dive, "nearest_historical", best_diff


def resolve_depth(readings, target_depth):
    """
    Finds the sensor reading closest to the user's requested depth.
    Returns: (matched_reading, actual_depth, depth_offset)
    """
    best = None
    best_diff = float("inf")

    for reading in readings:
        diff = abs(reading["pressure_dbar"] - target_depth)
        if diff < best_diff:
            best_diff = diff
            best = reading

    return best, best["pressure_dbar"] if best else None, best_diff


def format_time_offset(seconds):
    """Human-readable time offset string."""
    if seconds < 60:
        return f"{seconds:.0f} seconds"
    elif seconds < 3600:
        return f"{seconds / 60:.1f} minutes"
    elif seconds < 86400:
        return f"{seconds / 3600:.1f} hours"
    else:
        return f"{seconds / 86400:.1f} days"


# ── Depth-First Search (primary: powers /api/telemetry) ─────────────────────
def resolve_by_depth_first(dives, requested_depth):
    """
    Depth-First Search: lock the requested depth, then scan the float's
    entire history (all dives, all readings) for the reading whose pressure is
    closest to the requested depth.
    Returns: (best_reading, best_dive, depth_offset)
    """
    best_reading = None
    best_dive = None
    best_diff = float("inf")

    for dive in dives:
        for reading in dive["readings"]:
            diff = abs(reading["pressure_dbar"] - requested_depth)
            if diff < best_diff:
                best_diff = diff
                best_reading = reading
                best_dive = dive

    return best_reading, best_dive, best_diff


def parse_timestamp(ts):
    """Parse an ISO-8601 / ERDDAP timestamp into an aware UTC datetime (or None)."""
    if not ts:
        return None
    for fmt in (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(
        description="Fleet Telemetry Engine — Depth-First Argo Data Fetcher"
    )
    parser.add_argument(
        "--platform",
        required=True,
        help="Argo platform number (e.g., 2902351 or 4902626)",
    )
    parser.add_argument(
        "--date",
        required=False,
        default="latest",
        help="ISO-8601 date (e.g., 2024-09-23T10:00:00Z) or 'latest' for real-time",
    )
    parser.add_argument(
        "--depth",
        type=float,
        required=False,
        default=15.0,
        help="Target depth in meters/dbar (e.g., 15.0)",
    )

    args = parser.parse_args()

    # Clean the platform number (strip "argo-" prefix if present)
    platform = args.platform.replace("argo-", "").replace("Argo ", "").strip()
    is_realtime = not args.date or args.date.lower() in ("latest", "none", "")
    requested_date = args.date if not is_realtime else None

    # ── Step 1: Fetch all dives from ERDDAP ──
    sys.stderr.write(f"[fleet_telemetry_engine] Fetching data for platform {platform}...\n")
    dives = fetch_float_data(platform)
    sys.stderr.write(
        f"[fleet_telemetry_engine] Found {len(dives)} dives "
        f"({sum(len(d['readings']) for d in dives)} readings)\n"
    )

    # ── Step 2a: Depth-First Search (primary resolution for the new schema) ──
    df_reading, df_dive, df_depth_offset = resolve_by_depth_first(dives, args.depth)
    if df_reading is None:
        emit_error("No sensor readings found for this float.", 404)

    matched_time = df_dive["time"]
    actual_depth = df_reading["pressure_dbar"]

    sys.stderr.write(
        f"[fleet_telemetry_engine] Depth-First match: requested={args.depth}m, "
        f"actual={actual_depth}m, offset={df_depth_offset:.1f}m\n"
    )

    # ── Step 2b: Qualify the time relationship for time_status ──
    req_dt = parse_timestamp(args.date) if not is_realtime else None
    match_dt = parse_timestamp(matched_time)
    if req_dt and match_dt:
        time_offset_seconds = abs((match_dt - req_dt).total_seconds())
    else:
        time_offset_seconds = 0
    time_offset_label = format_time_offset(time_offset_seconds) if not is_realtime else None

    # Depth match label
    if df_depth_offset == 0:
        depth_label = "Exact Depth Match"
    elif df_depth_offset <= 5.0:
        depth_label = "Near Depth Match"
    else:
        depth_label = "Nearest Depth Match"

    # Time label
    if is_realtime:
        time_label = "Latest"
    elif time_offset_seconds <= 3600:
        time_label = "Exact Time"
    else:
        time_label = "Nearest Time"

    new_match_type = f"{depth_label} -> {time_label}"

    # ── Step 2c: Legacy date-then-depth resolution (keeps /argo/float-details contract) ──
    leg_dive, leg_match_type, leg_time_offset = resolve_dive_by_date(dives, args.date)
    leg_reading, leg_actual_depth, leg_depth_offset = resolve_depth(
        leg_dive["readings"], args.depth
    )
    if leg_reading is None:
        leg_reading = df_reading
        leg_dive = df_dive
        leg_actual_depth = actual_depth
        leg_depth_offset = df_depth_offset
        leg_match_type = "real_time" if is_realtime else "nearest_historical"
        leg_time_offset = time_offset_seconds

    sys.stderr.write(
        f"[fleet_telemetry_engine] time_status={new_match_type} | "
        f"matched_time={matched_time} | total_dives={len(dives)}\n"
    )

    # ── Step 3: Build the response payload ──
    payload = {
        # ── NEW SCHEMA (Depth-First Search) ──
        "success": True,
        "platform_id": platform,
        "time_status": {
            "matched": matched_time,
            "match_type": new_match_type,
            "requested": requested_date,
            "offset_seconds": round(time_offset_seconds, 1) if not is_realtime else None,
            "offset_label": time_offset_label,
        },
        "location": {
            "lat": round(df_dive["lat"], 4) if df_dive["lat"] else None,
            "lon": round(df_dive["lon"], 4) if df_dive["lon"] else None,
        },
        "depth_status": {
            "requested": args.depth,
            "matched": actual_depth,
            "offset": round(df_depth_offset, 1),
            "unit": "dbar",
        },
        "telemetry": {
            "temp": df_reading["temperature_c"],
            "salinity": df_reading["salinity_psu"],
            "dissolved_o2": df_reading["dissolved_oxygen_umol_kg"],
            "chlorophyll": df_reading["chlorophyll_a_mg_m3"],
            "pressure_dbar": actual_depth,
        },
        # ── LEGACY FIELDS (backward compatible with /api/argo/float-details) ──
        "platform_number": platform,
        "match_type": leg_match_type,
        "match_type_label": {
            "real_time": "Real-Time (Latest)",
            "exact_match": "Exact Match",
            "nearest_historical": f"Nearest Historical (Δ {format_time_offset(leg_time_offset)})",
        }.get(leg_match_type, leg_match_type),
        "matched_date": leg_dive["time"],
        "requested_date": requested_date,
        "time_offset_seconds": leg_time_offset,
        "time_offset_label": format_time_offset(leg_time_offset) if leg_time_offset > 0 else None,
        "requested_depth": args.depth,
        "actual_depth": leg_actual_depth,
        "depth_offset": round(leg_depth_offset, 1),
        "matched_reading": {
            "pressure_dbar": leg_actual_depth,
            "temperature_c": leg_reading["temperature_c"],
            "salinity_psu": leg_reading["salinity_psu"],
            "dissolved_oxygen_umol_kg": leg_reading["dissolved_oxygen_umol_kg"],
            "chlorophyll_a_mg_m3": leg_reading["chlorophyll_a_mg_m3"],
        },
        "total_dives_available": len(dives),
        "total_readings_in_dive": len(leg_dive["readings"]),
        "data_source": "ifremer-erddap",
        "erddap_dataset": "ArgoFloats",
    }

    # ── Step 4: Output strict JSON to stdout ──
    emit_json(payload)


if __name__ == "__main__":
    main()

