import { HOUR, DAY, TZ, METRICS, LOCATIONS, clamp, emptySeries, taipeiDay, constrainView, zoomView, availableAt, demoSeries, parseForecast, parseObservation, parseHistory, mergeOfficial } from './core.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let now = Date.now();
const limits = { min: now - 7 * DAY, max: now + 7 * DAY };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const colors = { temp: '#da975e', feels: '#a79ac5', humidity: '#82a7c5' };
const labels = { temp: '溫度', feels: '體感', humidity: '濕度' };
let safeLocation = 'taipei';
try { safeLocation = localStorage.getItem('weather-flow-location') || 'taipei'; } catch {}
if (!LOCATIONS[safeLocation]) safeLocation = 'taipei';
const state = {
  location: safeLocation, mode: 'demo', series: demoSeries(now, safeLocation),
  view: { center: taipeiDay(now) + 12 * HOUR, span: DAY }, target: { center: taipeiDay(now) + 12 * HOUR, span: DAY },
  visible: { temp: true, feels: true, humidity: true }, hover: null, gesture: null, navGesture: null,
  key: '', controller: null, busy: false, requestId: 0, yMin: 16, yMax: 32, frame: null, lastFrame: 0, motion: null, detail: ''
};
const chart = $('#weather-chart'), ctx = chart.getContext('2d'), nav = $('#navigator-chart'), nctx = nav.getContext('2d');
const chartWrap = $('#chart-wrap'), tooltip = $('#chart-tooltip');
let size = { w: 960, h: 368 }, navSize = { w: 900, h: 52 };
let toastTimer;
const fmt = (t, options) => new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, ...options }).format(t);
const shortDate = t => fmt(t, { month: '2-digit', day: '2-digit' });
const clock = t => fmt(t, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const number = value => value == null ? '—' : String(Math.round(value));
const leftEdge = () => size.w < 500 ? 41 : 53;
const rightEdge = () => size.w - (size.w < 500 ? 20 : 31);
const plotWidth = () => rightEdge() - leftEdge();
const timestampAt = x => state.view.center - state.view.span / 2 + clamp((x - leftEdge()) / plotWidth(), 0, 1) * state.view.span;
const xAt = t => leftEdge() + (t - (state.view.center - state.view.span / 2)) / state.view.span * plotWidth();

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200);
}
function dismissHint() { $('#gesture-hint').classList.add('dismissed'); }
function setView(center, span, animate = true) {
  const view = constrainView(center, span, limits.min, limits.max);
  state.target = view;
  if (!animate || reducedMotion) { state.motion = null; state.view = { ...view }; }
  else state.motion = { from: { ...state.view }, start: performance.now(), duration: 280 };
  state.hover = null; tooltip.hidden = true;
  dismissHint(); requestDraw();
}
function zoom(factor, anchor = state.target.center) {
  const v = zoomView(state.target.center, state.target.span, factor, anchor, limits.min, limits.max);
  setView(v.center, v.span);
}
function changePeriod(period) {
  if (period === 'today') setView(taipeiDay(now) + 12 * HOUR, DAY);
  if (period === 'three') setView(now + 1.5 * DAY, 3 * DAY);
  if (period === 'week') setView(now + 3.5 * DAY, 7 * DAY);
  if (period === 'past') setView(now - 3.5 * DAY, 7 * DAY);
}

function setCanvasSize(canvas, context, dimensions) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 3);
  dimensions.w = rect.width; dimensions.h = rect.height;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resize() { setCanvasSize(chart, ctx, size); setCanvasSize(nav, nctx, navSize); requestDraw(); }
new ResizeObserver(resize).observe(chartWrap);
new ResizeObserver(resize).observe($('#navigator'));

