'use strict';

// The humidity chart: how far back, and thinning a long history.

const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../smart_ventilation/app/chart');

const H = 3600000;

test('only 3 h, 24 h, 3 days and 7 days; anything else is 3 hours', () => {
  assert.deepEqual([3, 24, 72, 168, '72', 5, 'x', null].map(chart.hoursOf), [3, 24, 72, 168, 72, 3, 3, 3]);
});

test('Home Assistant rows become sorted readings; not a number is left out', () => {
  const rows = [{ s: '60', lu: 20 }, { s: 'unavailable', lu: 15 }, { s: '55.5', lu: 10 }, { state: '57', last_updated: new Date(30000).toISOString() }];
  assert.deepEqual(chart.parseRows(rows), [{ t: 10000, v: 55.5 }, { t: 20000, v: 60 }, { t: 30000, v: 57 }]);
});

test('a week of readings is thinned, but a short shower peak stays', () => {
  const from = 0;
  const to = 168 * H;
  const pts = [];
  for (let t = from; t < to; t += 60000) pts.push({ t, v: 55 });
  pts.push({ t: 100 * H + 30000, v: 88 }); // one reading: the peak
  pts.sort((a, b) => a.t - b.t);
  const line = chart.line(pts, from, to);
  assert.ok(line.length <= chart.BUCKETS * 2 + 1, `${line.length} points`);
  assert.ok(line.some((p) => p[1] === 88), 'the peak is kept');
  assert.deepEqual(line[0], [from, 55]);
});

test('the reference line is the median of the reference sensors', () => {
  const a = [{ t: 0, v: 50 }, { t: 10, v: 60 }];
  const b = [{ t: 0, v: 52 }];
  const c = [{ t: 5, v: 70 }];
  assert.deepEqual(chart.referenceLine([a, b, c]), [{ t: 0, v: 51 }, { t: 5, v: 52 }, { t: 10, v: 60 }]);
});

test('boost and afterrun bands, also one that started before the chart', () => {
  const log = [
    { t: 5, to: 'boost' }, { t: 15, to: 'afterrun' }, { t: 20, to: 'idle' }, { t: 30, to: 'boost' },
  ];
  assert.deepEqual(chart.spans(log, 10, 40), [
    { state: 'boost', from: 10, to: 15 }, { state: 'afterrun', from: 15, to: 20 }, { state: 'boost', from: 30, to: 40 },
  ]);
});
