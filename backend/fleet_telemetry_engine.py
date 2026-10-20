#!/usr/bin/env python3
"""
argo_dive_report.py — Look up an Argo float's nearest-date dive on IFREMER
ERDDAP and print its shallowest depth layers in a clean terminal report.

Usage:
    python3 argo_dive_report.py --platform 2902746 --date 2024-03-15
    python3 argo_dive_report.py --platform 2902746 --date 2024-03-15T08:00:00Z
"""

import sys
import argparse
from datetime import datetime, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ERDDAP_BASE = "https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.json"
FULL_VARS = "time,latitude,longitude,pres,temp,psal,doxy,chla"
PHYSICAL_VARS = "time,latitude,longitude,pres,temp,psal"
REQUEST_TIMEOUT = 30


class CLIError(Exception):
    """A user-facing, fatal error — caught once in main() and reported cleanly."""


# ───────────────────────────── Fetching ──────────────────────────────────

def fetch_rows(platform_number):
    """
    Fetch raw telemetry rows for a platform from ERDDAP.

    Tries the full variable set (including BGC sensors doxy/chla) first.
    If ERDDAP returns 404 — meaning this float has no BGC sensors and the
    columns don't exist for it — retries with only the physical variables.

    Returns (rows, has_bgc) where has_bgc tells the renderer whether a
    missing O2/chlorophyll value means "no sensor on this float" or
    "sensor present, no reading at this depth".
    """
    url = f"{ERDDAP_BASE}?{FULL_VARS}&platform_number=%22{platform_number}%22"
    try:
        res = requests.get(url, timeout=REQUEST_TIMEOUT, verify=False)
    except requests.exceptions.RequestException as e:
        raise CLIError(f"network error contacting ERDDAP: {e}")

    has_bgc = True
    if res.status_code == 404:
        has_bgc = False
        safe_url = (
            f"{ERDDAP_BASE}?{PHYSICAL_VARS}&platform_number=%22{platform_number}%22"
        )
        try:
            res = requests.get(safe_url, timeout=REQUEST_TIMEOUT, verify=False)
        except requests.exceptions.RequestException as e:
            raise CLIError(f"network error contacting ERDDAP (BGC fallback): {e}")

    if res.status_code != 200:
        raise CLIError(f"ERDDAP API error: HTTP {res.status_code}")

    try:
        table = res.json()["table"]
    except (ValueError, KeyError, TypeError):
        raise CLIError("unexpected response shape from ERDDAP (not a valid data table)")

    rows = table.get("rows", [])
    if not rows:
        raise CLIError(f"no telemetry data found for platform {platform_number}")

    return rows, has_bgc


def parse_readings(rows, has_bgc):
    """
    Convert raw ERDDAP rows into reading dicts. A row is kept as long as it
    has a timestamp and a pressure — temp/psal/doxy/chla may legitimately
    be null at any given depth.
    """
    readings = []
    for r in rows:
        time_val, lat, lon, pres, temp, psal = r[0], r[1], r[2], r[3], r[4], r[5]
        doxy = r[6] if has_bgc and len(r) > 6 else None
        chla = r[7] if has_bgc and len(r) > 7 else None

        if time_val is None or pres is None:
            continue

        readings.append({
            "time": time_val,
            "lat": lat,
            "lon": lon,
            "pressure_dbar": pres,
            "temperature_c": temp,
            "salinity_psu": psal,
            "dissolved_o2": doxy,
            "chlorophyll": chla,
        })

    if not readings:
        raise CLIError("no valid sensor readings (missing time/pressure) found")
    return readings


# ───────────────────────────── Time handling ─────────────────────────────

