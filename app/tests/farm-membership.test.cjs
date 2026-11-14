'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, apply } = require('../frontend/farm-membership.js');

// An intentionally asymmetric Sumatra quadrilateral: [lat, lng], not GeoJSON order.
const sumatra = { id: 'sumatra', ring: [[-5, 102], [-4, 103], [-2, 102.5], [-3, 101], [-5, 102]] };
const field = { id: 'field', ring: [[-5, 102], [-4, 103], [-2, 102.5], [-3, 101]] };
const rec = (lat, lng, extra = {}) => ({ lat, lng, ...extra });

test('infers a strict interior point in the asymmetric Sumatra ring', () => {
  assert.deepEqual(resolve(rec(-3.5, 102.2), [sumatra]), {
    farmId: 'sumatra', status: 'inferred', candidates: ['sumatra'],
  });
});

test('does not assign a point outside the ring or with reversed coordinate axes', () => {
  assert.equal(resolve(rec(-3.5, 104), [sumatra]).status, 'unassigned');
  assert.equal(resolve(rec(102.2, -3.5), [sumatra]).status, 'missing-location');
});

test('treats edges, vertices, and epsilon-near-edge points as ambiguous', () => {
  for (const point of [rec(-5, 102), rec(-4, 103), rec(-5 + 5e-11, 102)]) {
    assert.deepEqual(resolve(point, [sumatra]), {
      farmId: null, status: 'ambiguous', candidates: ['sumatra'],
    });
  }
});

test('reports overlapping interior memberships as ambiguous independent of order', () => {
  const other = { id: 'other', ring: [[-4.5, 101.5], [-4.5, 103.5], [-2.5, 103], [-2.5, 101.5]] };
  const point = rec(-3.5, 102.2);
  assert.deepEqual(resolve(point, [sumatra, other]), { farmId: null, status: 'ambiguous', candidates: ['other', 'sumatra'] });
  assert.deepEqual(resolve(point, [other, sumatra]), { farmId: null, status: 'ambiguous', candidates: ['other', 'sumatra'] });
});

test('distinguishes missing location and accepts zero coordinates as valid', () => {
  assert.equal(resolve({ lat: null, lng: 0 }, [sumatra]).status, 'missing-location');
  assert.deepEqual(resolve(rec(0, 0), [{ id: 'origin', ring: [[-1, -1], [-1, 1], [1, 1], [1, -1]] }]), {
    farmId: 'origin', status: 'inferred', candidates: ['origin'],
  });
});

test('rejects invalid points and malformed or unsafe rings without assigning', () => {
  const invalidPoints = [rec('0', 0), rec(NaN, 0), rec(Infinity, 0), rec(91, 0), rec(0, -181)];
  for (const point of invalidPoints) assert.equal(resolve(point, [sumatra]).status, 'missing-location');
  const badRings = [
    { id: 'short', ring: [[0, 0], [1, 1], [2, 2]] },
    { id: 'bowtie', ring: [[0, 0], [2, 2], [0, 2], [2, 0]] },
    { id: 'antimeridian', ring: [[0, 170], [1, -170], [2, 170]] },
    { id: 'malformed', ring: [[0, 0], [1, 1], ['2', 0], [0, 0]] },
  ];
  for (const farm of badRings) assert.equal(resolve(rec(0.5, 0.5), [farm]).status, 'unassigned', farm.id);
});

test('preserves a valid explicit farm selection and ignores a nonexistent id', () => {
  assert.deepEqual(resolve(rec(0, 0, { farmId: 'sumatra' }), [sumatra]), {
    farmId: 'sumatra', status: 'assigned', candidates: ['sumatra'],
  });
  assert.equal(resolve(rec(-3.5, 102.2, { farmId: 'deleted' }), [sumatra]).status, 'inferred');
});

test('apply returns fresh records with derived assignment and never mutates input', () => {
  const records = [rec(-3.5, 102.2), rec(-5, 102), rec(null, null)];
  const copy = structuredClone(records);
  const output = apply(records, [sumatra]);
  assert.deepEqual(records, copy);
  assert.notEqual(output, records);
  assert.notEqual(output[0], records[0]);
  assert.deepEqual(output.map(({ farmId, farmAssignment }) => [farmId, farmAssignment]), [
    ['sumatra', 'inferred'], [null, 'ambiguous'], [null, 'missing-location'],
  ]);
});

test('uses null-prototype ids safely and returns sorted candidates independent of farm order', () => {
  const proto = { id: '__proto__', ring: sumatra.ring };
  const constructor = { id: 'constructor', ring: sumatra.ring };
  const point = rec(-3.5, 102.2);
  const expected = { farmId: null, status: 'ambiguous', candidates: ['__proto__', 'constructor'] };
  assert.deepEqual(resolve(point, [proto, constructor]), expected);
  assert.deepEqual(resolve(point, [constructor, proto]), expected);
  const manual = resolve(rec(90, 0, { farmId: '__proto__' }), [proto]);
  assert.deepEqual(manual, { farmId: '__proto__', status: 'assigned', candidates: ['__proto__'] });
});
