// model.js — optional ML model, trained OFFLINE by scripts/ml/train.py.
//
// Policy (see scripts/ml/README.md):
//   * The formula in status-engine.estimateFor() is the baseline and always works.
//   * scripts/ml/train.py only writes public/model.json when there are enough
//     REAL feedback labels (>= 150) AND a random forest beat the formula's MAE
//     under leave-one-day-out cross-validation. It records both MAEs in the file.
//   * No model.json (the normal state today) -> loadModel() resolves to null and
//     the app uses the formula. Nothing here pretends a model exists.
//
// model.json format (compact random forest, sklearn tree arrays):
//   { type: "random_forest", use_model: true, features: [...names],
//     mae_model, mae_baseline, n_rows, n_days, trained_at,
//     trees: [{ left: [], right: [], feature: [], threshold: [], value: [] }, ...] }
// Node i is a leaf when left[i] === -1; otherwise go left if x[feature[i]] <= threshold[i].

import { MODEL_URL } from "./config.js";

/** Turn the estimate inputs into the numeric feature vector the model expects. */
export function encodeFeatures(names, f) {
  return names.map((name) => {
    if (name === "is_canteen") return f.cafe_type === "canteen" ? 1 : 0;
    const v = f[name];
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  });
}

/** Walk one tree to its leaf value. */
export function predictTree(tree, x) {
  let i = 0;
  while (tree.left[i] !== -1) {
    i = x[tree.feature[i]] <= tree.threshold[i] ? tree.left[i] : tree.right[i];
  }
  return tree.value[i];
}

/** Random-forest prediction = mean of the trees. NaN if any feature is missing. */
export function predictForest(model, features) {
  const x = encodeFeatures(model.features, features);
  if (x.some((v) => Number.isNaN(v))) return NaN;
  let sum = 0;
  for (const t of model.trees) sum += predictTree(t, x);
  return sum / model.trees.length;
}

/** Is this parsed JSON a usable, published model? Demo models trained on
 * synthetic data are always refused, even if someone copies one into public/. */
export function isUsableModel(m) {
  return (
    !!m &&
    m.type === "random_forest" &&
    m.use_model === true &&
    m.synthetic !== true &&
    Array.isArray(m.features) &&
    Array.isArray(m.trees) &&
    m.trees.length > 0
  );
}

let cached = null;
/**
 * Fetch public/model.json once. Resolves to { meta, predict(features) } or null
 * (missing file, offline, or a model that didn't beat the baseline).
 */
export function loadModel() {
  cached ||= (async () => {
    try {
      const res = await fetch(MODEL_URL, { cache: "no-cache" });
      if (!res.ok) return null;
      const m = await res.json();
      if (!isUsableModel(m)) return null;
      const { trees, ...meta } = m;
      return { meta, predict: (f) => predictForest(m, f) };
    } catch {
      return null;
    }
  })();
  return cached;
}