function requestDraw() { if (state.frame == null) state.frame = requestAnimationFrame(frame); }
function frame(time) {
  state.frame = null;
  const dt = state.lastFrame ? time - state.lastFrame : 16;
  state.lastFrame = time;
  const a = reducedMotion ? 1 : 1 - Math.exp(-dt / 58);
  if (state.motion) {
    const progress = clamp((time - state.motion.start) / state.motion.duration, 0, 1), eased = 1 - (1 - progress) ** 3;
    state.view.center = state.motion.from.center + (state.target.center - state.motion.from.center) * eased;
    state.view.span = state.motion.from.span + (state.target.span - state.motion.from.span) * eased;
    if (progress >= 1) state.motion = null;
  }
  if (!state.motion) state.view = { ...state.target };
  const yAnimating = drawChart(a);
  drawNavigator(); updateViewUI();
  if (state.motion || yAnimating) requestDraw(); else state.lastFrame = 0;
}
function text(context, value, x, y, color = '#a2abb5', align = 'left', font = '11px "DM Sans", "Noto Sans TC", sans-serif') {
  context.fillStyle = color; context.font = font; context.textAlign = align; context.textBaseline = 'middle'; context.fillText(value, x, y);
}
function line(context, x1, y1, x2, y2, color, dash = []) {
  context.save(); context.beginPath(); context.setLineDash(dash); context.strokeStyle = color; context.lineWidth = 1; context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); context.restore();
}
function relevant(points, start, end) {
  const visible = points.filter(p => p.t >= start && p.t <= end);
  const before = points.findLast(p => p.t < start), after = points.find(p => p.t > end);
  if (before) visible.unshift(before); if (after) visible.push(after);
  return visible;
}
function segments(points) {
  const groups = []; let group = [];
  for (const point of points) {
    const previous = group.at(-1);
    if (previous && (point.kind !== previous.kind || point.t - previous.t > 1.7 * Math.max(point.step || HOUR, previous.step || HOUR))) {
      groups.push(group); group = [];
      if (point.kind !== previous.kind && point.t - previous.t < 4 * HOUR) group.push(previous);
    }
    group.push(point);
  }
  if (group.length) groups.push(group); return groups;
}
function drawSeries(context, points, key, x, y, baseline, showDots = false) {
  if (!points.length || !state.visible[key]) return;
  for (const group of segments(points)) {
    const forecast = group.at(-1).kind === 'forecast';
    const ranges = group.filter(p => p.lo != null && p.hi != null);
    if (ranges.length) {
      context.save(); context.fillStyle = key === 'feels' ? '#a79ac514' : '#da975e13';
      context.beginPath();
      ranges.forEach((p, i) => { const px = x(p.start ?? p.t), py = y(p.hi); if (!i) context.moveTo(px, py); else context.lineTo(px, py); context.lineTo(x(p.end ?? p.t), py); });
      [...ranges].reverse().forEach(p => { context.lineTo(x(p.end ?? p.t), y(p.lo)); context.lineTo(x(p.start ?? p.t), y(p.lo)); });
      context.closePath(); context.fill(); context.restore();
    }
    if (group.length > 1 && key === 'temp') {
      const gradient = context.createLinearGradient(0, baseline - 180, 0, baseline); gradient.addColorStop(0, '#e9b18410'); gradient.addColorStop(1, '#e9b18400');
      context.beginPath(); context.moveTo(x(group[0].t), baseline); group.forEach(p => context.lineTo(x(p.t), y(p.v))); context.lineTo(x(group.at(-1).t), baseline); context.closePath(); context.fillStyle = gradient; context.fill();
    }
    if (group.length > 1 && key === 'humidity') {
      const gradient = context.createLinearGradient(0, baseline - 80, 0, baseline); gradient.addColorStop(0, '#91b6d223'); gradient.addColorStop(1, '#91b6d204');
      context.beginPath(); context.moveTo(x(group[0].t), baseline); group.forEach(p => context.lineTo(x(p.t), y(p.v))); context.lineTo(x(group.at(-1).t), baseline); context.closePath(); context.fillStyle = gradient; context.fill();
    }
    context.save(); context.strokeStyle = colors[key]; context.lineWidth = key === 'humidity' ? 1.7 : 2.1; context.lineCap = 'round'; context.lineJoin = 'round'; context.setLineDash(forecast ? [4, 5] : []);
    context.beginPath(); group.forEach((p, i) => i ? context.lineTo(x(p.t), y(p.v)) : context.moveTo(x(p.t), y(p.v))); context.stroke(); context.restore();
    if (showDots || group.length === 1) for (const p of group) {
      context.beginPath(); context.arc(x(p.t), y(p.v), 2.3, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = colors[key]; context.lineWidth = 1.5; context.stroke();
    }
  }
}
function drawChart(a) {
  const { w, h } = size, l = leftEdge(), r = rightEdge(), start = state.view.center - state.view.span / 2, end = start + state.view.span;
  const top = 26, bottom = h - 148, humidityTop = h - 101, humidityBottom = h - 45;
  ctx.clearRect(0, 0, w, h);
  const inWindow = METRICS.flatMap(k => k !== 'humidity' && state.visible[k] ? state.series[k].filter(p => p.t >= start && p.t <= end).flatMap(p => [p.lo ?? p.v, p.hi ?? p.v]) : []);
  const interval = inWindow.length && Math.max(...inWindow) - Math.min(...inWindow) > 16 ? 5 : 2;
  const targetMin = inWindow.length ? Math.floor((Math.min(...inWindow) - 1.5) / interval) * interval : 16;
  const targetMax = inWindow.length ? Math.ceil((Math.max(...inWindow) + 1.5) / interval) * interval : 32;
  state.yMin += (targetMin - state.yMin) * a; state.yMax += (targetMax - state.yMax) * a;
  const y = v => bottom - (v - state.yMin) / (state.yMax - state.yMin) * (bottom - top);
  const hy = v => humidityBottom - v / 100 * (humidityBottom - humidityTop);
  ctx.save(); ctx.beginPath(); ctx.rect(l, 0, r - l, h); ctx.clip();
  if (state.view.span <= 3.5 * DAY) {
    ctx.fillStyle = '#f7f9fb';
    for (let day = taipeiDay(start) - DAY; day < end; day += DAY) {
      const x0 = xAt(day + 18 * HOUR), x1 = xAt(day + 30 * HOUR); ctx.fillRect(x0, 12, x1 - x0, bottom - 5); ctx.fillRect(x0, humidityTop - 3, x1 - x0, humidityBottom - humidityTop + 3);
    }
  }
  ctx.restore();
  for (let i = 0; i <= 3; i++) {
    const py = top + i * (bottom - top) / 3, v = state.yMax - i * (state.yMax - state.yMin) / 3;
    line(ctx, l, py, r, py, '#eef1f4'); text(ctx, Math.round(v) + '°', l - 13, py, '#a8b0b9', 'right');
  }
  line(ctx, l, humidityTop - 20, r, humidityTop - 20, '#eef1f4');
  ctx.beginPath(); ctx.arc(l + 3, humidityTop - 9, 2.4, 0, Math.PI * 2); ctx.fillStyle = colors.humidity; ctx.fill();
  text(ctx, '濕度', l + 13, humidityTop - 9, '#8b98a6', 'left', '10px "Noto Sans TC",sans-serif');
  text(ctx, '%', r, humidityTop - 9, '#a8b1ba', 'right');
  for (const v of [30, 60, 90]) { line(ctx, l, hy(v), r, hy(v), '#f3f5f7'); text(ctx, String(v), l - 13, hy(v), '#b1bac3', 'right', '10px "DM Sans",sans-serif'); }
  const possibleSteps = [HOUR / 4, HOUR / 2, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];
  const tickStep = possibleSteps.find(v => state.view.span / v <= (w < 500 ? 4.2 : 7)) || 2 * DAY;
  const offset = 8 * HOUR;
  for (let t = Math.ceil((start + offset) / tickStep) * tickStep - offset; t <= end; t += tickStep) {
    const px = xAt(t); if (px < l + 8 || px > r - 8) continue;
    const isMidnight = (t + offset) % DAY === 0;
    const label = state.view.span >= 3.5 * DAY ? fmt(t, { month: 'numeric', day: 'numeric' }) : isMidnight ? fmt(t, { month: 'numeric', day: 'numeric' }) : clock(t);
    text(ctx, label, px, h - 21, isMidnight ? '#7e8fa0' : '#a0acb8', 'center', '10px "DM Sans",sans-serif');
  }
  ctx.save(); ctx.beginPath(); ctx.rect(l, 12, r - l, h - 49); ctx.clip();
  drawSeries(ctx, relevant(state.series.temp, start, end), 'temp', xAt, y, bottom, state.view.span <= 8 * HOUR);
  drawSeries(ctx, relevant(state.series.feels, start, end), 'feels', xAt, y, bottom, state.view.span <= 8 * HOUR);
  drawSeries(ctx, relevant(state.series.humidity, start, end), 'humidity', xAt, hy, humidityBottom, state.view.span <= 8 * HOUR);
  ctx.restore();
  const nx = xAt(now);
  if (nx > l && nx < r) {
    line(ctx, nx, 19, nx, humidityBottom + 3, '#bcc7d1', [2, 4]);
    ctx.fillStyle = '#fff'; ctx.fillRect(nx - 15, 0, 30, 17); text(ctx, '現在', nx, 9, '#94a0ad', 'center', '9px "Noto Sans TC",sans-serif');
    for (const key of METRICS) {
      if (!state.visible[key]) continue;
      const point = availableAt(state.series[key], now); if (!point || Math.abs(point.t - now) > HOUR) continue;
      const py = key === 'humidity' ? hy(point.v) : y(point.v);
      ctx.beginPath(); ctx.arc(xAt(point.t), py, 5, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.beginPath(); ctx.arc(xAt(point.t), py, 2.5, 0, 2 * Math.PI); ctx.fillStyle = colors[key]; ctx.fill();
    }
  }
  if (state.hover != null && !state.gesture) {
    const px = xAt(state.hover); line(ctx, px, 19, px, humidityBottom + 3, '#8796a740');
    for (const key of METRICS) {
      if (!state.visible[key]) continue;
      const point = availableAt(state.series[key], state.hover); if (!point) continue;
      const py = key === 'humidity' ? hy(point.v) : y(point.v);
      ctx.beginPath(); ctx.arc(xAt(point.t), py, 3.5, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = colors[key]; ctx.lineWidth = 1.8; ctx.stroke();
    }
  }
  $('#no-data').hidden = METRICS.some(k => state.visible[k] && state.series[k].some(p => (p.end ?? p.t + p.step / 2) >= start && (p.start ?? p.t - p.step / 2) <= end));
  chart.setAttribute('aria-label', `${shortDate(start)} ${clock(start)} 至 ${shortDate(end)} ${clock(end)}，${state.mode === 'demo' ? '示範' : '氣象署'}溫度、體感及濕度趨勢`);
  return Math.abs(state.yMin - targetMin) > .03 || Math.abs(state.yMax - targetMax) > .03;
}
function drawNavigator() {
  const { w, h } = navSize; nctx.clearRect(0, 0, w, h);
  const all = state.series.temp;
  if (all.length) {
    const min = Math.min(...all.map(p => p.lo ?? p.v)) - 1, max = Math.max(...all.map(p => p.hi ?? p.v)) + 1;
    const x = t => (t - limits.min) / (limits.max - limits.min) * w, y = v => h - 8 - (v - min) / (max - min) * (h - 16);
    const gradient = nctx.createLinearGradient(0, 0, 0, h); gradient.addColorStop(0, '#d8dfe57a'); gradient.addColorStop(1, '#e7ecf115');
    for (const group of segments(all)) {
      nctx.beginPath(); nctx.moveTo(x(group[0].t), h); group.forEach(p => nctx.lineTo(x(p.t), y(p.v))); nctx.lineTo(x(group.at(-1).t), h); nctx.closePath(); nctx.fillStyle = gradient; nctx.fill();
      nctx.beginPath(); group.forEach((p, i) => i ? nctx.lineTo(x(p.t), y(p.v)) : nctx.moveTo(x(p.t), y(p.v))); nctx.strokeStyle = '#bac8d4'; nctx.lineWidth = 1.2; nctx.stroke();
    }
    line(nctx, x(now), 5, x(now), h - 5, '#bbc7d4', [2, 3]);
  }
  const start = state.view.center - state.view.span / 2;
  $('#navigator-window').style.left = `${(start - limits.min) / (limits.max - limits.min) * 100}%`;
  $('#navigator-window').style.width = `${state.view.span / (limits.max - limits.min) * 100}%`;
}
function updateViewUI() {
  const { center, span } = state.view, start = center - span / 2, end = center + span / 2;
  $('#range-label').textContent = taipeiDay(start) === taipeiDay(end - 1) ? `${shortDate(start)} · ${fmt(start, { weekday: 'short' })}` : `${shortDate(start)} — ${shortDate(end)}`;
  const hours = span / HOUR;
  $('#zoom-label').textContent = hours < 48 ? `${hours < 6 ? Math.round(hours * 10) / 10 : Math.round(hours)} 小時` : `${Math.round(hours / 24 * 10) / 10} 天`;
  $('#zoom-slider').value = Math.round(Math.log(span / HOUR) / Math.log(168) * 1000);
  let active = '';
  if (Math.abs(span - DAY) < 60000 && Math.abs(center - taipeiDay(now) - 12 * HOUR) < 60000) active = 'today';
  if (Math.abs(span - 3 * DAY) < 60000 && Math.abs(start - now) < 60000) active = 'three';
  if (Math.abs(span - 7 * DAY) < 60000) { if (Math.abs(start - now) < 60000) active = 'week'; if (Math.abs(end - now) < 60000) active = 'past'; }
  $$('[data-period]').forEach(b => { const enabled = b.dataset.period === active; b.classList.toggle('active', enabled); b.setAttribute('aria-pressed', enabled); });
  $('#previous').disabled = start <= limits.min + 1000;
  $('#next').disabled = end >= limits.max - 1000;
}
function updateCurrent() {
  const points = Object.fromEntries(METRICS.map(k => [k, availableAt(state.series[k], now)]));
  $('#current-temp').textContent = number(points.temp?.v);
  $('#current-feels').textContent = points.feels?.lo != null ? `${number(points.feels.lo)}–${number(points.feels.hi)}` : number(points.feels?.v);
  $('#current-humidity').textContent = number(points.humidity?.v);
  $('#today-date').textContent = fmt(now, { month: 'long', day: 'numeric', weekday: 'short' });
  const t = points.temp?.t;
  $('#current-time').textContent = t ? `${clock(t)} ${points.temp.kind === 'forecast' ? '預報' : '觀測'}` : '尚無目前資料';
  $('#current-kind').textContent = state.mode === 'demo' ? '示範' : points.temp?.kind === 'forecast' ? '預報' : '官方';
  $('#feel-note').textContent = points.feels ? (points.feels.estimated ? '估算體感' : '官方預報') : '尚無資料';
  $('#humidity-note').textContent = points.humidity?.kind === 'forecast' ? '預報相對濕度' : '相對濕度';
  $('#status-label').textContent = state.busy ? '連接中' : state.mode === 'demo' ? '示範資料' : '氣象署資料';
  $('#data-status').classList.toggle('live', state.mode === 'live'); $('#data-status').classList.toggle('loading', state.busy);
  $('#data-note').textContent = state.mode === 'demo' ? '示範走勢 · 非即時氣象' : `中央氣象署 · ${LOCATIONS[state.location].station}站 / ${LOCATIONS[state.location].town}`;
  $('#source-detail').textContent = state.mode === 'demo' ? '目前為合成示範資料，所有數字皆非真實觀測或預報。' : state.detail;
}
function showTooltip(x, y) {
  const time = timestampAt(x), points = METRICS.map(k => ({ key: k, p: state.visible[k] ? availableAt(state.series[k], time) : null })).filter(o => o.p);
  if (!points.length) { tooltip.hidden = true; state.hover = null; requestDraw(); return; }
  state.hover = time;
  const closest = points.reduce((a, b) => Math.abs(a.p.t - time) < Math.abs(b.p.t - time) ? a : b).p;
  const title = closest.end > closest.start && closest.step >= 6 * HOUR ? `${shortDate(closest.start)} ${clock(closest.start)}–${clock(closest.end)}` : `${shortDate(closest.t)} ${clock(closest.t)}`;
  const estimated = points.some(o => o.p.estimated), kinds = [...new Set(points.map(o => o.p.kind === 'forecast' ? '預報' : '觀測'))].join(' / ');
  tooltip.innerHTML = `<div class="tooltip-title">${title}</div>${points.map(({ key, p }) => `<div class="tooltip-row"><i style="background:${colors[key]}"></i><span>${labels[key]}</span><b>${p.lo != null ? `${number(p.lo)}–${number(p.hi)}` : number(p.v)}${key === 'humidity' ? '%' : '°'}</b></div>`).join('')}<div class="tooltip-note">${state.mode === 'demo' ? '示範 · ' : ''}${kinds}${estimated ? ' · 體感估算' : ''}${closest.step >= 6 * HOUR ? ' · 時段資料' : ''}</div>`;
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.left = `${clamp(x + 16, 9, size.w - tw - 9)}px`;
  tooltip.style.top = `${clamp(y - th - 14, 19, size.h - th - 26)}px`;
  requestDraw();
}

// Pointer gestures use a horizontal intent threshold so a one-finger page scroll still works.
const pointers = new Map();
chartWrap.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (state.frame != null) { state.view = { ...state.target }; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  chartWrap.setPointerCapture(e.pointerId);
  if (pointers.size === 1) {
    state.gesture = { startX: e.clientX, startY: e.clientY, center: state.view.center, span: state.view.span, moved: false, type: e.pointerType };
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()], rect = chartWrap.getBoundingClientRect();
    state.gesture = { pinch: true, distance: Math.hypot(p2.x - p1.x, p2.y - p1.y), span: state.view.span, anchor: timestampAt((p1.x + p2.x) / 2 - rect.left), moved: true };
  }
});
chartWrap.addEventListener('pointermove', e => {
  const rect = chartWrap.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') showTooltip(x, y); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = state.gesture; if (!g) return;
  if (g.pinch && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()], distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const span = clamp(g.span * g.distance / Math.max(distance, 12), HOUR, 7 * DAY);
    const fraction = clamp(((p1.x + p2.x) / 2 - rect.left - leftEdge()) / plotWidth(), 0, 1);
    setView(g.anchor + (.5 - fraction) * span, span, false); return;
  }
  if (g.pinch) return;
  const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
  if (!g.moved && Math.abs(dx) + Math.abs(dy) > 6) {
    if (g.type === 'touch' && Math.abs(dy) > Math.abs(dx) * 1.4) { pointers.clear(); state.gesture = null; return; }
    g.moved = true; chartWrap.classList.add('dragging');
  }
  if (g.moved) { setView(g.center - dx / plotWidth() * g.span, g.span, false); }
});
function pointerEnd(e) {
  const g = state.gesture; pointers.delete(e.pointerId);
  if (!pointers.size) {
    state.gesture = null; chartWrap.classList.remove('dragging');
    if (g && !g.moved) { const rect = chartWrap.getBoundingClientRect(); showTooltip(e.clientX - rect.left, e.clientY - rect.top); }
  } else if (pointers.size === 1) {
    const p = [...pointers.values()][0]; state.gesture = { startX: p.x, startY: p.y, center: state.view.center, span: state.view.span, moved: true, type: e.pointerType };
  }
  requestDraw();
}
chartWrap.addEventListener('pointerup', pointerEnd); chartWrap.addEventListener('pointercancel', pointerEnd);
chartWrap.addEventListener('pointerleave', () => { if (!pointers.size) { tooltip.hidden = true; state.hover = null; requestDraw(); } });
chartWrap.addEventListener('wheel', e => {
  e.preventDefault(); dismissHint();
  const rect = chartWrap.getBoundingClientRect();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) setView(state.target.center + (e.shiftKey ? e.deltaY : e.deltaX) / plotWidth() * state.target.span, state.target.span);
  else zoom(Math.exp(clamp(e.deltaY, -120, 120) * .0025), timestampAt(e.clientX - rect.left));
}, { passive: false });
chartWrap.addEventListener('dblclick', e => { const rect = chartWrap.getBoundingClientRect(); setView(timestampAt(e.clientX - rect.left), state.target.span / 2); });
chartWrap.addEventListener('keydown', e => {
  if (['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) e.preventDefault();
  if (e.key === '+' || e.key === '=') zoom(.7);
  if (e.key === '-') zoom(1 / .7);
  if (e.key === 'ArrowLeft') setView(state.target.center - state.target.span / 4, state.target.span);
  if (e.key === 'ArrowRight') setView(state.target.center + state.target.span / 4, state.target.span);
  if (e.key === 'Home') setView(now, state.target.span);
});
const navigator = $('#navigator');
navigator.addEventListener('pointerdown', e => {
  const rect = navigator.getBoundingClientRect(), x = e.clientX - rect.left;
  const mode = e.target.id === 'nav-left' ? 'left' : e.target.id === 'nav-right' ? 'right' : e.target.closest('#navigator-window') ? 'move' : 'jump';
  if (mode === 'jump') { setView(limits.min + x / rect.width * (limits.max - limits.min), state.target.span); return; }
  state.navGesture = { x: e.clientX, center: state.target.center, span: state.target.span, mode, width: rect.width };
  navigator.setPointerCapture(e.pointerId); dismissHint();
});
navigator.addEventListener('pointermove', e => {
  const g = state.navGesture; if (!g) return;
  const dt = (e.clientX - g.x) / g.width * (limits.max - limits.min);
  if (g.mode === 'move') setView(g.center + dt, g.span, false);
  else if (g.mode === 'left') { const end = g.center + g.span / 2; const start = clamp(g.center - g.span / 2 + dt, Math.max(limits.min, end - 7 * DAY), end - HOUR); setView((start + end) / 2, end - start, false); }
  else { const start = g.center - g.span / 2; const end = clamp(g.center + g.span / 2 + dt, start + HOUR, Math.min(limits.max, start + 7 * DAY)); setView((start + end) / 2, end - start, false); }
});
const stopNav = () => { state.navGesture = null; };
navigator.addEventListener('pointerup', stopNav); navigator.addEventListener('pointercancel', stopNav);
for (const side of ['left', 'right']) $(`#nav-${side}`).addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); const delta = (e.key === 'ArrowLeft' ? -1 : 1) * HOUR;
  const start = state.target.center - state.target.span / 2, end = state.target.center + state.target.span / 2;
  if (side === 'left') { const s = clamp(start + delta, Math.max(limits.min, end - 7 * DAY), end - HOUR); setView((s + end) / 2, end - s); }
  else { const t = clamp(end + delta, start + HOUR, Math.min(limits.max, start + 7 * DAY)); setView((start + t) / 2, t - start); }
});

