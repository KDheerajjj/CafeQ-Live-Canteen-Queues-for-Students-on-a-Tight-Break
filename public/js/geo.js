// geo.js — pure geometry helpers. No DOM, no Firebase: unit-tested in Node.

const EARTH_RADIUS_M = 6371000; // mean Earth radius in metres

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lng points using the haversine formula.
 *   a = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2)
 *   d = 2R · atan2(√a, √(1−a))
 * Accurate to well under a metre at campus scale, which is far better than
 * phone GPS accuracy (typically 5–50 m).
 * @returns {number} distance in metres
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Is the reporter inside the cafe's geofence?
 * Strict rule from the spec: distance > geofence_m -> reject. GPS accuracy is
 * stored with the report (acc) for later filtering, not used to widen the fence.
 */
export function isWithinGeofence(distanceM, geofenceM) {
  return Number.isFinite(distanceM) && distanceM <= geofenceM;
}

/**
 * Rough walking minutes for a straight-line distance (ESTIMATE).
 * Straight lines under-count real paths, so multiply by a detour factor.
 */
export function estimateWalkMinutes(distanceM, speedMPerMin, detourFactor) {
  return Math.max(1, Math.round((distanceM * detourFactor) / speedMPerMin));
}

/**
 * Walk minutes to a cafe for THIS student.
 * - If we have a usable position fix (accuracy within maxAccuracyM), estimate
 *   from the student's own location -> { min, source: "you" }.
 * - Otherwise fall back to the cafe's stored walk_min, measured from the
 *   day-scholar reference point -> { min, source: "reference" }.
 * The student's position is only ever used here, in the browser; it is never stored.
 *
 * @param {{lat:number, lng:number, walk_min:number}} cafe
 * @param {{lat:number, lng:number, accuracy?:number}|null} userPos
 * @param {{speedMPerMin:number, detourFactor:number, maxAccuracyM:number}} opts
 */
export function resolveWalkMinutes(cafe, userPos, { speedMPerMin, detourFactor, maxAccuracyM }) {
  const usable =
    userPos &&
    Number.isFinite(userPos.lat) &&
    Number.isFinite(userPos.lng) &&
    Number.isFinite(cafe.lat) &&
    Number.isFinite(cafe.lng) &&
    (userPos.accuracy == null || userPos.accuracy <= maxAccuracyM);
  if (!usable) return { min: cafe.walk_min, source: "reference" };
  const meters = haversineMeters(userPos.lat, userPos.lng, cafe.lat, cafe.lng);
  return { min: estimateWalkMinutes(meters, speedMPerMin, detourFactor), source: "you" };
}
