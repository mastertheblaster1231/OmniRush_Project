import test from 'node:test';
import assert from 'node:assert/strict';

import { interpolateAt } from '../services/argoCore.js';
import { normalizeModelVariables } from '../services/modelGrid.js';
import { buildDelta } from '../services/validation.js';

test('interpolateAt uses bracketing measured levels and does not clamp outside them', () => {
  const levels = [
    { depth: 10, temp: 24 },
    { depth: 30, temp: 20 },
  ];

  assert.equal(interpolateAt(levels, 20, 'temp'), 22);
  assert.equal(interpolateAt(levels, 5, 'temp'), null);
  assert.equal(interpolateAt(levels, 35, 'temp'), null);
});

test('interpolateAt skips unavailable values instead of creating a bridge through them', () => {
  const levels = [
    { depth: 10, temp: 24 },
    { depth: 20, temp: null },
    { depth: 30, temp: 20 },
  ];

  assert.equal(interpolateAt(levels, 15, 'temp'), 23);
  assert.equal(interpolateAt(levels, 25, 'temp'), 21);
  assert.equal(interpolateAt(levels, 20, 'salinity'), null);
});

test('normalizeModelVariables maps connector aliases and preserves absence', () => {
  assert.deepEqual(
    normalizeModelVariables({ thetao: '24.125', so: 35.7 }),
    { temp: 24.125, psal: 35.7 }
  );
  assert.deepEqual(normalizeModelVariables({ temp: null, psal: 'not-a-number' }), {
    temp: null,
    psal: null,
  });
});

test('buildDelta returns only observed/model pairs and never a fallback number', () => {
  assert.deepEqual(buildDelta({ temp: 24, psal: null }, { temp: 23.5, psal: 35 }), {
    temp: 0.5,
  });
  assert.deepEqual(buildDelta({ temp: null }, {}), {});
});
