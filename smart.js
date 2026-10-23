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
  /* extra daily burn from work and sports, from the setup answers (profile.intake.answers) */
  const JOB_KCAL = { desk: 0, mixed: 150, feet: 300, physical: 500 };
  function extraKcal(ans) { if (!ans) return 0; return (JOB_KCAL[ans.job] || 0) + (Number(ans.sportPerWeek) || 0) * 350 / 7; }
  /* Simple mode verdict (docs/specs/simple-mode.md). No calories: only the weight trend, the plan's pace and, when there is
     one, the waist. Returns ids and numbers; the words live in app/copy.js (FormaCopy.simple) and verdictText() joins them.
     in: { weights:[{d,kg}], waists:[{d,cm}], goalRate (kg a week, positive loses, negative gains, 0 holds), today, sex, weightKg }
     out: { state, tone, rate (kg a week, negative = losing), weighIns, span, need, waist:{ change, days }|null, palms, goal } */
  const dayN = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
  function verdict({ weights, waists, goalRate, today, sex, weightKg }) {
    const g = Number(goalRate) || 0, goal = g > 0.05 ? 'lose' : g < -0.05 ? 'gain' : 'keep', T = dayN(today);
    const palms = sex === 'male' && weightKg > 80 ? 2 : 1;
    const win = (weights || []).filter((x) => x && x.kg != null && T - dayN(x.d) >= 0 && T - dayN(x.d) < 28).map((x) => ({ x: dayN(x.d), y: x.kg })).sort((a, b) => a.x - b.x);
    const span = win.length ? win[win.length - 1].x - win[0].x : 0;
    const out = { goal, palms, weighIns: win.length, span, rate: null, waist: null, state: 'collecting', tone: 'info', need: 0 };
    if (win.length < 2 || span < 10) { out.need = win.length < 2 ? Math.max(1, 3 - win.length) : 0; out.days = Math.max(1, 10 - span); out.state = win.length < 2 ? 'collecting' : 'collectingDays'; return out; }
    const n = win.length, mx = win.reduce((a, p) => a + p.x, 0) / n, my = win.reduce((a, p) => a + p.y, 0) / n;
    const sxx = win.reduce((a, p) => a + (p.x - mx) ** 2, 0), sxy = win.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const rate = sxx ? (sxy / sxx) * 7 : 0; out.rate = rate;
    const ws = (waists || []).filter((x) => x && x.cm != null && T - dayN(x.d) >= 0 && T - dayN(x.d) < 28).sort((a, b) => dayN(a.d) - dayN(b.d));
    if (ws.length >= 2 && dayN(ws[ws.length - 1].d) - dayN(ws[0].d) >= 7) out.waist = { change: ws[ws.length - 1].cm - ws[0].cm, days: dayN(ws[ws.length - 1].d) - dayN(ws[0].d) };
    const flat = Math.abs(rate) < 0.15, wdown = out.waist && out.waist.change <= -1;
    const set = (state, tone) => { out.state = state; out.tone = tone; return out; };
    if (goal === 'lose') {
      const loss = -rate;
      if (flat && wdown) return set('recomp', 'good');
      if (loss < -0.1) return set('lose_up', 'warn');
      if (Math.abs(loss - g) <= 0.15 || (loss > g && loss <= 1.2 * g)) return set('lose_on', 'good');
      return loss > g ? set('lose_fast', 'warn') : set('lose_slow', 'warn');
    }
    if (goal === 'gain') {
      const gain = rate, want = -g;
      if (gain < -0.1) return set('gain_down', 'warn');
      if (Math.abs(gain - want) <= 0.15) return set('gain_on', 'good');
      return gain > want ? (gain > 1.2 * want ? set('gain_fast', 'warn') : set('gain_on', 'good')) : set('gain_slow', 'warn');
    }
    if (flat && wdown) return set('recomp', 'good');
    if (Math.abs(rate) <= 0.25) return set('keep_steady', 'good');
    return rate < 0 ? set('keep_down', 'warn') : set('keep_up', 'warn');
  }
  /* Plain words for a verdict. c = FormaCopy.simple; opts = { unit: 'kg'|'lb', len: 'cm'|'in' }. */
  function verdictText(v, c, opts) {
    const o = opts || {}, fill = (t, m) => String(t).replace(/\{(\w+)\}/g, (x, k) => (m && m[k] != null ? m[k] : x));
    const kgU = o.unit === 'lb' ? 2.20462 : 1, u = o.unit === 'lb' ? 'lb' : 'kg', fr = (n) => (Math.round(Math.abs(n) * kgU * 10) / 10).toFixed(1);
    const base = c.verdict[v.state] || c.verdict.collecting, protein = fill(v.palms === 2 ? c.protein.two : c.protein.one, {});
    const m = { n: v.need, d: v.days };
    let text = fill(base.text, m), title = fill(base.title, m);
    if (v.waist && v.state === 'recomp') {
      const cm = Math.abs(v.waist.change), val = o.len === 'in' ? (Math.round(cm / 2.54 * 10) / 10) : (Math.round(cm * 10) / 10);
      text = fill(c.waistRecomp, { n: val, u: o.len === 'in' ? 'in' : 'cm' });
    }
    const rate = v.rate == null ? '' : Math.abs(v.rate) < 0.05 ? c.rate.flat : fill(v.rate < 0 ? c.rate.down : c.rate.up, { n: fr(v.rate), u });
    return { title, text, protein: v.state === 'collecting' || v.state === 'collectingDays' ? '' : protein, rate, tone: v.tone, state: v.state };
  }
  const api = { bmr, maint, weekFormula, smart, nextTarget, extraKcal, verdict, verdictText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FormaSmart = api;
})(this);
