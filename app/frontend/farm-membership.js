'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JagaFarmMembership = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EPSILON = 1e-10;
  // Inference is geometry-only: no fabricated GPS values or accuracy-buffer claim.
  // A real fix's reported accuracy may straddle a boundary; callers should surface that uncertainty.
  function validPoint(record) {
    if (!record || typeof record !== 'object') return null;
    const { lat, lng } = record;
    if (typeof lat !== 'number' || typeof lng !== 'number' ||
        !Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }

  function orientation(a, b, c) {
    return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
  }

  function onSegment(point, a, b) {
    const dx = b[1] - a[1];
    const dy = b[0] - a[0];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point[1] - a[1], point[0] - a[0]) <= EPSILON;
    const t = Math.max(0, Math.min(1, ((point[1] - a[1]) * dx + (point[0] - a[0]) * dy) / lengthSquared));
    return Math.hypot(point[1] - (a[1] + t * dx), point[0] - (a[0] + t * dy)) <= EPSILON;
  }

  function segmentsIntersect(a, b, c, d) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
        ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    return (o1 === 0 && onSegment(c, a, b)) || (o2 === 0 && onSegment(d, a, b)) ||
      (o3 === 0 && onSegment(a, c, d)) || (o4 === 0 && onSegment(b, c, d));
  }

  function validRing(farm) {
    if (!farm || typeof farm !== 'object' || !Array.isArray(farm.ring)) return null;
    const ring = farm.ring;
    if (ring.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== 'number' || typeof pair[1] !== 'number' ||
      !Number.isFinite(pair[0]) || !Number.isFinite(pair[1]) ||
      pair[0] < -90 || pair[0] > 90 || pair[1] < -180 || pair[1] > 180)) return null;
    const points = ring.map(pair => [pair[0], pair[1]]);
    if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
    const distinct = new Set(points.map(pair => `${pair[0]}\u0000${pair[1]}`));
    if (distinct.size < 3) return null;
    const lngs = points.map(pair => pair[1]);
    if (Math.max(...lngs) - Math.min(...lngs) > 180) return null;
    let twiceArea = 0;
    for (let i = 0; i < points.length; i += 1) {
      const next = points[(i + 1) % points.length];
      const current = points[i];
      if (current[0] === next[0] && current[1] === next[1]) return null;
      twiceArea += current[1] * next[0] - next[1] * current[0];
    }
    if (!Number.isFinite(twiceArea) || twiceArea === 0) return null;
    const n = points.length;
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % n];
      for (let j = i + 1; j < n; j += 1) {
        if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
        if (segmentsIntersect(a, b, points[j], points[(j + 1) % n])) return null;
      }
    }
    return points;
  }

  function pointInRing(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const a = points[j];
      const b = points[i];
      if (onSegment(point, a, b)) return 'boundary';
      if ((a[0] > point[0]) !== (b[0] > point[0])) {
        const crossingLng = (b[1] - a[1]) * (point[0] - a[0]) / (b[0] - a[0]) + a[1];
        if (point[1] < crossingLng) inside = !inside;
      }
    }
    return inside ? 'inside' : 'outside';
  }

  function resolve(record, farms) {
    const list = Array.isArray(farms) ? farms : [];
    const idToFarm = new Map();
    for (const farm of list) {
      if (farm && typeof farm === 'object' && typeof farm.id === 'string') idToFarm.set(farm.id, farm);
    }
    if (record && typeof record.farmId === 'string' && idToFarm.has(record.farmId)) {
      return { farmId: record.farmId, status: 'assigned', candidates: [record.farmId] };
    }
    const point = validPoint(record);
    if (!point) return { farmId: null, status: 'missing-location', candidates: [] };

    const inside = [];
    const boundary = [];
    for (const [id, farm] of idToFarm) {
      const ring = validRing(farm);
      if (!ring) continue;
      const result = pointInRing(point, ring);
      if (result === 'inside') inside.push(id);
      else if (result === 'boundary') boundary.push(id);
    }
    const candidates = [...inside, ...boundary].sort();
    if (boundary.length || inside.length > 1) return { farmId: null, status: 'ambiguous', candidates };
    if (inside.length === 1) return { farmId: inside[0], status: 'inferred', candidates: inside };
    return { farmId: null, status: 'unassigned', candidates: [] };
  }

  function apply(records, farms) {
    return (Array.isArray(records) ? records : []).map(record => {
      const assignment = resolve(record, farms);
      return { ...record, farmId: assignment.farmId, farmAssignment: assignment.status };
    });
  }

  return { resolve, apply, validateRing: ring => Boolean(validRing({ring})) };
});
