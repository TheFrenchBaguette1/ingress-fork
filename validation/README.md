# Validation of the Measure feature

Two checks of Ingress's click-to-measure photometry against independent
data. Both drive the real page in a headless browser, so they test the code
users run. Last run: 2026-11-15.

## 1. Fluxes against 2MASS and AllWISE

Ordinary, isolated stars in the WISE 0855 field (10′, all exposures) were
measured with Ingress and compared with their catalogue fluxes. The Ingress
value for each filter is the mean of its measurements inside the filter's
wavelength window.

| Filter | Stars | Median ratio (Ingress / catalogue) | Star-to-star scatter |
|---|---|---|---|
| J | 8 | 0.92 | 0.06 |
| H | 8 | 0.93 | 0.04 |
| Ks | 8 | 0.88 | 0.05 |
| W1 | 8 | 0.87 | 0.09 |
| W2 | 8 | 0.96 | 0.13 |

Ingress fluxes are 4–13% below the catalogue values. That is the size and direction
expected from light falling outside the 9.5″ aperture, which Ingress does
not correct for. The scatter of 4–13% between stars reflects the
faintness of the sample (J = 13.7 to 15.0) and the simple top-hat filter
windows.

Limits: 8 stars in one field; a top-hat approximation of each filter;
catalogue epochs differ from SPHEREx's, so variable stars would add scatter.

## 2. Pulsation period of R Draconis

R Draconis is a Mira variable with a catalogued period of 245.6 days
(General Catalogue of Variable Stars). It saturates SPHEREx, so Ingress
measures the halo around it. Nightly means of its relative brightness were
fitted with a sinusoid at every trial period from 120 to 500 days.

| | |
|---|---|
| Nights of data | 167 over 518 days |
| Best-fit period | **245 days** (1σ range 242 to 249) |
| Catalogued period | 245.6 days |
| Peak-to-peak amplitude | 0.57 mag |

The recovered period agrees with the catalogue within its uncertainty,
from data covering about two cycles. A single sinusoid accounts for
50% of the variance; Mira light curves are not pure sinusoids and the
amplitude depends on wavelength, so the rest is expected.

The same calculation runs live in the app (`frontend/period.js`): opening
the site with no field selected loads R Draconis and shows this comparison.
The validation script calls that code, so the two cannot drift apart.

## Reproducing

```bash
uvicorn backend.app:app --port 8000
```

```bash
node validation/validate.js
```

Needs Node with Playwright. Results are written to `results.json`. The
catalogue files here were downloaded from IRSA's TAP service (tables
`fp_psc` and `allwise_p3as_psd`, 4.5′ cone on the field centre).