$$('[data-period]').forEach(b => b.addEventListener('click', () => changePeriod(b.dataset.period)));
$('#previous').addEventListener('click', () => setView(state.target.center - state.target.span * .7, state.target.span));
$('#next').addEventListener('click', () => setView(state.target.center + state.target.span * .7, state.target.span));
$('#go-now').addEventListener('click', () => setView(now, state.target.span));
$('#nav-today').addEventListener('click', () => changePeriod('today'));
$('#zoom-in').addEventListener('click', () => zoom(.7)); $('#zoom-out').addEventListener('click', () => zoom(1 / .7));
$('#zoom-slider').addEventListener('input', e => setView(state.target.center, HOUR * 168 ** (Number(e.target.value) / 1000), false));
$$('[data-metric]').forEach(b => b.addEventListener('click', () => {
  const key = b.dataset.metric;
  if (state.visible[key] && !state.visible[key === 'temp' ? 'feels' : 'temp']) { toast('保留至少一條溫度曲線'); return; }
  state.visible[key] = !state.visible[key]; b.setAttribute('aria-pressed', state.visible[key]); requestDraw();
}));
$('#location').value = state.location;
$('#location').addEventListener('change', async e => {
  state.location = e.target.value;
  try { localStorage.setItem('weather-flow-location', state.location); } catch {}
  if (state.mode === 'live' && state.key) await loadOfficial();
  else { state.series = demoSeries(now, state.location); updateCurrent(); requestDraw(); }
});
$('#nav-start').textContent = shortDate(limits.min); $('#nav-end').textContent = shortDate(limits.max);
function openSettings() { $('#settings-dialog').showModal(); }
$('#settings').addEventListener('click', openSettings); $('#data-status').addEventListener('click', openSettings);
$('#info').addEventListener('click', () => $('#info-dialog').showModal());
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));

