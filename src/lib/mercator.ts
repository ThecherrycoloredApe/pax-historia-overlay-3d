import { adapters } from '../config/adapters';

const R = adapters.mercator.earthRadiusM;

export interface MercatorMeters {
  x: number;
  y: number;
}

export function lngLatToMercator(lng: number, lat: number): MercatorMeters {
  return {
    x: (R * lng * Math.PI) / 180,
    y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  };
}

export function mercatorToLngLat(m: MercatorMeters): { lng: number; lat: number } {
  return {
    lng: (m.x / R / Math.PI) * 180,
    lat: ((2 * Math.atan(Math.exp(m.y / R)) - Math.PI / 2) * 180) / Math.PI,
  };
}

/**
 * La carte wrappe horizontalement (copies fantômes à ±worldWidthM) : ramène x
 * sur la copie du monde la plus proche d'un x de référence (le centre de vue).
 */
export function wrapToNearest(x: number, referenceX: number): number {
  const w = adapters.mercator.worldWidthM;
  let wrapped = x;
  while (wrapped - referenceX > w / 2) wrapped -= w;
  while (referenceX - wrapped > w / 2) wrapped += w;
  return wrapped;
}
