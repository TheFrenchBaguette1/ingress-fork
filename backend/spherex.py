"""SPHEREx data access: find the exposures covering a sky position, download
small cutouts from IRSA and resample them onto a common north-up grid.

Everything that depends on the archive layout lives in this file, so a new
data release normally only needs a change to COLLECTIONS (or the
SPHEREX_COLLECTIONS environment variable).
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import math
import os
import random
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy.ndimage import binary_dilation, map_coordinates

log = logging.getLogger("ingress.spherex")
warnings.simplefilter("ignore", FITSFixedWarning)
logging.getLogger("astropy").setLevel(logging.ERROR)

IRSA = "https://irsa.ipac.caltech.edu"
# Public copy of the archive; file paths mirror IRSA's after IBE_PREFIX.
S3 = os.environ.get("SPHEREX_BUCKET_URL", "https://nasa-irsa-spherex.s3.amazonaws.com")
IBE_PREFIX = "/ibe/data/spherex/"

# Image collections searched, in order of preference. When the same exposure
# appears in more than one, the first collection listed wins.
COLLECTIONS = [
    c.strip()
    for c in os.environ.get(
        "SPHEREX_COLLECTIONS",
        "spherex_dr1,spherex_dr1_deep,spherex_qr3,spherex_qr3_deep",
    ).split(",")
    if c.strip()
]

CACHE_DIR = Path(os.environ.get("INGRESS_CACHE", Path(__file__).parent / ".cache"))
MAX_PARALLEL = int(os.environ.get("INGRESS_PARALLEL", "24"))  # bucket reads
IRSA_PARALLEL = int(os.environ.get("INGRESS_IRSA_PARALLEL", "4"))  # IRSA is rate limited

# ---- limits on what a request may ask for ---------------------------------
FOV_MIN_ARCMIN = 1.0
FOV_MAX_ARCMIN = 20.0
MJD_MIN = 60766.0  # 2025-04-01, before the first public survey exposure
MAX_EXPOSURES = 900
NATIVE_PIXEL_ARCSEC = 6.15
MAX_GRID = 240  # output images are never larger than this on a side

# Detector wavelength ranges in microns.
BANDS = {
    1: (0.75, 1.11),
    2: (1.10, 1.63),
    3: (1.63, 2.42),
    4: (2.42, 3.82),
    5: (3.81, 4.42),
    6: (4.41, 5.00),
}

# Flag bits whose pixels are dropped before stacking. Bits that mark real
# sky signal (SOURCE, GHOST, HALO, OVERFLOW on bright stars) are kept so that
# stars do not turn into holes.
FLAG_BITS = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC",
    9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
    15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK",
    21: "SOURCE", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK",
    26: "BLOOM", 27: "SNOWBALL", 28: "HALO",
}
MASKED_BITS = (0, 2, 6, 9, 10, 11, 17, 27)
BAD_MASK = sum(1 << b for b in MASKED_BITS)
SATURATED_MASK = 1 << 1  # OVERFLOW

_irsa_slots = threading.BoundedSemaphore(IRSA_PARALLEL)
_s3_slots = threading.BoundedSemaphore(MAX_PARALLEL)
_local = threading.local()


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers["User-Agent"] = "ingress-spherex-viewer"
    return _local.s


@dataclass(frozen=True)
class Grid:
    """North-up tangent-plane grid centred on the requested position."""

    ra: float
    dec: float
    fov_arcmin: float

    @property
    def scale(self) -> float:  # arcsec per output pixel
        return max(NATIVE_PIXEL_ARCSEC / 2, self.fov_arcmin * 60 / MAX_GRID)

    @property
    def n(self) -> int:
        return int(math.ceil(self.fov_arcmin * 60 / self.scale))

    def wcs(self) -> WCS:
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [self.ra, self.dec]
        w.wcs.crpix = [(self.n + 1) / 2, (self.n + 1) / 2]
        w.wcs.cdelt = [-self.scale / 3600, self.scale / 3600]
        return w

    def key(self) -> str:
        return f"{self.ra:.6f}_{self.dec:.6f}_{self.fov_arcmin:.3f}"


# ---------------------------------------------------------------- search ---


def search(ra: float, dec: float, mjd_start: float, mjd_end: float) -> list[dict]:
    """Exposures whose footprint contains the position, oldest first."""
    def query(coll):
        return _get_with_retry(
            f"{IRSA}/SIA",
            params={
                "COLLECTION": coll,
                "POS": f"circle {ra:.6f} {dec:.6f} 0.001",
                "TIME": f"{mjd_start:.5f} {mjd_end:.5f}",
                "RESPONSEFORMAT": "csv",
            },
        ).text

    with ThreadPoolExecutor(len(COLLECTIONS)) as ex:
        tables = list(ex.map(query, COLLECTIONS))

    seen: dict[tuple[str, int], dict] = {}
    for coll, text in zip(COLLECTIONS, tables):
        for row in csv.DictReader(io.StringIO(text)):
            try:
                det = int(row["energy_bandpassname"].rsplit("D", 1)[1])
                t0, t1 = float(row["t_min"]), float(row["t_max"])
            except (KeyError, ValueError, IndexError, TypeError):
                continue
            if row.get("dataproduct_type") != "image" or det not in BANDS:
                continue
            key = (row["obs_id"], det)
            if key in seen:
                continue
            seen[key] = {
                "id": f"{row['obs_id']}/D{det}",
                "det": det,
                "mjd": (t0 + t1) / 2,
                "url": row["access_url"],
                "collection": coll,
            }
    return sorted(seen.values(), key=lambda e: e["mjd"])


def thin(exposures: list[dict], limit: int = MAX_EXPOSURES) -> list[dict]:
    """Evenly subsample in time when a field has more exposures than the cap."""
    if len(exposures) <= limit:
        return exposures
    idx = np.unique(np.linspace(0, len(exposures) - 1, limit).round().astype(int))
    return [exposures[i] for i in idx]


# ------------------------------------------------------------- download ---


class IrsaError(RuntimeError):
    pass


def _get_with_retry(url, params=None, headers=None, stream=False, tries=7, slots=None):
    """GET with backoff. IRSA answers 503 'Server busy' when it is loaded."""
    slots = slots or _irsa_slots
    delay = 0.4
    for attempt in range(tries):
        try:
            with slots:
                r = _session().get(url, params=params, headers=headers, stream=stream, timeout=(15, 90))
                if r.status_code in (200, 206):
                    if not stream:
                        r.content  # read while holding the slot
                    return r
                status = r.status_code
                r.close()
        except requests.RequestException as e:
            status = repr(e)
        if attempt == tries - 1 or (isinstance(status, int) and status in (400, 403, 404, 416)):
            raise IrsaError(f"request failed ({status}): {url}")
        time.sleep(delay + random.random() * delay)
        delay = min(delay * 2, 8)
    raise IrsaError(url)


def _parse_header(buf: bytes, start: int = 0):
    """Parse the FITS header at `start`. Returns (header, data offset, padded
    data size), or None if `buf` ends before the header does."""
    pos = start
    while True:
        block = buf[pos : pos + 2880]
        if len(block) < 2880:
            return None
        pos += 2880
        if any(block[i : i + 8] == b"END     " for i in range(0, 2880, 80)):
            break
    hdr = fits.Header.fromstring(bytes(buf[start:pos]))
    size = 0
    if hdr.get("NAXIS", 0):
        size = abs(hdr["BITPIX"]) // 8
        for i in range(1, hdr["NAXIS"] + 1):
            size *= hdr[f"NAXIS{i}"]
        size = (size + hdr.get("PCOUNT", 0)) * hdr.get("GCOUNT", 1)
    return hdr, pos, (size + 2879) // 2880 * 2880


# -- primary source: byte-range reads of the full files in the public bucket --


def _s3_url(exp: dict) -> str:
    return S3 + "/" + exp["url"].split(IBE_PREFIX, 1)[1]


def _s3_range(url: str, first: int, last: int) -> bytes:
    r = _get_with_retry(url, headers={"Range": f"bytes={first}-{last}"}, slots=_s3_slots)
    return r.content


def _s3_header(url: str, start: int, guess: int = 31680):
    buf = _s3_range(url, start, start + guess - 1)
    while True:
        parsed = _parse_header(buf)
        if parsed:
            return parsed[0], start + parsed[1], parsed[2]
        buf += _s3_range(url, start + len(buf), start + len(buf) + 14399)


def _read_s3(exp: dict, want):
    """Read the IMAGE header plus the pixel rows that `want(header)` asks for.

    `want` returns the (x0, x1, y0, y1) box needed in detector pixels. Only
    those rows of the IMAGE and FLAGS planes are transferred, a few percent
    of the 66 MB file.
    """
    url = _s3_url(exp)
    head = _s3_range(url, 0, 31679)
    _, off, size = _parse_header(head)  # primary HDU, no data
    parsed = _parse_header(head, off + size)
    if parsed is None:
        hdr, img_off, img_size = _s3_header(url, off + size, 63360)
    else:
        hdr, img_off, img_size = parsed
    nx = hdr["NAXIS1"]
    x0, x1, y0, y1 = want(hdr)
    row = nx * 4
    img = np.frombuffer(_s3_range(url, img_off + y0 * row, img_off + y1 * row - 1), ">f4")
    img = img.reshape(y1 - y0, nx)[:, x0:x1].astype(np.float64)
    flg = _s3_flag_rows(url, img_off + img_size, nx, y0, y1)[:, x0:x1]
    return hdr, img, flg, x0, y0


def _s3_flag_rows(url: str, start: int, nx: int, y0: int, y1: int) -> np.ndarray:
    """Rows y0..y1 of the FLAGS plane, the HDU that begins at byte `start`.

    FLAGS is stored tile-compressed, one tile per image row: a table of
    (length, offset) pairs followed by a heap of compressed rows. The rows
    wanted are fetched from the heap and handed to astropy as a small
    compressed image of their own.
    """
    buf = _s3_range(url, start, start + 34559)  # header + tile table, normally
    while True:
        parsed = _parse_header(buf)
        if parsed and len(buf) >= parsed[1] + parsed[0]["NAXIS1"] * parsed[0]["NAXIS2"]:
            break
        buf += _s3_range(url, start + len(buf), start + len(buf) + 34559)
    fhdr, table_off, _ = parsed
    ny = fhdr.get("ZNAXIS2")
    if (
        fhdr.get("EXTNAME") != "FLAGS"
        or not fhdr.get("ZIMAGE")
        or fhdr.get("ZNAXIS1") != nx
        or (fhdr.get("ZTILE1"), fhdr.get("ZTILE2")) != (nx, 1)
        or fhdr["NAXIS1"] != 8
        or fhdr["NAXIS2"] != ny
    ):
        raise IrsaError(f"unexpected FLAGS layout: {url}")
    table = np.frombuffer(buf, ">i4", ny * 2, table_off).reshape(ny, 2)[y0:y1]
    heap0 = int(table[0, 1])
    heap1 = int(table[-1, 1] + table[-1, 0])
    heap_start = start + table_off + fhdr.get("THEAP", ny * 8)
    heap = _s3_range(url, heap_start + heap0, heap_start + heap1 - 1)

    sub = table.copy()
    sub[:, 1] -= heap0
    mini = fhdr.copy()
    mini["NAXIS2"] = mini["ZNAXIS2"] = y1 - y0
    mini["PCOUNT"] = len(heap)
    mini.remove("THEAP", ignore_missing=True)
    body = sub.tobytes() + heap
    raw = (
        fits.PrimaryHDU().header.tostring().encode()
        + mini.tostring().encode()
        + body
        + b"\0" * (-len(body) % 2880)
    )
    with fits.open(io.BytesIO(raw)) as hdul:
        return np.asarray(hdul[1].data, dtype=np.int64)


# -- fallback: IRSA's cutout service (rate limited, so much slower) ----------


def _read_cutout(exp: dict, grid: "Grid", n_hdus: int = 3):
    """Download a cutout but stop once the first `n_hdus` HDUs have arrived.

    A cutout is ~95% point-spread-function table, which the viewer never
    uses; it sits after the image planes, so the connection is dropped before
    it is sent.
    """
    size_deg = grid.fov_arcmin / 60 * math.sqrt(2) + 6 * NATIVE_PIXEL_ARCSEC / 3600
    full = f"{exp['url']}?center={grid.ra:.6f},{grid.dec:.6f}d&size={size_deg:.5f}"
    r = _get_with_retry(full, stream=True)
    buf, offset, hdus = bytearray(), 0, []
    try:
        for chunk in r.iter_content(65536):
            buf += chunk
            while len(hdus) < n_hdus:
                parsed = _parse_header(buf, offset)
                if parsed is None or len(buf) < parsed[1] + parsed[2]:
                    break
                hdus.append(parsed)
                offset = parsed[1] + parsed[2]
            if len(hdus) >= n_hdus:
                break
    finally:
        r.close()
    if len(hdus) < n_hdus:
        raise IrsaError(f"truncated cutout from IRSA: {full}")
    (hdr, ioff, _), (fhdr, foff, _) = hdus[1], hdus[2]
    shape = (hdr["NAXIS2"], hdr["NAXIS1"])
    img = np.frombuffer(buf, ">f4", shape[0] * shape[1], ioff).reshape(shape).astype(np.float64)
    flg = np.frombuffer(buf, ">i4", shape[0] * shape[1], foff).reshape(shape).astype(np.int64)
    return hdr, img, flg, 0, 0


# ----------------------------------------------------------- wavelength ---

_wave_tables: dict[str, tuple] = {}
_wave_lock = threading.Lock()


def _version_of(url: str) -> str:
    # .../level2/<week>/<pipeline version>/<detector>/<file>.fits
    parts = url.split("/")
    return parts[-3] if len(parts) > 3 else "unknown"


def _wave_table(exp: dict):
    """Per-detector lookup table mapping detector pixel -> (wavelength, bandwidth).

    It is the last HDU of every file and identical for a given detector and
    pipeline version, so it is fetched once per (detector, version), cached
    on disk and reused for every other exposure.
    """
    key = f"D{exp['det']}_{_version_of(exp['url'])}"
    if key in _wave_tables:
        return _wave_tables[key]
    with _wave_lock:
        if key in _wave_tables:
            return _wave_tables[key]
        path = CACHE_DIR / "wave" / f"{key}.npz"
        if path.exists():
            z = np.load(path)
            tab = (z["x"], z["y"], z["v"])
        else:
            try:  # the table HDU is the last 5760 bytes of the file
                r = _get_with_retry(_s3_url(exp), headers={"Range": "bytes=-5760"}, slots=_s3_slots)
                raw = r.content
            except IrsaError:  # fall back to a complete (tiny-area) cutout
                r = _get_with_retry(f"{exp['url']}?center=0,0&size=0.01")
                raw = r.content[-5760:]
            t = fits.open(io.BytesIO(fits.PrimaryHDU().header.tostring().encode() + raw))["WCS-WAVE"].data
            tab = (
                np.asarray(t["X"][0], float),
                np.asarray(t["Y"][0], float),
                np.asarray(t["VALUES"][0], float),
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp.npz")
            np.savez(tmp, x=tab[0], y=tab[1], v=tab[2])
            tmp.replace(path)
        _wave_tables[key] = tab
        return tab


def _bilinear_table(tab, xd, yd):
    """Bilinear interpolation of the wavelength table at detector pixels."""
    X, Y, V = tab
    xd = np.clip(xd, X[0], X[-1])
    yd = np.clip(yd, Y[0], Y[-1])
    i = np.clip(np.searchsorted(X, xd) - 1, 0, len(X) - 2)
    j = np.clip(np.searchsorted(Y, yd) - 1, 0, len(Y) - 2)
    fx = (xd - X[i]) / (X[i + 1] - X[i])
    fy = (yd - Y[j]) / (Y[j + 1] - Y[j])
    return (
        V[j, i] * ((1 - fx) * (1 - fy))[..., None]
        + V[j, i + 1] * (fx * (1 - fy))[..., None]
        + V[j + 1, i] * ((1 - fx) * fy)[..., None]
        + V[j + 1, i + 1] * (fx * fy)[..., None]
    )


# ------------------------------------------------------------ processing ---


def process(exp: dict, grid: Grid) -> tuple[dict, bytes]:
    """Return (metadata, float16 image bytes) for one exposure on `grid`.

    The image is background-subtracted surface brightness in MJy/sr, n x n,
    row 0 at the south edge, east to the left; NaN where there is no usable
    data. The background (mostly zodiacal light, which is smooth on these
    scales) is removed as the median of the field.
    """
    name = hashlib.sha1(f"v5|{exp['url']}|{grid.key()}".encode()).hexdigest()
    base = CACHE_DIR / "cut" / name[:2] / name
    meta_path, data_path = base.with_suffix(".json"), base.with_suffix(".f16")
    if meta_path.exists() and data_path.exists():
        try:
            return json.loads(meta_path.read_text()), data_path.read_bytes()
        except (OSError, ValueError):
            pass

    n = grid.n
    jj, ii = np.mgrid[0:n, 0:n]
    ra_o, dec_o = grid.wcs().all_pix2world(ii.ravel(), jj.ravel(), 0)
    found = {}

    def locate(hdr):
        """Sky position of every output pixel -> pixel position in the file."""
        px, py = WCS(hdr).all_world2pix(ra_o, dec_o, 0, quiet=True)
        found["px"], found["py"] = px, py
        nx, ny = hdr["NAXIS1"], hdr["NAXIS2"]
        x0 = int(np.clip(np.floor(np.nanmin(px)) - 2, 0, nx - 1))
        x1 = int(np.clip(np.ceil(np.nanmax(px)) + 3, x0 + 1, nx))
        y0 = int(np.clip(np.floor(np.nanmin(py)) - 2, 0, ny - 1))
        y1 = int(np.clip(np.ceil(np.nanmax(py)) + 3, y0 + 1, ny))
        return x0, x1, y0, y1

    try:
        hdr, img, flags, x0, y0 = _read_s3(exp, locate)
        source = "s3"
    except (IrsaError, KeyError, IndexError, ValueError) as e:
        log.info("bucket read failed (%s); using the IRSA cutout service", e)
        hdr, img, flags, x0, y0 = _read_cutout(exp, grid)
        locate(hdr)
        source = "irsa"
    px, py = found["px"] - x0, found["py"] - y0

    good = np.isfinite(img) & ((flags & BAD_MASK) == 0)
    # Saturated star cores would otherwise become holes: show them as bright
    # as the brightest unsaturated pixel instead.
    saturated = (flags & SATURATED_MASK) != 0
    if saturated.any():  # include the flagged fringe around each saturated core
        saturated |= binary_dilation(saturated, iterations=6) & ~good
    peak = float(img[good & ~saturated].max()) if (good & ~saturated).any() else 0.0
    img[~good] = 0.0
    img[saturated] = peak
    good |= saturated
    coords = np.vstack([py, px])
    num = map_coordinates(img, coords, order=1, mode="constant", cval=0.0)
    wgt = map_coordinates(good.astype(np.float64), coords, order=1, mode="constant", cval=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(wgt > 0.6, num / wgt, np.nan).reshape(n, n)

    finite = out[np.isfinite(out)]
    coverage = finite.size / out.size
    bkg = noise = 0.0
    if finite.size:
        bkg = float(np.median(finite))
        noise = float(1.4826 * np.median(np.abs(finite - bkg)))
        out -= bkg

    # Wavelength at the field centre and its gradient across the output grid.
    tab = _wave_table(exp)
    c = (n - 1) / 2
    pick = [int(round(c)) * n + int(round(c)), int(round(c)) * n, int(round(c)) * n + n - 1,
            int(round(c)), (n - 1) * n + int(round(c))]  # centre, W/E edges, S/N edges
    qx, qy = found["px"][pick], found["py"][pick]
    xd = qx + 1 - hdr["CRPIX1W"] + hdr["CRVAL1W"]
    yd = qy + 1 - hdr["CRPIX2W"] + hdr["CRVAL2W"]
    wl = _bilinear_table(tab, xd, yd)
    cy, cx = int(round(float(py[pick[0]]))), int(round(float(px[pick[0]])))
    center_flags = int(flags[cy, cx]) if 0 <= cy < flags.shape[0] and 0 <= cx < flags.shape[1] else 0

    meta = {
        "id": exp["id"],
        "det": exp["det"],
        "mjd": round(float(hdr.get("MJD-AVG", exp["mjd"])), 6),
        "wave": round(float(wl[0, 0]), 5),
        "bandwidth": round(float(wl[0, 1]), 5),
        "dwave_dx": float((wl[2, 0] - wl[1, 0]) / (n - 1)),
        "dwave_dy": float((wl[4, 0] - wl[3, 0]) / (n - 1)),
        "bkg": round(bkg, 5),
        "noise": round(noise, 5),
        "coverage": round(coverage, 3),
        "flags": center_flags,
        "collection": exp["collection"],
        "source": source,
    }
    data = out.astype("<f2").tobytes()
    base.parent.mkdir(parents=True, exist_ok=True)
    tmp = data_path.with_suffix(f".{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    tmp.replace(data_path)
    meta_path.write_text(json.dumps(meta))
    return meta, data