def parse_erddap_time(time_str):
    """ERDDAP timestamps are ISO-8601 UTC, e.g. 2024-03-11T08:12:00Z."""
    return datetime.strptime(time_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def parse_target_date(date_str):
    """
    Accepts a full ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SSZ) or a bare
    date (YYYY-MM-DD, treated as 00:00:00 UTC that day).
    """
    date_str = date_str.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise CLIError(
        f"could not parse --date '{date_str}' — use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ"
    )


# ───────────────────────────── Dive matching ─────────────────────────────

def group_into_dives(readings):
    """
    Group readings into dives. One Argo profile ("dive") shares a single
    timestamp across all of its depth (pressure) levels, so grouping by
    the exact `time` string reconstructs each dive's full depth profile.
    Returns { time_str: [readings at every depth on that dive] }.
    """
    dives = {}
    for r in readings:
        dives.setdefault(r["time"], []).append(r)
    return dives


def find_nearest_dive(dives, target_dt):
    """
    Pick the dive whose timestamp is closest to target_dt, measured as an
    absolute difference in seconds across every historical dive.
    Returns (dive_time_str, dive_readings, days_difference).
    """
    best_time = None
    best_diff_seconds = None

    for time_str in dives:
        try:
            dt = parse_erddap_time(time_str)
        except ValueError:
            continue  # skip any malformed timestamp rather than crash
        diff = abs((dt - target_dt).total_seconds())
        if best_diff_seconds is None or diff < best_diff_seconds:
            best_diff_seconds = diff
            best_time = time_str

    if best_time is None:
        raise CLIError("none of the float's recorded dive timestamps could be parsed")

    days_diff = round(best_diff_seconds / 86400, 1)
    return best_time, dives[best_time], days_diff


def top_shallow_layers(dive_readings, count=3):
    """Sort a dive's readings by pressure (our depth proxy) ascending, take the top N."""
    return sorted(dive_readings, key=lambda r: r["pressure_dbar"])[:count]


# ───────────────────────────── Rendering ─────────────────────────────────

BOX_WIDTH = 70


def hr(char="─"):
    return char * BOX_WIDTH


def fmt_reading(value, unit):
    if value is None:
        return "—"
    if isinstance(value, (int, float)):
        return f"{value:.3f} {unit}".strip()
    return f"{value} {unit}".strip()


def missing_reason(sensor_label, has_bgc):
    """Explain a null O2/chlorophyll value: no sensor at all, or a data gap."""
    if not has_bgc:
        return f"platform has no {sensor_label} sensor"
    return "sensor present, but no reading recorded at this depth"


def fmt_bgc(value, unit, sensor_label, has_bgc):
    if value is not None:
        return f"{value:.3f} {unit}"
    return f"N/A (No Sensor — {missing_reason(sensor_label, has_bgc)})"


def render(platform_number, requested_date_str, dive_time, dive_readings, days_diff, has_bgc):
    layers = top_shallow_layers(dive_readings, count=3)
    lat = dive_readings[0]["lat"]
    lon = dive_readings[0]["lon"]

    print(hr("="))
    print(f" ARGO FLOAT TELEMETRY — Platform {platform_number}")
    print(hr("="))
    print(f" Coordinates:      {lat:.3f}°, {lon:.3f}°")
    print(hr())
    print(f" Requested date:   {requested_date_str}")
    print(f" Matched dive:     {dive_time}")
    if days_diff == 0.0:
        print(f" Match quality:    Exact match")
    else:
        print(f" Match quality:    Nearest available (Δ {days_diff} day(s))")
    print(hr())
    print(f" Top {len(layers)} shallowest depth layer(s) from this dive:")
    print(hr())

    for i, layer in enumerate(layers, start=1):
        print(f" Layer {i}  —  Pressure: {fmt_reading(layer['pressure_dbar'], 'dbar')}")
        print(f"   Temperature  : {fmt_reading(layer['temperature_c'], '°C')}")
        print(f"   Salinity     : {fmt_reading(layer['salinity_psu'], 'PSU')}")
        print(f"   Dissolved O2 : {fmt_bgc(layer['dissolved_o2'], 'µmol/kg', 'dissolved O2', has_bgc)}")
        print(f"   Chlorophyll  : {fmt_bgc(layer['chlorophyll'], 'mg/m³', 'chlorophyll', has_bgc)}")
        if i < len(layers):
            print(hr("-"))

    print(hr("="))


# ───────────────────────────── Entry point ────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Fetch Argo float telemetry from IFREMER ERDDAP and print the "
            "nearest-date dive's shallowest depth layers."
        )
    )
    parser.add_argument("--platform", required=True, help="Argo platform / WMO ID")
    parser.add_argument(
        "--date",
        required=True,
        help="Target date, ISO-8601 (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)",
    )
    args = parser.parse_args()

    try:
        target_dt = parse_target_date(args.date)
        rows, has_bgc = fetch_rows(args.platform)
        readings = parse_readings(rows, has_bgc)
        dives = group_into_dives(readings)
        dive_time, dive_readings, days_diff = find_nearest_dive(dives, target_dt)
        render(args.platform, args.date, dive_time, dive_readings, days_diff, has_bgc)
    except CLIError as e:
        print(f"\n✗ Error: {e}\n", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()