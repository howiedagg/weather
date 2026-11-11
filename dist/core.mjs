export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const TZ = 'Asia/Taipei';
export const METRICS = ['temp', 'feels', 'humidity'];
export const LOCATIONS = {
  taipei: { county: '臺北市', town: '中正區', station: '臺北', id: '466920', forecast: '061', offset: 0 },
  newtaipei: { county: '新北市', town: '板橋區', station: '新北', id: '466881', forecast: '069', offset: -0.5 },
  taichung: { county: '臺中市', town: '西區', station: '臺中', id: '467490', forecast: '073', offset: 1.5 },
  tainan: { county: '臺南市', town: '中西區', station: '臺南', id: '467410', forecast: '077', offset: 2 },
  kaohsiung: { county: '高雄市', town: '楠梓區', station: '高雄', id: '467441', forecast: '065', offset: 2.5 },
  hualien: { county: '花蓮縣', town: '花蓮市', station: '花蓮', id: '466990', forecast: '041', offset: 0.7 }
};
export const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
export const emptySeries = () => ({ temp: [], feels: [], humidity: [] });
export function taipeiDay(t) { return Math.floor((t + 8 * HOUR) / DAY) * DAY - 8 * HOUR; }
export function constrainView(center, span, min, max) {
  span = clamp(span, HOUR, Math.min(7 * DAY, max - min));
  return { center: clamp(center, min + span / 2, max - span / 2), span };
}
export function zoomView(center, span, factor, anchor, min, max) {
  const newSpan = clamp(span * factor, HOUR, 7 * DAY);
  const newCenter = anchor + (center - anchor) * newSpan / span;
  return constrainView(newCenter, newSpan, min, max);
}
export function apparentTemperature(temp, humidity, wind) {
  if (![temp, humidity, wind].every(Number.isFinite) || humidity < 0 || humidity > 100 || wind < 0) return null;
  const vaporPressure = humidity / 100 * 6.105 * Math.exp(17.27 * temp / (237.7 + temp));
  return Math.round((temp + 0.33 * vaporPressure - 0.7 * wind - 4) * 10) / 10;
}
export function nearest(points, t) {
  if (!points.length) return null;
  let low = 0, high = points.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (points[mid].t < t) low = mid + 1; else high = mid; }
  return low > 0 && Math.abs(points[low - 1].t - t) < Math.abs(points[low].t - t) ? points[low - 1] : points[low];
}
export function availableAt(points, t) {
  const p = nearest(points, t);
  if (!p) return null;
  if (p.start != null && t >= p.start && t <= p.end) return p;
  return Math.abs(p.t - t) <= Math.max(HOUR, (p.step || HOUR) * .6) ? p : null;
}
export function cleanSeries(series) {
  for (const key of METRICS) {
    const points = new Map();
    for (const p of series[key]) if (Number.isFinite(p.t) && Number.isFinite(p.v)) points.set(p.t, p);
    series[key] = [...points.values()].sort((a, b) => a.t - b.t);
  }
  return series;
}
export function demoSeries(now, location = 'taipei') {
  const series = emptySeries(), min = now - 7 * DAY, max = now + 7 * DAY;
  const offset = LOCATIONS[location]?.offset || 0;
  const model = t => {
    const h = ((t / HOUR + 8) % 24 + 24) % 24, d = (t - taipeiDay(now)) / DAY;
    const temp = 23.1 + offset + 2.7 * Math.cos((h - 14) / 24 * Math.PI * 2) + 1.7 * Math.sin(d * .8 + 1.1) + .4 * Math.sin(d * 2.1 + h * .3);
    const humidity = clamp(72 - 12 * Math.cos((h - 14) / 24 * Math.PI * 2) + 5 * Math.sin(d * .9), 45, 94);
    return { temp, humidity, feels: apparentTemperature(temp, humidity, 1.5 + .6 * Math.cos(d)) };
  };
  const push = (t, kind, step, range = false) => {
    const values = model(t);
    for (const key of METRICS) {
      const p = { t, v: values[key], kind, step, estimated: key === 'feels' && kind === 'observed' };
      if (range) {
        p.start = t - step / 2; p.end = t + step / 2;
        if (key !== 'humidity') { const samples = Array.from({ length: 13 }, (_, i) => model(p.start + i * HOUR)[key]); p.lo = Math.min(...samples); p.hi = Math.max(...samples); p.v = (p.lo + p.hi) / 2; }
      }
      series[key].push(p);
    }
  };
  for (let t = Math.ceil(min / HOUR) * HOUR; t <= now; t += HOUR) push(t, 'observed', HOUR);
  for (let t = Math.ceil(now / (3 * HOUR)) * 3 * HOUR; t <= now + 3 * DAY; t += 3 * HOUR) push(t, 'forecast', 3 * HOUR);
  for (let start = Math.ceil((now + 3 * DAY) / (12 * HOUR)) * 12 * HOUR; start < max; start += 12 * HOUR) push(start + 6 * HOUR, 'forecast', 12 * HOUR, true);
  return cleanSeries(series);
}

