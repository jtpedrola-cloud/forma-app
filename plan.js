/* Forma plan builder: turns intake answers into targets and a training program. No AI, no network.
   Shared by the app (window.FormaPlan) and node scripts (require). Uses FormaSmart for maintenance.
   Portable on purpose: the public app will run the same logic on its backend. */
(function (root) {
  const S = root.FormaSmart || (typeof require !== 'undefined' ? require('./smart.js') : null);
  const r10 = v => Math.round(v / 10) * 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- body fat ---------- */
  // Visual scale. Women carry about 8 points more at the same look.
  const BF_LEVELS = [
    { m: 10, f: 18, label: 'Very lean', desc: 'Clear abs and obliques, visible veins on arms and lower belly' },
    { m: 15, f: 23, label: 'Lean', desc: 'Abs show in good light, little fat at the sides' },
    { m: 20, f: 28, label: 'Fit', desc: 'Flat-ish stomach, no abs, a bit soft at the sides' },
    { m: 25, f: 33, label: 'Average', desc: 'Soft belly, love handles, chest not defined' },
    { m: 30, f: 38, label: 'Above average', desc: 'Round belly that sticks out, fuller face' },
    { m: 35, f: 43, label: 'High', desc: 'Large belly, fat carried all over' },
  ];
  // Deurenberg estimate from BMI when the person is not sure.
  function bfFromBMI(sex, age, heightCm, weight) {
    const bmi = weight / Math.pow(heightCm / 100, 2);
    return clamp(Math.round(1.2 * bmi + 0.23 * age - 10.8 * (sex === 'female' ? 0 : 1) - 5.4), 6, 50);
  }

  /* ---------- targets ---------- */
  function suggestRate(goal, bf, experience) {
    if (goal === 'lose') return bf >= 25 ? 0.008 : bf >= 18 ? 0.006 : 0.004;   // share of body weight per week
    if (goal === 'recomp') return bf >= 20 ? 0.004 : 0.002;
    if (goal === 'build') return experience === 'new' || experience === 'under1' ? -0.004 : -0.0025;
    return 0;
  }
  function targets(a) {
    const w = a.weight, sex = a.sex, bf = a.bf;
    const body = { sex, age: a.age, heightCm: a.heightCm };
    const liftDays = (a.trainDays || []).length;
    const steps = a.stepGoal || 10000;
    const base = S.weekFormula(w, bf, body, steps, liftDays) + S.extraKcal(a);
    const rateShare = a.rateShare != null ? a.rateShare : suggestRate(a.goal, bf, a.experience);
    const kgWk = +(w * rateShare).toFixed(2);              // positive = loss, negative = gain
    const floor = sex === 'female' ? 1200 : 1500;
    // Deficit limit: 30% below maintenance at higher body fat, 25% otherwise; never under the floor.
    const maxCut = bf >= (sex === 'female' ? 33 : 25) ? 0.30 : 0.25;
    const kcal = Math.max(floor, r10(base * (1 - maxCut)), r10(base - kgWk * 7700 / 7));
    const kgWkReal = +((base - kcal) * 7 / 7700).toFixed(2);   // the pace these calories actually give
    const lean = w * (1 - bf / 100), refW = Math.min(w, lean / (sex === 'female' ? 0.75 : 0.85));
    const cutting = kgWk > 0;
    const protein = Math.round(clamp(refW * (cutting ? 2.2 : 2.0), w * 1.6, w * 2.2));
    const fat = Math.max(sex === 'female' ? 40 : 45, Math.round(w * (cutting ? 0.6 : 0.8)));
    const carbs = Math.max(80, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { maintenance: Math.round(base), kcal, protein, carbs, fat, kgWk: kgWkReal, kgWkPlanned: kgWk, capped: kgWkReal < kgWk - 0.01, rateShare, steps, lean: +lean.toFixed(1) };
  }

  /* ---------- equipment ---------- */
  // Equipment someone can tick: barbell, dumbbells, bench, cable, machines, bars (pull-up / dip), bands, kettlebell.
  const PRESETS = {
    gym: ['barbell', 'dumbbells', 'bench', 'cable', 'machines', 'bars', 'bands', 'kettlebell', 'abwheel'],
    home: ['dumbbells', 'bench', 'bars', 'bands'],
    bodyweight: ['bars', 'bands'],
  };
  function needOf(part) {
    const p = part.toLowerCase();
    if (/leg press|machine|ghd|hyperextension|captain|preacher|sissy|crossover|^cable|cable/.test(p)) return /cable|crossover/.test(p) ? 'cable' : 'machines';
    if (/barbell|ez bar|landmine|rack|thick bar|fat grips|wrist roller/.test(p)) return /fat grips|thick bar|wrist roller/.test(p) ? null : 'barbell';
    if (/kettlebell/.test(p)) return 'kettlebell';
    if (/ab wheel/.test(p)) return 'abwheel';
    if (/dumbbell|farmer/.test(p)) return 'dumbbells';
    if (/plate|vest/.test(p)) return 'plates';
    if (/chair/.test(p)) return null;
    if (/bench/.test(p)) return 'bench';
    if (/dip bars|^bar$|bar, towel|^bar\b/.test(p)) return 'bars';
    if (/band/.test(p)) return 'bands';
    return null; // none, mat, box, step, sliders, cones, anchor, towel: always available
  }
  function canDo(eq, have) {
    const h = new Set(have);
    if (h.has('barbell') || h.has('dumbbells')) h.add('plates');
    return String(eq || 'None').split(/\s+or\s+/i).some(alt =>
      alt.split(',').map(s => s.trim()).filter(Boolean).every(part => { const n = needOf(part); return !n || h.has(n); }));
  }

  /* ---------- program ---------- */
  const SLOTS = {
    chestPress: [['bench_press', 'db_bench_press', 'machine_chest_press', 'dips', 'push_up_weighted', 'push_up'], 4, '6-8'],
    chestPress2: [['db_bench_press', 'machine_chest_press', 'bench_press', 'dips', 'push_up_weighted', 'push_up'], 3, '8-10'],
    inclinePress: [['incline_db_press', 'incline_bb_press', 'incline_machine_press', 'db_bench_press', 'push_up'], 3, '8-10'],
    chestFly: [['cable_fly', 'pec_deck', 'db_fly', 'low_to_high_cable_fly'], 3, '12-15'],
    ohp: [['seated_db_shoulder_press', 'overhead_press', 'machine_shoulder_press', 'arnold_press', 'landmine_press', 'pike_push_up'], 3, '8-10'],
    lateral: [['lateral_raise', 'cable_lateral_raise', 'machine_lateral_raise', 'band_lateral_raise'], 3, '12-15'],
    rearDelt: [['face_pull', 'reverse_pec_deck', 'rear_delt_fly', 'band_pull_apart', 'cable_rear_delt_fly'], 3, '15'],
    vPull: [['pull_up', 'lat_pulldown', 'assisted_pull_up', 'single_arm_pulldown', 'inverted_row'], 4, '6-10'],
    vPull2: [['lat_pulldown', 'single_arm_pulldown', 'pull_up', 'assisted_pull_up', 'straight_arm_pulldown', 'inverted_row'], 3, '8-12'],
    hRow: [['barbell_row', 'chest_supported_row', 'seated_cable_row', 'db_row', 'machine_row', 'inverted_row'], 3, '8-10'],
    row2: [['chest_supported_row', 'seated_cable_row', 'db_row', 'machine_row', 'barbell_row', 'inverted_row'], 3, '10-12'],
    biceps: [['barbell_curl', 'db_curl', 'ez_bar_curl', 'cable_curl', 'hammer_curl', 'band_curl'], 3, '10-12'],
    biceps2: [['incline_db_curl', 'hammer_curl', 'rope_hammer_curl', 'preacher_curl', 'db_curl', 'band_curl'], 3, '10-12'],
    triceps: [['rope_pushdown', 'bar_pushdown', 'db_overhead_extension', 'skull_crusher', 'machine_dip', 'dips', 'bench_dip'], 3, '10-12'],
    triceps2: [['overhead_triceps_extension', 'db_overhead_extension', 'skull_crusher', 'rope_pushdown', 'bench_dip'], 3, '10-12'],
    squat: [['squat', 'hack_squat', 'leg_press', 'goblet_squat', 'bulgarian_split_squat', 'bodyweight_squat'], 4, '6-8'],
    quad2: [['leg_press', 'bulgarian_split_squat', 'walking_lunge', 'reverse_lunge', 'goblet_squat', 'step_up', 'split_squat_bw'], 3, '8-12'],
    quadIso: [['leg_extension', 'sissy_squat', 'spanish_squat', 'reverse_nordic'], 3, '12-15'],
    hinge: [['romanian_deadlift', 'db_rdl', 'single_leg_rdl', 'hyperextension_45', 'barbell_glute_bridge', 'glute_bridge'], 3, '8-10'],
    hamCurl: [['lying_leg_curl', 'seated_leg_curl', 'nordic_curl', 'sliding_leg_curl', 'glute_ham_raise'], 3, '10-12'],
    glute: [['hip_thrust', 'barbell_glute_bridge', 'cable_pull_through', 'kettlebell_swing', 'single_leg_rdl', 'glute_bridge'], 3, '8-12'],
    calves: [['standing_calf_raise', 'seated_calf_raise', 'leg_press_calf_raise', 'single_leg_calf_raise', 'calf_raise_bw'], 3, '12-15'],
    abs: [['cable_crunch', 'hanging_leg_raise', 'ab_wheel', 'machine_crunch', 'captains_chair_leg_raise', 'reverse_crunch', 'lying_leg_raise'], 3, '10-15'],
    obliques: [['cable_woodchop', 'pallof_press', 'side_plank', 'russian_twist'], 3, '10-12'],
  };
  const DAYS = {
    fbA: ['Full body A', ['squat', 'chestPress', 'hRow', 'ohp', 'hamCurl', 'abs', 'lateral']],
    fbB: ['Full body B', ['hinge', 'inclinePress', 'vPull', 'lateral', 'biceps', 'triceps', 'abs']],
    fbC: ['Full body C', ['quad2', 'chestPress2', 'row2', 'rearDelt', 'calves', 'abs', 'biceps2']],
    upA: ['Upper A', ['chestPress', 'hRow', 'ohp', 'vPull2', 'lateral', 'triceps', 'biceps']],
    loA: ['Lower A', ['squat', 'hinge', 'quadIso', 'hamCurl', 'calves', 'abs']],
    upB: ['Upper B', ['inclinePress', 'vPull', 'row2', 'chestFly', 'lateral', 'biceps2', 'triceps2']],
    loB: ['Lower B', ['hinge', 'quad2', 'glute', 'hamCurl', 'calves', 'obliques']],
    push: ['Push', ['chestPress', 'inclinePress', 'ohp', 'lateral', 'triceps', 'abs']],
    pull: ['Pull', ['vPull', 'hRow', 'rearDelt', 'biceps', 'biceps2', 'abs']],
    legs: ['Legs', ['squat', 'quad2', 'hinge', 'hamCurl', 'calves', 'abs']],
    pushB: ['Push B', ['inclinePress', 'chestPress2', 'chestFly', 'lateral', 'triceps2', 'abs']],
    pullB: ['Pull B', ['vPull2', 'row2', 'rearDelt', 'biceps2', 'biceps', 'obliques']],
    legsB: ['Legs B', ['hinge', 'squat', 'glute', 'quadIso', 'calves', 'abs']],
  };
  const SPLITS = { 2: ['fbA', 'fbB'], 3: ['fbA', 'fbB', 'fbC'], 4: ['upA', 'loA', 'upB', 'loB'],
    5: ['push', 'pull', 'legs', 'upB', 'loB'], 6: ['push', 'pull', 'legs', 'pushB', 'pullB', 'legsB'] };
  const SPLIT_NAME = { 2: 'Full body, 2 days', 3: 'Full body, 3 days', 4: 'Upper / lower, 4 days',
    5: 'Push, pull, legs + upper / lower, 5 days', 6: 'Push, pull, legs twice, 6 days' };
  const FOCUS = { abs: ['abs', 'obliques'], shoulders: ['lateral', 'ohp', 'rearDelt'], chest: ['chestPress', 'chestPress2', 'inclinePress', 'chestFly'],
    arms: ['biceps', 'biceps2', 'triceps', 'triceps2'], back: ['vPull', 'vPull2', 'hRow', 'row2'], legs: ['squat', 'quad2', 'quadIso', 'hamCurl', 'hinge'], glutes: ['glute', 'hinge'] };
  const PER_SESSION = { 45: 5, 60: 6, 75: 7, 90: 8 };
  // Bodyweight moves are light, so they need more reps to be hard enough.
  const BW_REPS = { push_up: '8-20', pike_push_up: '6-12', inverted_row: '8-15', bodyweight_squat: '15-25', split_squat_bw: '10-15',
    glute_bridge: '12-20', bench_dip: '10-15', calf_raise_bw: '12-20', band_lateral_raise: '15-20', band_curl: '12-20', dips: '6-12', pull_up: '5-10' };
  const MUSCLE_WORDS = { chest: 'chest', delts_front: 'shoulders', delts_side: 'shoulders', delts_rear: 'rear shoulders',
    lats: 'back', upper_back: 'back', biceps: 'biceps', triceps: 'triceps', quads: 'quads', hamstrings: 'hamstrings',
    glutes: 'glutes', calves: 'calves', abs: 'abs', obliques: 'obliques', forearms: 'grip' };

  function program(a, lib) {
    const ex = lib.exercises, have = a.equipment && a.equipment.length ? a.equipment : PRESETS.gym;
    const days = (a.trainDays || []).map(Number).sort((x, y) => x - y).slice(0, 6);
    const n = clamp(days.length, 2, 6), split = SPLITS[n], cap = PER_SESSION[a.minutes] || 6;
    const focus = (a.focus || []).slice(0, 2), beginner = a.experience === 'new';
    const pick = slot => SLOTS[slot][0].find(id => ex[id] && canDo(ex[id].eq, have)) || null;
    const keep = s => focus.some(f => (FOCUS[f] || []).includes(s));
    const out = split.map((key) => {
      const [name, slots0] = DAYS[key];
      const slots = slots0.slice();
      while (slots.length > cap) { const j = slots.map((s, k) => [s, k]).reverse().find(([s, k]) => k >= 3 && !keep(s)); slots.splice(j ? j[1] : slots.length - 1, 1); }
      return [name, slots];
    }).map(x => x);
    // focus extras: abs on up to 4 days, side delts on up to 3, glutes on up to 2, only where there is room
    const EXTRA = { abs: ['abs', 4], shoulders: ['lateral', 3], glutes: ['glute', 2], arms: ['biceps2', 2] };
    focus.forEach(f => { const e = EXTRA[f]; if (!e) return; const [slot, target] = e;
      let count = out.filter(([, sl]) => sl.includes(slot) || (slot === 'abs' && sl.includes('obliques'))).length;
      out.forEach(([nm, sl]) => { if (count >= target || sl.includes(slot) || sl.length >= cap) return; if (slot === 'glute' && !/Lower|Legs|Full/.test(nm)) return; sl.push(slot); count++; }); });
    const days2 = out.map(([name, slots]) => {
      const seen = new Set(), list = [], bumped = new Set();
      const focusOf = s => focus.find(f => (FOCUS[f] || []).includes(s));
      slots.forEach(s => {
        const id = pick(s); if (!id || seen.has(id)) return; seen.add(id);
        let sets = SLOTS[s][1]; if (keep(s) && !bumped.has(focusOf(s))) { sets++; bumped.add(focusOf(s)); } if (beginner) sets = Math.min(sets, 3);
        const bw = !have.includes('barbell') && !have.includes('dumbbells') && !have.includes('machines');
        list.push({ ex: id, sets: clamp(sets, 2, 5), reps: (BW_REPS[id] && (bw || !/dips|pull_up/.test(id))) ? BW_REPS[id] : SLOTS[s][2] });
      });
      const mus = []; list.forEach(e => (ex[e.ex].p || []).forEach(m => { const w = MUSCLE_WORDS[m]; if (w && !mus.includes(w)) mus.push(w); }));
      return { name, focus: mus.slice(0, 5).map((w, k) => k ? w : w[0].toUpperCase() + w.slice(1)).join(', '), exercises: list };
    });
    days2.forEach((d, i) => { d.id = 'p' + (i + 1); });
    const weekdays = {}; for (let d = 0; d < 7; d++) weekdays[String(d)] = 'rest';
    days.forEach((d, i) => { if (days2[i]) weekdays[String(d)] = days2[i].id; });
    return { name: SPLIT_NAME[n], version: a.date || '', summary: 'Built from your setup answers: ' + SPLIT_NAME[n].toLowerCase() +
      (focus.length ? ', extra work for ' + focus.join(' and ') : '') + '. Swap any exercise from the Workout tab.', weekdays, days: days2 };
  }

  const api = { BF_LEVELS, PRESETS, bfFromBMI, suggestRate, targets, canDo, program };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FormaPlan = api;
})(this);
