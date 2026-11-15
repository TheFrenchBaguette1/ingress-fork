"""The test targets offered on the page, kept ready to open quickly.

Each target's list of exposures is bundled in presets.json, so opening one
never waits on (or fails with) the archive's search service. When
INGRESS_PREWARM=1 the server also prepares their images in the background at
start-up, and afterwards checks the archive now and then for new exposures.

Rebuild the bundled lists after a data release with:

    python -m backend.presets
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from . import spherex as sx

log = logging.getLogger("ingress.presets")
PATH = Path(__file__).with_name("presets.json")
FOV_ARCMIN = 10.0  # the field of view that is prepared in advance
WARM_WORKERS = int(os.environ.get("INGRESS_PREWARM_WORKERS", "4"))
REFRESH_HOURS = float(os.environ.get("INGRESS_PRESET_REFRESH_HOURS", "12"))
MATCH_ARCSEC = 2.0

# name, description shown in the menu, RA and Dec in degrees (ICRS).
TARGETS = [
    ("Barnard's Star", "fast proper motion", 269.4464, 4.7686),
    ("Epsilon Indi B", "brown dwarf pair", 331.096, -56.801),
    ("WISE 0855−0714", "cold brown dwarf", 133.795129, -7.245147),
    ("RW Aurigae", "variable star", 76.9564, 30.4014),
    ("R Draconis", "variable star", 248.1675, 66.7550),
]

_presets: list[dict] = []
_lock = threading.Lock()


def _load() -> None:
    try:
        bundled = {p["name"]: p for p in json.loads(PATH.read_text())["presets"]}
    except (OSError, ValueError, KeyError):
        bundled = {}
    for name, note, ra, dec in TARGETS:
        p = bundled.get(name, {})
        same_place = p and abs(p["ra"] - ra) < 1e-6 and abs(p["dec"] - dec) < 1e-6
        _presets.append({
            "name": name, "note": note, "ra": ra, "dec": dec,
            "exposures": p["exposures"] if same_place else None,  # None: search live
            "ready": 0, "total": 0,
        })


_load()


def _today_mjd() -> float:
    return float(date.today().toordinal() - date(1858, 11, 17).toordinal())


def listing() -> list[dict]:
    """What the page needs to show the menu."""
    return [
        {"name": p["name"], "note": p["note"], "ra": p["ra"], "dec": p["dec"],
         "bundled": p["exposures"] is not None, "prepared": bool(p["total"]) and p["ready"] >= p["total"]}
        for p in _presets
    ]


def find(ra: float, dec: float) -> list[dict] | None:
    """The bundled exposures if (ra, dec) is one of the targets, else None."""
    for p in _presets:
        d_ra = (ra - p["ra"] + 180) % 360 - 180
        sep = math.hypot(d_ra * math.cos(math.radians(dec)), dec - p["dec"]) * 3600
        if sep <= MATCH_ARCSEC and p["exposures"] is not None:
            return p["exposures"]
    return None


def _warm(p: dict) -> None:
    """Process every exposure of a target into the image cache."""
    exposures = sx.thin([e for e in p["exposures"] if e["mjd"] >= sx.MJD_MIN])
    grid = sx.Grid(ra=p["ra"] % 360.0, dec=p["dec"], fov_arcmin=FOV_ARCMIN)
    p["total"], p["ready"] = len(exposures), 0

    def one(e):
        try:
            sx.process(e, grid)
            return True
        except Exception as err:  # keep going; the request path will retry it
            log.warning("prewarm of %s failed: %s", e["id"], err)
            return False

    t0 = time.time()
    with ThreadPoolExecutor(WARM_WORKERS) as pool:
        for ok in pool.map(one, exposures):
            p["ready"] += 1
    log.info("prepared %s: %d exposures in %.0f s", p["name"], len(exposures), time.time() - t0)


def _refresh(p: dict) -> bool:
    """Ask the archive for the target's current exposures. True if they changed."""
    try:
        found, complete = sx.search(p["ra"] % 360.0, p["dec"], sx.MJD_MIN, _today_mjd() + 1)
    except sx.IrsaError:
        return False
    old = {e["id"] for e in p["exposures"] or []}
    # Only a complete answer may replace the list, and it must not lose data.
    if not complete or not found or (old and not old <= {e["id"] for e in found} and len(found) < len(old)):
        return False
    changed = {e["id"] for e in found} != old
    with _lock:
        p["exposures"] = found
    return changed


def _background() -> None:
    for p in _presets:
        if p["exposures"] is None:
            _refresh(p)
        if p["exposures"]:
            _warm(p)
    while REFRESH_HOURS > 0:
        time.sleep(REFRESH_HOURS * 3600)
        for p in _presets:
            if _refresh(p):
                log.info("new exposures for %s", p["name"])
                _warm(p)


def start() -> None:
    """Begin preparing the targets, if this deployment asks for it."""
    if os.environ.get("INGRESS_PREWARM") == "1":
        threading.Thread(target=_background, name="prewarm", daemon=True).start()


def build() -> None:
    """Query the archive and rewrite presets.json."""
    out = []
    for name, note, ra, dec in TARGETS:
        for attempt in range(20):
            try:
                found, complete = sx.search(ra % 360.0, dec, sx.MJD_MIN, _today_mjd() + 1)
            except sx.IrsaError:
                found, complete = [], False
            if complete and found:
                break
            print(f"  {name}: archive did not answer fully, retrying")
            time.sleep(3)
        else:
            raise SystemExit(f"could not get a complete exposure list for {name}")
        print(f"{name}: {len(found)} exposures")
        out.append({"name": name, "ra": ra, "dec": dec, "exposures": found})
    PATH.write_text(json.dumps({"built": date.today().isoformat(), "presets": out}, separators=(",", ":")))
    print(f"wrote {PATH} ({PATH.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    build()
