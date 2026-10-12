import type { BoundingBox } from './types';

const EARTH_RADIUS_MI = 3958.7613;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in miles. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A lat/lng box that fully contains a circle of `miles` around the point. Cheap pre-filter for the index. */
export function boundingBox(lat: number, lng: number, miles: number): BoundingBox {
  const dLat = miles / 69.0;
  const dLng = miles / (69.0 * Math.max(0.1, Math.cos(toRadians(lat))));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** DFW metro box, used by the mock source and handy for a first NOAA pull. */
export const DFW_BBOX: BoundingBox = { minLat: 32.4, maxLat: 33.5, minLng: -97.6, maxLng: -96.2 };