function xmlToObject(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('資料格式無法讀取');
  const convert = element => {
    if (!element.children.length) return element.textContent.trim();
    const obj = {};
    for (const child of element.children) {
      const name = child.localName, value = convert(child);
      if (obj[name] == null) obj[name] = value; else if (Array.isArray(obj[name])) obj[name].push(value); else obj[name] = [obj[name], value];
    }
    return obj;
  };
  return { [doc.documentElement.localName]: convert(doc.documentElement) };
}
async function fetchOfficial(url, signal) {
  const response = await fetch(url, { signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '授權碼無效或權限不足' : `資料暫時無法讀取（${response.status}）`);
  const content = await response.text();
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = xmlToObject(content); }
  if (parsed.success === 'false' || parsed.success === false) throw new Error('氣象署未回傳可用資料');
  return parsed;
}
async function loadOfficial() {
  now = Date.now(); limits.min = now - 7 * DAY; limits.max = now + 7 * DAY;
  state.controller?.abort();
  const controller = new AbortController(), id = ++state.requestId, place = LOCATIONS[state.location];
  state.controller = controller; state.busy = true; updateCurrent();
  $('#connect').disabled = true; $('#connection-status').textContent = '讀取觀測、歷史與預報…';
  const key = encodeURIComponent(state.key), base = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/';
  const forecastQuery = `?Authorization=${key}&format=JSON&LocationName=${encodeURIComponent(place.town)}`;
  const urls = [
    `${base}O-A0001-001?Authorization=${key}&format=JSON&StationId=${place.id}`,
    `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/C-B0024-001?Authorization=${key}&downloadType=WEB&format=JSON`,
    `${base}F-D0047-${place.forecast}${forecastQuery}`,
    `${base}F-D0047-${String(Number(place.forecast) + 2).padStart(3, '0')}${forecastQuery}`
  ];
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const results = await Promise.allSettled(urls.map(url => fetchOfficial(url, controller.signal)));
    if (id !== state.requestId) return;
    const payload = i => results[i].status === 'fulfilled' ? results[i].value : null;
    const observation = payload(0) ? parseObservation(payload(0), place) : emptySeries();
    const history = payload(1) ? parseHistory(payload(1), place) : emptySeries();
    const short = payload(2) ? parseForecast(payload(2), place.town) : emptySeries();
    const long = payload(3) ? parseForecast(payload(3), place.town, true) : emptySeries();
    let cached = emptySeries();
    try {
      const previous = JSON.parse(localStorage.getItem(`weather-flow-observations-${state.location}`) || 'null');
      if (previous) for (const metric of METRICS) cached[metric] = (previous[metric] || []).filter(p => p.kind === 'observed' && p.t >= now - 7 * DAY && Number.isFinite(p.v));
    } catch {}
    for (const metric of METRICS) history[metric].push(...cached[metric]);
    const merged = mergeOfficial(observation, history, short, long, now);
    if (!METRICS.some(k => merged[k].length)) throw new Error(results.some(r => r.status === 'fulfilled') ? '已收到回應，但沒有找到此地點的資料。請確認授權與資料格式。' : '無法直接讀取官方資料。請確認授權碼、網路，或官方跨網站存取限制。');
    state.mode = 'live'; state.series = merged;
    const missing = [];
    if (!history.temp.length) missing.push('歷史');
    if (!short.temp.length) missing.push('3 天預報');
    if (!long.temp.length) missing.push('一週預報');
    state.detail = `資料：${place.station}氣象站觀測與${place.town}預報。歷史體感採氣溫、相對濕度與風速估算。${missing.length ? `尚缺${missing.join('、')}，缺值保持空白。` : ''}本次讀取：${clock(Date.now())}。`;
    $('#connection-status').textContent = missing.length ? `已連接；尚缺${missing.join('、')}，對應時段會留白。` : '已連接中央氣象署。';
    try {
      const saved = emptySeries();
      for (const metric of METRICS) saved[metric] = merged[metric].filter(p => p.kind === 'observed');
      localStorage.setItem(`weather-flow-observations-${state.location}`, JSON.stringify(saved));
    } catch {}
    $('#settings-dialog').close(); toast(missing.length ? `已連接 · 尚缺${missing.join('、')}` : '已連接中央氣象署');
  } catch (error) {
    if (id !== state.requestId) return;
    $('#connection-status').textContent = error.name === 'AbortError' ? '讀取逾時，請稍後再試。' : error.message;
    // Never keep another location's official data, or silently replace missing official points with synthetic values.
    if (state.mode === 'live') { state.series = emptySeries(); state.detail = '目前地點讀取失敗，未顯示其他地點或示範資料。'; toast('此地點讀取失敗，請至設定重試'); }
  } finally {
    clearTimeout(timeout);
    if (id === state.requestId) { state.busy = false; $('#connect').disabled = false; updateCurrent(); requestDraw(); }
  }
}
$('#settings-form').addEventListener('submit', e => {
  e.preventDefault(); const key = $('#api-key').value.trim();
  if (!key) { $('#connection-status').textContent = '請先輸入授權碼。'; $('#api-key').focus(); return; }
  state.key = key; loadOfficial();
});
$('#use-demo').addEventListener('click', () => {
  state.controller?.abort(); state.requestId++; state.busy = false; state.key = ''; $('#api-key').value = ''; $('#connect').disabled = false; $('#connection-status').textContent = '';
  state.mode = 'demo'; state.series = demoSeries(now, state.location); $('#settings-dialog').close(); updateCurrent(); requestDraw(); toast('已切換示範資料');
});
// Official reads occur only while this page is open and an in-memory user key exists.
setInterval(() => { if (state.mode === 'live' && state.key && !state.busy && document.visibilityState === 'visible') loadOfficial(); }, 30 * 60000);
updateCurrent(); resize();
