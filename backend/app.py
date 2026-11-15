"""Ingress web server: a small API in front of the SPHEREx archive plus the
static front end.

    uvicorn backend.app:app --port 8000
"""

from __future__ import annotations

import concurrent.futures as cf
import json
import logging
import struct
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import spherex as sx

log = logging.getLogger("ingress")
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
MJD_EPOCH = date(1858, 11, 17).toordinal()
SURVEY_START = date.fromordinal(int(sx.MJD_MIN) + MJD_EPOCH)

app = FastAPI(title="Ingress", docs_url="/api/docs", openapi_url="/api/openapi.json")
# Worker threads spend their time waiting on the archive; the semaphores in
# spherex.py limit the load this server puts on it, across all its users.
pool = cf.ThreadPoolExecutor(max_workers=sx.MAX_PARALLEL)


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _mjd(d: date) -> float:
    return float(d.toordinal() - MJD_EPOCH)


def _validated(ra: float, dec: float, fov: float, start: date | None, end: date | None):
    today = _today()
    start = start or SURVEY_START
    end = end or today
    if start < SURVEY_START:
        raise HTTPException(422, f"start must be on or after {SURVEY_START.isoformat()}")
    if end > today:
        raise HTTPException(422, f"end must not be later than today ({today.isoformat()})")
    if start >= end:
        raise HTTPException(422, "start must be earlier than end")
    grid = sx.Grid(ra=ra % 360.0, dec=dec, fov_arcmin=fov)
    return grid, _mjd(start), _mjd(end) + 1.0  # end date is inclusive


@app.get("/api/config")
def config():
    return {
        "fov": {"min": sx.FOV_MIN_ARCMIN, "max": sx.FOV_MAX_ARCMIN, "default": 10},
        "date": {"min": SURVEY_START.isoformat(), "max": _today().isoformat()},
        "max_exposures": sx.MAX_EXPOSURES,
        "bands": {f"D{k}": v for k, v in sx.BANDS.items()},
        "flag_bits": sx.FLAG_BITS,
        "masked_bits": sx.MASKED_BITS,
        "collections": sx.COLLECTIONS,
    }


@app.get("/api/stream")
async def stream(
    ra: float = Query(..., ge=0, le=360, description="Right ascension, degrees (ICRS)"),
    dec: float = Query(..., ge=-90, le=90, description="Declination, degrees (ICRS)"),
    fov: float = Query(10, ge=sx.FOV_MIN_ARCMIN, le=sx.FOV_MAX_ARCMIN, description="Field of view, arcmin"),
    start: date | None = Query(None, description="First date, YYYY-MM-DD"),
    end: date | None = Query(None, description="Last date, YYYY-MM-DD"),
):
    """Stream every exposure of the field as it is downloaded.

    The body is a sequence of records: a little-endian uint32 giving the
    length of a JSON header, the header, then `header.nbytes` bytes of
    payload (a float16 image, n x n). The first record describes the field.
    """
    grid, mjd0, mjd1 = _validated(ra, dec, fov, start, end)
    try:
        found = await run_in_threadpool(sx.search, grid.ra, grid.dec, mjd0, mjd1)
    except sx.IrsaError as e:
        raise HTTPException(502, f"Could not reach the SPHEREx archive: {e}")
    exposures = sx.thin(found)

    def record(header: dict, payload: bytes = b"") -> bytes:
        header["nbytes"] = len(payload)
        h = json.dumps(header, separators=(",", ":")).encode()
        return struct.pack("<I", len(h)) + h + payload

    def generate():
        yield record(
            {
                "type": "field",
                "ra": grid.ra,
                "dec": grid.dec,
                "fov_arcmin": grid.fov_arcmin,
                "n": grid.n,
                "scale_arcsec": grid.scale,
                "total": len(exposures),
                "found": len(found),
                "mjd_start": mjd0,
                "mjd_end": mjd1,
            }
        )
        futures = [pool.submit(sx.process, e, grid) for e in exposures]
        try:
            for fut in cf.as_completed(futures):
                try:
                    meta, data = fut.result()
                    meta["type"] = "exposure"
                    yield record(meta, data)
                except Exception as e:  # one bad exposure must not end the stream
                    log.warning("exposure failed: %s", e)
                    yield record({"type": "error", "message": str(e)[:200]})
            yield record({"type": "done"})
        finally:
            for f in futures:  # client went away: drop work not yet started
                f.cancel()

    return StreamingResponse(
        generate(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
