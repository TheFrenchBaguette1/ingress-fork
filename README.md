# Ingress

A web tool for watching any patch of sky change over time in images from
NASA's SPHEREx mission. Built for the 2026 NASA Space Apps SPHEREx challenge.

Enter coordinates and a date range; Ingress loads every SPHEREx exposure of
that field and plays them as an animation, so that objects which move or
change brightness stand out.

## Run it

```bash
pip install -r requirements.txt
```

```bash
uvicorn backend.app:app --port 8000
```

Then open http://localhost:8000. Or with Docker:

```bash
docker build -t ingress . && docker run -p 8000:8000 ingress
```

The server needs outbound HTTPS access to `irsa.ipac.caltech.edu` (search)
and `nasa-irsa-spherex.s3.amazonaws.com` (image data).

## Using it

- **Coordinates**: decimal degrees (`133.7951 -7.2451`) or sexagesimal
  (`08h55m10.831s -7d14m42.53s`, `08:55:10.8 -07:14:42`). RA must be 0–360°,
  Dec −90° to +90°.
- **Field of view to load**: 1–20 arcmin. After loading you can switch to any
  smaller field instantly.
- **Dates**: from 2025-04-01 to today.
- **Wavelength**: all light, one of the six detector bands, or a custom range
  between 0.75 and 5.0 µm.
- **Frames**: one per exposure (the default), per day, or per survey pass
  (about six months apart); shown as images or as the difference from the
  average.
- Space plays/pauses; the arrow keys step through frames.

All exposures of the field are downloaded once. Changing the wavelength
range, field of view, frame grouping or display settings afterwards works on
data already in the browser.

### Linking to a field

```
/?ra=269.4464&dec=4.7686&fov=5&start=2025-04-01&end=2026-11-15&band=D3&zoom=2&group=day
```

`ra` and `dec` (degrees) are required; the rest are optional.

## How it works

1. **Search.** IRSA's Simple Image Access service lists the Level 2 spectral
   images whose footprint contains the position.
2. **Read.** For each image, only the pixel rows covering the field are read
   from the public `nasa-irsa-spherex` bucket with HTTP range requests (a few
   percent of each 66 MB file). IRSA's cutout service is the fallback.
3. **Resample.** Each exposure is resampled onto one north-up grid centred
   on the target (3.075″ pixels up to 12′ fields, coarser above), flagged
   pixels are dropped and the median background is removed.
4. **Stream.** Exposures are streamed to the browser as they finish, with
   their time, wavelength and flags. The browser stacks them into frames.

A SPHEREx exposure sees each point of sky at one wavelength, which depends
on where the point falls on the detector. Each survey pass covers a point
about 100 times, once per spectral channel, so a frame for one band is the
average of the exposures of that pass whose wavelength falls in the band.

Fields with more than 900 exposures (near the ecliptic poles) are sampled
evenly in time; narrow the date range to see every exposure.

## Updating for new data releases

The image collections searched are set in one place, `COLLECTIONS` in
`backend/spherex.py`, or with the `SPHEREX_COLLECTIONS` environment variable
(comma separated, most preferred first). New exposures added to the existing
collections appear automatically.

Other settings: `INGRESS_CACHE` (cache directory), `INGRESS_PARALLEL`
(simultaneous bucket reads, default 24), `INGRESS_SEARCH_TTL` (seconds a
search result is reused, default 6 hours), `SPHEREX_BUCKET_URL`.

## Layout

- `backend/spherex.py`: archive search, download, resampling, limits
- `backend/app.py`: API (`/api/stream`, `/api/config`) and static files
- `frontend/`: the page, with no build step and no dependencies

Data: NASA/IPAC Infrared Science Archive, SPHEREx Spectral Image MEFs.
