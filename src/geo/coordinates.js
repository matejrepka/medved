export const SLOVAK_COORDINATE_BOUNDS = Object.freeze({
  minLat: 47.65,
  maxLat: 49.7,
  minLng: 16.75,
  maxLng: 22.65,
});

export function isSlovakCoordinate(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= SLOVAK_COORDINATE_BOUNDS.minLat &&
    lat <= SLOVAK_COORDINATE_BOUNDS.maxLat &&
    lng >= SLOVAK_COORDINATE_BOUNDS.minLng &&
    lng <= SLOVAK_COORDINATE_BOUNDS.maxLng
  );
}