const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const norm = text => String(text || '').replaceAll('台', '臺').replaceAll(/[\s_-]/g, '').toLowerCase();
function pick(obj, ...keys) { if (!obj || typeof obj !== 'object') return undefined; for (const k of keys) if (obj[k] != null) return obj[k]; return undefined; }
export function numeric(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'object') value = pick(value, 'value', 'Value', '#text');
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value); return Number.isFinite(n) && n > -90 ? n : null;
}
export function findNodes(root, predicate) {
  const result = [], visit = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (predicate(obj)) { result.push(obj); return; }
    for (const value of Object.values(obj)) if (typeof value === 'object') { if (Array.isArray(value)) value.forEach(visit); else visit(value); }
  };
  visit(root); return result;
}
function parseTime(value) {
  if (!value) return NaN;
  if (typeof value === 'object') value = pick(value, 'DateTime', 'dataTime', 'DataTime', 'value');
  const s = String(value).trim().replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(s) ? s : s + '+08:00');
}
export function parseForecast(root, town, weekly = false) {
  const result = emptySeries();
  const locations = findNodes(root, o => norm(pick(o, 'LocationName', 'locationName')) === norm(town) && !!pick(o, 'WeatherElement', 'weatherElement'));
  for (const location of locations) {
    const grouped = new Map();
    for (const element of list(pick(location, 'WeatherElement', 'weatherElement'))) {
      const name = norm(pick(element, 'ElementName', 'elementName'));
      const aliases = {
        temp: ['溫度', '平均溫度', 't'], feels: ['體感溫度', 'at'], humidity: ['相對濕度', '平均相對濕度', 'rh'],
        tempLo: ['最低溫度', 'mint'], tempHi: ['最高溫度', 'maxt'], feelsLo: ['最低體感溫度', 'minat'], feelsHi: ['最高體感溫度', 'maxat']
      };
      const metric = Object.entries(aliases).find(([, names]) => names.includes(name))?.[0];
      if (!metric) continue;
      for (const time of list(pick(element, 'Time', 'time'))) {
        const start = parseTime(pick(time, 'DataTime', 'dataTime', 'StartTime', 'startTime'));
        const end = parseTime(pick(time, 'EndTime', 'endTime'));
        if (!Number.isFinite(start)) continue;
        const valueObject = list(pick(time, 'ElementValue', 'elementValue'))[0];
        let value = numeric(valueObject);
        if (value == null && valueObject && typeof valueObject === 'object') {
          const candidate = Object.values(valueObject).map(numeric).find(v => v != null);
          value = candidate ?? null;
        }
        if (value == null || (metric === 'humidity' && (value < 0 || value > 100))) continue;
        const key = `${start}:${Number.isFinite(end) ? end : start}`;
        const item = grouped.get(key) || { start, end: Number.isFinite(end) ? end : start, values: {} };
        item.values[metric] = value; grouped.set(key, item);
      }
    }
    for (const { start, end, values } of grouped.values()) {
      for (const metric of METRICS) {
        const lo = values[metric + 'Lo'], hi = values[metric + 'Hi'];
        let v = values[metric];
        if (v == null && lo != null && hi != null) v = (lo + hi) / 2;
        if (v == null) continue;
        const step = end > start ? end - start : (weekly ? 12 : 3) * HOUR;
        const p = { t: end > start ? (start + end) / 2 : start, start, end: end > start ? end : start + step, v, kind: 'forecast', step };
        if (lo != null && hi != null) { p.lo = lo; p.hi = hi; }
        result[metric].push(p);
      }
    }
  }
  return cleanSeries(result);
}
function addObservation(result, t, values) {
  if (!Number.isFinite(t)) return;
  const temp = numeric(pick(values, 'AirTemperature', 'Temperature', 'TEMP', 'temperature'));
  let humidity = numeric(pick(values, 'RelativeHumidity', 'HUMD', 'relativeHumidity'));
  if (humidity != null && humidity > 0 && humidity <= 1 && values.HUMD != null) humidity *= 100;
  const wind = numeric(pick(values, 'WindSpeed', 'WDSD', 'windSpeed'));
  if (temp != null) result.temp.push({ t, v: temp, kind: 'observed', step: HOUR });
  if (humidity != null && humidity >= 0 && humidity <= 100) result.humidity.push({ t, v: humidity, kind: 'observed', step: HOUR });
  const feels = temp != null && humidity != null && wind != null ? apparentTemperature(temp, humidity, wind) : null;
  if (feels != null) result.feels.push({ t, v: feels, kind: 'observed', estimated: true, step: HOUR });
}
export function parseObservation(root, location) {
  const result = emptySeries();
  const stations = findNodes(root, o => {
    const name = pick(o, 'StationName', 'stationName'), id = pick(o, 'StationId', 'StationID', 'stationId');
    return (String(id) === location.id || norm(name) === norm(location.station)) && !!pick(o, 'WeatherElement', 'weatherElement');
  });
  for (const station of stations) {
    const obs = pick(station, 'ObsTime', 'obsTime');
    addObservation(result, parseTime(obs), pick(station, 'WeatherElement', 'weatherElement'));
  }
  return cleanSeries(result);
}
export function parseHistory(root, location) {
  const result = emptySeries();
  const locations = findNodes(root, o => {
    const station = pick(o, 'station', 'Station');
    return station && (String(pick(station, 'StationID', 'StationId')) === location.id || norm(pick(station, 'StationName')) === norm(location.station)) && !!pick(o, 'stationObsTimes', 'StationObsTimes');
  });
  for (const station of locations) {
    const timesRoot = pick(station, 'stationObsTimes', 'StationObsTimes');
    const times = pick(timesRoot, 'stationObsTime', 'StationObsTime') || timesRoot;
    for (const entry of list(times)) addObservation(result, parseTime(pick(entry, 'DateTime', 'dateTime')), pick(entry, 'weatherElements', 'WeatherElements') || entry);
  }
  return cleanSeries(result);
}
export function mergeOfficial(observations, history, short, long, now) {
  const result = emptySeries();
  for (const metric of METRICS) {
    const shortPoints = short[metric].filter(p => p.end > now);
    const cutoff = shortPoints.length ? Math.max(...shortPoints.map(p => p.end)) : now;
    result[metric] = [
      ...history[metric].filter(p => p.t >= now - 7 * DAY && p.t <= now),
      ...observations[metric].filter(p => p.t <= now + 10 * 60000),
      ...shortPoints,
      ...long[metric].filter(p => p.start >= cutoff && p.start < now + 7 * DAY)
    ];
  }
  return cleanSeries(result);
}
