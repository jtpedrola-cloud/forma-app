/* Forma smart maintenance. Shared by the app (window.FormaSmart) and scripts/checkin.js (require).
   Formula: Mifflin-St Jeor BMR (Katch-McArdle when a body fat estimate exists) + 15% daily life,
   walking 0.000375 kcal per step per kg, lifting 0.05 kcal per kg per minute.
   Adaptive: least-squares weight slope over the last 28 days + average logged intake gives measured
   expenditure (7,700 kcal per kg). It is blended with the formula by a confidence that grows with
   logged days and weigh-in span, so a few noisy days cannot swing the estimate. */
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function bmr(w, bfPct, body) {
    if (bfPct != null) return 370 + 21.6 * w * (1 - bfPct / 100);
    const b = body || {}, h = b.heightCm || 175, a = b.age || 30, sx = b.sex === 'female' ? -161 : 5;
    return 10 * w + 6.25 * h - 5 * a + sx;
  }
  function maint(w, bfPct, body, steps, liftMin) {
    const b = bmr(w, bfPct, body), life = b * 0.15, walk = (steps || 0) * w * 0.000375, lift = (liftMin || 0) * w * 0.05;
    return { w, bmr: b, life, walk, lift, total: b + life + walk + lift };
  }
  function weekFormula(w, bfPct, body, stepGoal, liftDays) {
    return (maint(w, bfPct, body, stepGoal, 60).total * liftDays + maint(w, bfPct, body, stepGoal, 0).total * (7 - liftDays)) / 7;
  }
  /* days: oldest to newest, today excluded: [{ d, kcal, logged, weight }] */
  function smart({ days, formula, targetKcal, goalRate }) {
    let t = null; const trend = [];
    days.forEach((x, i) => { if (x.weight != null) { t = t == null ? x.weight : t + 0.1 * (x.weight - t); trend.push({ i, d: x.d, v: t }); } });
    const ws = days.map((x, i) => ({ i, w: x.weight })).filter(x => x.w != null);
    const span = ws.length ? ws[ws.length - 1].i - ws[0].i : 0;
    let slope = null;
    if (ws.length >= 5 && span >= 10) {
      const n = ws.length, mx = ws.reduce((a, x) => a + x.i, 0) / n, my = ws.reduce((a, x) => a + x.w, 0) / n;
      const sxy = ws.reduce((a, x) => a + (x.i - mx) * (x.w - my), 0), sxx = ws.reduce((a, x) => a + (x.i - mx) ** 2, 0);
      slope = sxx ? sxy / sxx : null;
    }
    const eat = days.filter(x => x.logged && x.kcal >= targetKcal * 0.4).map(x => x.kcal);
    const avgIn = eat.length ? eat.reduce((a, b) => a + b, 0) / eat.length : null;
    let measured = null, conf = 0;
    if (slope != null && avgIn != null && eat.length >= 7) {
      measured = clamp(avgIn - slope * 7700, formula - 800, formula + 800);
      conf = clamp(eat.length / 28, 0, 1) * clamp(span / 21, 0, 1);
    }
    const tdee = measured == null ? formula : conf * measured + (1 - conf) * formula;
    const rate = slope == null ? null : slope * 7;
    const suggested = Math.max(1500, Math.round((tdee - goalRate * 7700 / 7) / 10) * 10);
    let status = 'collecting';
    if (rate != null) status = -rate > goalRate + 0.25 ? 'fast' : -rate < goalRate - 0.25 ? 'slow' : 'on pace';
    return { trend, trendNow: t, rate, avgIn, eatDays: eat.length, weighIns: ws.length, span, measured, conf, formula, tdee, suggested, status };
  }
  /* weekly check-in: move at most 150 kcal toward the suggestion, ignore changes under 50 */
  function nextTarget(current, suggested) {
    const d = clamp(suggested - current, -150, 150);
    return Math.abs(d) < 50 ? current : Math.round((current + d) / 10) * 10;
  }
  const api = { bmr, maint, weekFormula, smart, nextTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FormaSmart = api;
})(this);
