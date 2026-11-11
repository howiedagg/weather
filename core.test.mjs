import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, DAY, LOCATIONS, emptySeries, constrainView, zoomView, apparentTemperature, demoSeries, parseForecast, parseHistory, parseObservation, mergeOfficial, availableAt } from './dist/core.mjs';

test('continuous zoom preserves its time anchor and clamps the two-week extent', () => {
  const v = zoomView(100 * HOUR, 24 * HOUR, .5, 94 * HOUR, 0, 300 * HOUR);
  assert.equal(v.span, 12 * HOUR); assert.equal(v.center, 97 * HOUR);
  assert.equal((94 * HOUR - (v.center - v.span / 2)) / v.span, .25);
  assert.deepEqual(constrainView(-10, HOUR / 2, 0, 14 * DAY), { center: HOUR / 2, span: HOUR });
  const end = constrainView(99 * DAY, 8 * DAY, 0, 14 * DAY);
  assert.equal(end.center + end.span / 2, 14 * DAY); assert.equal(end.span, 7 * DAY);
});
test('hourly historical humidity and wind derive apparent temperature without filling missing wind', () => {
  const root = { location: [{ station: { StationID: '466920', StationName: '臺北' }, stationObsTimes: { stationObsTime: [
    { DateTime: '2026-11-10T12:00:00+08:00', weatherElements: { AirTemperature: '28', RelativeHumidity: '70', WindSpeed: '2' } },
    { DateTime: '2026-11-10T13:00:00+08:00', weatherElements: { AirTemperature: '29', RelativeHumidity: '65', WindSpeed: '-99' } }
  ] } }] };
  const result = parseHistory(root, LOCATIONS.taipei);
  assert.equal(result.temp.length, 2); assert.equal(result.humidity[0].v, 70);
  assert.equal(result.feels.length, 1); assert.equal(result.feels[0].estimated, true);
  assert.equal(result.feels[0].v, apparentTemperature(28, 70, 2));
});
test('new and legacy CWA forecast shapes retain actual sampling and weekly ranges', () => {
  const current = { records: { Locations: [{ Location: [{ LocationName: '中正區', WeatherElement: [
    { ElementName: '溫度', Time: [{ DataTime: '2026-11-12T12:00:00+08:00', ElementValue: [{ Temperature: '26' }] }] },
    { ElementName: '體感溫度', Time: [{ DataTime: '2026-11-12T12:00:00+08:00', ElementValue: [{ ApparentTemperature: '28' }] }] },
    { ElementName: '相對濕度', Time: [{ DataTime: '2026-11-12T12:00:00+08:00', ElementValue: [{ RelativeHumidity: '75' }] }] }
  ] }] }] } };
  const parsed = parseForecast(current, '中正區');
  assert.equal(parsed.temp[0].v, 26); assert.equal(parsed.feels[0].v, 28); assert.equal(parsed.humidity[0].v, 75);
  const legacy = { location: { locationName: '中正區', weatherElement: ['MinAT', 'MaxAT', 'RH'].map((elementName, i) => ({ elementName, time: [{ startTime: '2026-11-15 06:00:00', endTime: '2026-11-15 18:00:00', elementValue: [{ value: [21, 29, 70][i] }] }] })) } };
  const weekly = parseForecast(legacy, '中正區', true);
  assert.equal(weekly.feels[0].lo, 21); assert.equal(weekly.feels[0].hi, 29); assert.equal(weekly.feels[0].step, 12 * HOUR);
  assert.equal(weekly.humidity[0].v, 70);
});
test('current observation ignores sentinel missing values and selects the intended station', () => {
  const root = { records: { Station: [
    { StationName: '臺北', StationId: '466920', ObsTime: { DateTime: '2026-11-11T12:00:00+08:00' }, WeatherElement: { AirTemperature: '25', RelativeHumidity: '72', WindSpeed: '1.5' } },
    { StationName: '臺中', StationId: '467490', ObsTime: { DateTime: '2026-11-11T12:00:00+08:00' }, WeatherElement: { AirTemperature: '30', RelativeHumidity: '60', WindSpeed: '2' } }
  ] } };
  const result = parseObservation(root, LOCATIONS.taipei);
  assert.equal(result.temp.length, 1); assert.equal(result.temp[0].v, 25); assert.equal(result.feels.length, 1);
});
test('official merging never manufactures history, or uses a forecast outside its supported interval', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const short = emptySeries(); short.temp.push({ t: now + HOUR, start: now, end: now + 3 * HOUR, step: 3 * HOUR, v: 25, kind: 'forecast' });
  const merged = mergeOfficial(emptySeries(), emptySeries(), short, emptySeries(), now);
  assert.equal(merged.temp.length, 1); assert.equal(merged.feels.length, 0);
  assert.equal(availableAt(merged.temp, now - DAY), null);
  assert.equal(availableAt(merged.temp, now + 2.5 * HOUR).v, 25);
});
test('demo covers both past and future with visibly separate resolutions and valid humidity', () => {
  const now = Date.parse('2026-11-11T16:00:00+08:00'), data = demoSeries(now);
  assert.ok(data.temp.some(p => p.t < now - 6 * DAY)); assert.ok(data.temp.some(p => p.t > now + 6 * DAY));
  assert.ok(data.feels.some(p => p.lo != null && p.hi > p.lo));
  assert.ok(data.humidity.every(p => p.v >= 0 && p.v <= 100));
});
