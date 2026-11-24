# CafeQ ML pipeline (offline)

This pipeline predicts **time at the cafe**: minutes from joining the line to having the food.
It runs **offline on a laptop**, never in the web app or on a server, so it stays free.

## Policy: formula first, model only when it earns it

| Step | What happens |
|---|---|
| Baseline | The app ships a transparent formula: `queue × serving s/person ÷ 60 (× congestion when packed) + item prep`. |
| Labels | Students' one-tap answers to "How long did it actually take?" (`feedback` collection). This is the **only** source of labels. |
| Gate | Train only with **≥ 150–200 real rows** spread over **≥ 3 days**. |
| Validation | **Leave-one-day-out** cross-validation. The report gives the **MAE of both** the formula and the random forest. |
| Publish | `public/model.json` is written **only if** the forest's MAE is lower than the formula's. Otherwise the app keeps using the formula. |
| App | `public/js/model.js` loads `model.json` if present and predicts in the browser. It's missing or rejected → formula. |

Nothing claims a trained model until these steps have actually happened on real data.

## Features

`queue_count`, `hour` (IST), `day_of_week` (Mon = 0), `item_prep_min` (generic prep buffer if no
item was picked), `is_canteen`, `service_sec_per_person`. They are the same as `encodeFeatures()` in
`public/js/model.js`.

## Run it

```powershell
py -3 -m pip install -r scripts/ml/requirements.txt
```

**Real data.** On `/admin.html` → Export, click **Download feedback.csv**, then:
```powershell
py -3 scripts/ml/train.py --data C:\path\to\cafeq-feedback.csv
```
If an admin changed the thresholds, prep buffer or congestion factor, pass the same values
(`--green-max --yellow-max --prep-buffer --congestion`) so the baseline matches the live app.
If it prints "Random forest beats the formula", deploy (`npm run deploy:hosting`) so the app
picks up `public/model.json`. Put the printed MAEs in the report.

**Demo only (synthetic).**
```powershell
py -3 scripts/ml/generate_sample_data.py --rows 1500
```
```powershell
py -3 scripts/ml/train.py --data scripts/ml/data/synthetic_feedback.csv --demo
```
Synthetic rows are marked `source=synthetic`, and the generator documents how they are made.
`train.py` refuses to mix them with real rows, and writes the demo model only to
`scripts/ml/out/model.demo.json`. The app also refuses any model flagged `synthetic`.
**Never present demo numbers as findings.**

## Demo run (synthetic data, for illustration only)

On 24 Nov 2026 the pipeline was exercised end to end on synthetic data:

| Synthetic rows | Days | MAE formula | MAE forest | Decision |
|---|---|---|---|---|
| 400 | 16 | 1.5153 | 1.5155 | forest **not** better → keep formula |
| 1500 | 16 | 1.5597 | 1.4200 | forest better → demo model written (not used by the app) |

These numbers only show that the gate works in both directions. The synthetic data was generated
with effects the formula lacks (a lunch-rush slowdown, Mondays), so a big enough sample lets the
forest find them.

The JS tree walker matched sklearn's predictions to within 0.0001 min on the parity samples.
