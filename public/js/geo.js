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
