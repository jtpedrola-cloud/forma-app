/* Forma command parser (no AI). Portable: no DOM, no fetch, no storage.
 * Browser: window.FormaCmd. Node: module.exports.
 *
 *   parse(line, ctx) -> { actions: [], unknown: [], issues: [] }
 *   ctx = { foods, weightKg, date, lastMealAt, lastMealNo, now?, hUnit? }
 *     hUnit: "ft" when the person thinks in inches, so "waist 36" is read as inches; default "cm"
 *     foods: the parsed data/foods.json ({ foods: [...] }) or its array
 *     lastMealAt: ISO string or ms of the last logged item; now: ms or ISO (default Date.now())
 *   actions:
 *     { k:"weight", kg }
 *     { k:"steps", n, estimated? }  estimated: note when steps came from a walked distance
 *     { k:"measure", site, cm }                     tape measurement: waist, hips, chest, arm, thigh or neck, stored in cm
 *     { k:"sport", kind, min, kcal, assumed?, estimated? }  estimated: note when minutes came from a typical pace ("ran 5k")      assumed: no weightKg given, 80 kg used
 *     { k:"note", text }
 *     { k:"food", meal, items:[{ name, amount, kcal, protein, carbs, fat, foodId, assumed? }] }
 *   unknown: the pieces of the line that were not understood, untouched (nothing is ever guessed).
 *   issues: [{ text, why }] same pieces with a short reason, for the preview card.
 * The app adds id, by:"app" and t when it saves.
 */
(function () {
  'use strict';

  // ---------- constants ----------
  var MET = { basketball: 6.5, badminton: 5.5, volleyball: 4, tennis: 7, pickleball: 4.5, football: 7, running: 9, cycling: 7, swimming: 7, hiking: 6, boxing: 7.8, jiujitsu: 6, muaythai: 7.8, kickboxing: 7.8, judo: 6, wrestling: 6, mma: 7.8, karate: 6, taekwondo: 6, arnis: 6, other: 5 };
  var DEFAULT_KG = 80;

  var SPORT_WORDS = {
    basketball: ['basketball', 'bball', 'basket ball', 'b ball', 'hoops'],
    badminton: ['badminton', 'shuttle'],
    volleyball: ['volleyball', 'vball', 'v ball', 'volley ball', 'volley'],
    tennis: ['tennis'],
    pickleball: ['pickleball', 'pickle ball'],
    football: ['football', 'soccer', 'futsal'],
    running: ['running', 'run', 'ran', 'jog', 'jogging', 'jogged'],
    cycling: ['cycling', 'cycle', 'cycled', 'biking', 'bike', 'biked', 'bicycle'],
    swimming: ['swimming', 'swim', 'swam'],
    hiking: ['hiking', 'hike', 'hiked', 'trek', 'trekking'],
    boxing: ['boxing', 'sparring'],
    jiujitsu: ['brazilian jiu jitsu', 'jiu jitsu', 'jiujitsu', 'jujitsu', 'ju jitsu', 'bjj', 'grappling'],
    muaythai: ['muay thai', 'muaythai', 'thai boxing'],
    kickboxing: ['kickboxing', 'kick boxing'],
    judo: ['judo'],
    wrestling: ['wrestling', 'wrestle', 'wrestled'],
    mma: ['mma', 'mixed martial arts'],
    karate: ['karate'],
    taekwondo: ['taekwondo', 'tkd', 'tae kwon do', 'tae kwondo'],
    arnis: ['arnis', 'eskrima', 'escrima', 'kali'],
    other: ['sport', 'sports']
  };

  var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    // Taglish
    isa: 1, isang: 1, dalawa: 2, dalawang: 2, tatlo: 3, tatlong: 3, apat: 4, lima: 5, limang: 5, anim: 6, pito: 7, pitong: 7, walo: 8, walong: 8, siyam: 9, sampu: 10, sampung: 10 };
  // Taglish words read as their English twin (applied to the line and to food names alike)
  var SYN = { ng: 'of', nang: 'of', tasa: 'cup', tasang: 'cup', baso: 'glass', basong: 'glass', mangkok: 'bowl', piraso: 'piece', pirasong: 'piece', kape: 'coffee', tubig: 'water', gatas: 'milk', hakbang: 'steps', oras: 'hours', minuto: 'minutes', minutos: 'minutes', may: 'with' };
  // phrases that only describe when or how, dropped before parsing
  var NOISE = [['this', 'morning'], ['this', 'afternoon'], ['this', 'evening'], ['tonight'], ['kanina'], ['kaninang', 'umaga'], ['kaninang', 'gabi'], ['ngayong', 'umaga'], ['ngayon'], ['no', 'sugar'], ['without', 'sugar'], ['sugarless'], ['walang', 'asukal'], ['no', 'ice']];

  // unit words (after stemming) -> canonical unit
  var UNITS = {
    g: 'g', gram: 'g', gm: 'g', gr: 'g', grm: 'g',
    kg: 'kg', kilo: 'kg', kilogram: 'kg',
    ml: 'ml', milliliter: 'ml', millilitre: 'ml',
    l: 'l', liter: 'l', litre: 'l',
    cup: 'cup', tbsp: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tsp: 'tsp', teaspoon: 'tsp',
    pc: 'piece', piece: 'piece', slice: 'slice', serving: 'serving', order: 'serving', srv: 'serving',
    small: 'small', medium: 'medium', large: 'large', big: 'large',
    dozen: 'dozen', handful: 'serving'
  };
  var FIXED_UNITS = { g: 1, kg: 1, ml: 1, l: 1, cup: 1, tbsp: 1, tsp: 1, piece: 1, slice: 1, serving: 1, small: 1, medium: 1, large: 1, dozen: 1 };
  var SIZE_FACTOR = { small: 0.75, medium: 1, large: 1.3 };

  // leading words that carry no meaning
  var FILLER = { i: 1, im: 1, ive: 1, my: 1, just: 1, so: 1, uh: 1, um: 1, then: 1, ok: 1, okay: 1, today: 1, this: 1, morning: 1, now: 1, had: 1, have: 1, ate: 1, eat: 1, eating: 1, drank: 1, drink: 1, took: 1, take: 1, taking: 1, for: 1, breakfast: 1, lunch: 1, dinner: 1, snack: 1, merienda: 1, supper: 1, log: 1, add: 1, also: 1, and: 1, was: 1, is: 1, were: 1, are: 1, of: 1, kumain: 1, kain: 1, nakain: 1, uminom: 1, inom: 1, ako: 1, ko: 1, nag: 1, ay: 1 };
  // words that may be left over around a matched food name without changing it
  var IGNORE = { whole: 1, a: 1, an: 1, the: 1, of: 1, some: 1, my: 1, plain: 1, regular: 1, fresh: 1, cooked: 1, hot: 1, cold: 1, pc: 1, iced: 1 };
  var STOP = { for: 1, a: 1, an: 1, the: 1, of: 1, in: 1, at: 1, on: 1, about: 1, around: 1, played: 1, play: 1, playing: 1, did: 1, went: 1, go: 1, and: 1, to: 1, i: 1, then: 1, today: 1, just: 1, like: 1, roughly: 1, approx: 1, each: 1, hour: 0, ako: 1, ko: 1, ng: 1, of: 1, nag: 1, naglaro: 1, laro: 1, naglakad: 1, lakad: 1, walk: 1, walked: 1, class: 1, session: 1, training: 1, practice: 1, na: 1, ay: 1, was: 1 };
  var CONNECT = { and: 1, plus: 1, then: 1, with: 1, also: 1, at: 1 };
  var BRAND = { jollibee: 1, mcdo: 1, mcdonalds: 1, kfc: 1, chowking: 1, mang: 0 };

  // ---------- text helpers ----------
  function stem(w) {
    w = String(w).toLowerCase().replace(/['’]/g, '');
    if (w.length <= 2) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/(ss|us|is)$/.test(w)) { /* keep */ }
    else if (/(ches|shes|xes|sses|zes)$/.test(w)) w = w.slice(0, -2);
    else if (/oes$/.test(w)) w = w.slice(0, -2);
    else if (/s$/.test(w)) w = w.slice(0, -1);
    if (w.length > 2 && /ie$/.test(w)) w = w.slice(0, -2) + 'y';
    return w;
  }

  var TOKEN_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+\/\d+|\d+|[½¼¾]|[a-zà-ÿ]+(?:['’][a-zà-ÿ]+)*|[,;+&\n]|\.(?=\s|$))/gi;
  var UNI_FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

  // tokens: { k:'n'|'w'|'s', v, s, e, frac? }  (n number, w word, s separator)
  function tokenize(line) {
    var out = [], m, str = String(line == null ? '' : line);
    // decimal comma after a weight word or before a weight unit: "84,6 kg", "weight 84,6" (same length, so positions hold)
    str = str.replace(/(\d),(\d{1,2})(?=\s*(?:kgs?|kilos?|kilograms?|lbs?|pounds?)\b)/gi, '$1.$2').replace(/(\b(?:weight|weigh|weighed|wt|bw|timbang|bigat)\W+(?:(?:is|ay|ko)\s+)?\d+),(\d{1,2})(?![\d,])/gi, '$1.$2');
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(str))) {
      var x = m[0], t = { s: m.index, e: m.index + x.length };
      if (/^[,;+&\n.]$/.test(x)) { t.k = 's'; t.v = x; }
      else if (UNI_FRAC[x] != null) { t.k = 'n'; t.v = UNI_FRAC[x]; t.frac = true; }
      else if (/^\d+\/\d+$/.test(x)) { var p = x.split('/'); t.k = 'n'; t.v = +p[1] ? (+p[0] / +p[1]) : 0; t.frac = true; }
      else if (/^[\d]/.test(x)) {
        t.k = 'n'; t.v = parseFloat(x.replace(/,/g, ''));
        // a leading minus ("-5 kg", "weight -80") is remembered so the caller can reject it
        if (/[-\u2212\u2013]/.test(str.charAt(m.index - 1)) && (m.index < 2 || /[\s,;:(]/.test(str.charAt(m.index - 2)))) t.neg = true;
      }
      else { t.k = 'w'; t.v = x.toLowerCase().replace(/['’]/g, ''); if (SYN[t.v]) t.v = SYN[t.v]; }
      out.push(t);
    }
    // "and a half" / "and half" -> a bare 0.5 fraction token
    var res = [];
    for (var i = 0; i < out.length; i++) {
      var a = out[i];
      if (a.k === 'w' && a.v === 'and' && out[i + 1] && out[i + 1].k === 'w' && out[i + 1].v === 'a' && out[i + 2] && out[i + 2].k === 'w' && out[i + 2].v === 'half' && res.length) {
        res.push({ k: 'n', v: 0.5, frac: true, tail: true, s: a.s, e: out[i + 2].e }); i += 2; continue;
      }
      if (a.k === 'w' && a.v === 'and' && out[i + 1] && out[i + 1].k === 'w' && out[i + 1].v === 'half' && res.length) {
        res.push({ k: 'n', v: 0.5, frac: true, tail: true, s: a.s, e: out[i + 1].e }); i += 1; continue;
      }
      res.push(a);
    }
    return post(res);
  }

  // drop "this morning" style noise, join number words ("eighty four point six"), "point" decimals, and the Taglish linker "na"
  function post(toks) {
    var i, j, k, t, out = [];
    var isW = function (x, v) { return x && x.k === 'w' && x.v === v; };
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      var hit = 0;
      if (t.k === 'w') for (k = 0; k < NOISE.length && !hit; k++) {
        var ok = true;
        for (j = 0; j < NOISE[k].length; j++) if (!isW(toks[i + j], NOISE[k][j])) { ok = false; break; }
        if (ok) hit = NOISE[k].length;
      }
      if (hit) { i += hit - 1; continue; }
      // "na" right after a Taglish number or before "with": "apat na pandesal", "kape na may gatas"
      if (isW(t, 'na') && ((out.length && out[out.length - 1].k === 'w' && NUMW[out[out.length - 1].v] != null) || isW(toks[i + 1], 'with'))) continue;
      // number words of 20 or more, or any number word before "point", become one number
      if (t.k === 'w' && NUMW[t.v] != null) {
        var v = NUMW[t.v], e = t.e, nx = toks[i + 1], used = 0;
        if (v >= 20 && nx && nx.k === 'w' && NUMW[nx.v] >= 1 && NUMW[nx.v] <= 9) { v += NUMW[nx.v]; e = nx.e; used = 1; nx = toks[i + 2]; }
        var after = toks[i + 1 + used];
        var big = after && after.k === 'w' && (after.v === 'thousand' || after.v === 'hundred' || after.v === 'quarter' || after.v === 'quarters');
        if (!big && (v >= 20 || isW(after, 'point'))) { out.push({ k: 'n', v: v, s: t.s, e: e }); i += used; continue; }
      }
      out.push(t);
    }
    // 84 point 6 / 84 point six five
    var res = [];
    for (i = 0; i < out.length; i++) {
      t = out[i];
      if (t.k === 'n' && !t.frac && isW(out[i + 1], 'point') && res.length >= 0) {
        var digs = '', n = i + 2, last = out[i + 1];
        while (out[n] && ((out[n].k === 'n' && !out[n].frac && Number.isInteger(out[n].v) && digs.length < 3) || (out[n].k === 'w' && NUMW[out[n].v] >= 1 && NUMW[out[n].v] <= 9) || isW(out[n], 'zero'))) {
          digs += isW(out[n], 'zero') ? '0' : String(out[n].k === 'n' ? out[n].v : NUMW[out[n].v]); last = out[n]; n++;
          if (digs.length >= 3) break;
        }
        if (digs) { res.push({ k: 'n', v: parseFloat(t.v + '.' + digs), s: t.s, e: last.e }); i = n - 1; continue; }
      }
      res.push(t);
    }
    return res;
  }

  function keyOf(t) { return t.k === 'n' ? String(t.v) : stem(t.v); }

  // normalised string for a name or alias (used by check.js to find duplicate aliases)
  function norm(str) {
    return tokenize(str).filter(function (t) { return t.k !== 's'; }).map(keyOf).join(' ');
  }

  // ---------- quantities ----------
  // Reads a quantity phrase at toks[i]. Returns { v, n } (n = index after) or null.
  function parseQty(toks, i, opt) {
    var t = toks[i];
    if (!t || t.k === 's' || t.prot) return null;
    var v = null, j = i, w;
    if (t.k === 'n') {
      v = t.v; j = i + 1;
      if (!t.frac && toks[j] && toks[j].k === 'n' && toks[j].frac && !toks[j].prot) { v += toks[j].v; j++; }
    } else {
      w = t.v;
      if (NUMW[w] != null) {
        v = NUMW[w]; j = i + 1;
        if (v >= 20 && toks[j] && toks[j].k === 'w' && NUMW[toks[j].v] != null && NUMW[toks[j].v] >= 1 && NUMW[toks[j].v] <= 9) { v += NUMW[toks[j].v]; j++; }
        if (toks[j] && toks[j].k === 'n' && toks[j].frac && !toks[j].prot) { v += toks[j].v; j++; }
      } else if (w === 'a' || w === 'an') {
        v = 1; j = i + 1;
        if (toks[j] && toks[j].k === 'w' && toks[j].v === 'half') { v = 0.5; j++; }
        else if (toks[j] && toks[j].k === 'w' && toks[j].v === 'couple') { v = 2; j++; if (toks[j] && toks[j].k === 'w' && toks[j].v === 'of') j++; }
      } else if (w === 'half') {
        v = 0.5; j = i + 1;
        if (toks[j] && toks[j].k === 'w' && (toks[j].v === 'a' || toks[j].v === 'an') && toks[j + 1] && toks[j + 1].k !== 's') j++;
      } else if (w === 'quarter' || w === 'quarters') {
        v = 0.25; j = i + 1;
      } else if (w === 'couple') {
        v = 2; j = i + 1; if (toks[j] && toks[j].k === 'w' && toks[j].v === 'of') j++;
      } else if (opt && opt.quirk && (w === 'to' || w === 'too') && toks[i + 1] && toks[i + 1].k !== 's') {
        v = 2; j = i + 1;
      } else {
        return null;
      }
    }
    // "three quarters"
    if (!(opt && opt.noQuarter) && toks[j] && toks[j].k === 'w' && (toks[j].v === 'quarter' || toks[j].v === 'quarters') && v >= 1 && v < 4) { v = v / 4; j++; }
    else if (toks[j] && toks[j].k === 'w' && toks[j].v === 'hundred') { v *= 100; j++; if (toks[j] && toks[j].k === 'w' && toks[j].v === 'thousand') { v *= 10; j++; } else j = addTail(toks, j, 100, function (x) { v += x; }); }
    else if (toks[j] && toks[j].k === 'w' && toks[j].v === 'thousand') { v *= 1000; j++; j = addTail(toks, j, 1000, function (x) { v += x; }); }
    return { v: v, n: j };
  }

  // "seven thousand five hundred", "two hundred fifty": a smaller number right after is added on
  function addTail(toks, j, below, add) {
    var t = toks[j];
    if (!t || t.prot || t.k === 's' || t.frac) return j;
    var r = (t.k === 'n' || (t.k === 'w' && NUMW[t.v] != null)) ? parseQty(toks, j, { noQuarter: true }) : null;
    if (r && r.v >= 1 && r.v < below && !(toks[r.n] && toks[r.n].k === 'w' && stem(toks[r.n].v) === 'k')) { add(r.v); return r.n; }
    return j;
  }

  function fmtQ(q) {
    if (q === 0.5) return '1/2';
    if (q === 0.25) return '1/4';
    if (q === 0.75) return '3/4';
    if (q > 1 && Math.abs(q - Math.floor(q) - 0.5) < 1e-9) return Math.floor(q) + ' 1/2';
    return String(Math.round(q * 100) / 100);
  }

  // ---------- food index ----------
  var indexCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function foodList(foods) {
    if (!foods) return [];
    return Array.isArray(foods) ? foods : (foods.foods || []);
  }

  function buildIndex(foods) {
    var list = foodList(foods);
    if (indexCache && indexCache.has(list)) return indexCache.get(list);
    var aliases = [], units = {}, protectedAl = [];
    list.forEach(function (f) {
      var names = [f.name].concat(f.aliases || []);
      names.forEach(function (a) {
        var keys = tokenize(a).filter(function (t) { return t.k !== 's'; }).map(keyOf);
        if (!keys.length) return;
        var e = { keys: keys, food: f, len: keys.join(' ').length };
        aliases.push(e);
        var needs = keys.some(function (k) { return /^[\d.]+$/.test(k) || CONNECT[k]; });
        if (needs && keys.length > 1) protectedAl.push(e);
      });
      Object.keys(f.portions || {}).forEach(function (u) { units[stem(u)] = u; });
    });
    aliases.sort(function (a, b) { return b.keys.length - a.keys.length || b.len - a.len; });
    var idx = { aliases: aliases, units: units, protectedAl: protectedAl };
    if (indexCache) indexCache.set(list, idx);
    return idx;
  }

  function findSeq(keys, seq, from) {
    outer: for (var i = from || 0; i + seq.length <= keys.length; i++) {
      for (var j = 0; j < seq.length; j++) if (keys[i + j] !== seq[j]) continue outer;
      return i;
    }
    return -1;
  }

  // Best food for a list of food-name keys, or null. Every key must be covered by the alias or be ignorable.
  function matchFood(keys, idx) {
    var best = null;
    for (var a = 0; a < idx.aliases.length; a++) {
      var e = idx.aliases[a];
      if (best && e.keys.length < best.keys.length) break;
      var pos = findSeq(keys, e.keys, 0);
      if (pos < 0) continue;
      var bad = false;
      for (var i = 0; i < keys.length; i++) {
        if (i >= pos && i < pos + e.keys.length) continue;
        if (!IGNORE[keys[i]]) { bad = true; break; }
      }
      if (bad) continue;
      if (!best || e.keys.length > best.keys.length || (e.keys.length === best.keys.length && e.len > best.len)) best = e;
    }
    return best;
  }

  // ---------- food amounts ----------
  // Returns { mult, amount, assumed } or { err }.
  function compute(food, q, unit, assumedIn) {
    var P = food.portions || {}, ml = food.unit === 'ml', per100 = food.per === 100;
    var assumed = !!assumedIn, grams = null, count = null, label, qs = fmtQ(q);
    function one(u) { // grams of one <u>, or null
      switch (u) {
        case 'g': case 'ml': return 1;
        case 'kg': case 'l': return 1000;
        case 'cup': return P.cup != null ? P.cup : (ml ? 240 : null);
        case 'tbsp': return P.tbsp != null ? P.tbsp : (ml ? 15 : null);
        case 'tsp': return P.tsp != null ? P.tsp : (P.tbsp != null ? P.tbsp / 3 : (ml ? 5 : null));
        case 'piece': return P.piece != null ? P.piece : null;
        case 'slice': return P.slice != null ? P.slice : (P.piece != null ? P.piece : null);
        case 'serving': return P.serving != null ? P.serving : (P.piece != null ? P.piece : (P.cup != null ? P.cup : null));
        case 'small': case 'medium': case 'large':
          if (P[u] != null) return P[u];
          return P.piece != null ? P.piece * SIZE_FACTOR[u] : (P.serving != null ? P.serving * SIZE_FACTOR[u] : null);
        default: return P[u] != null ? P[u] : null;
      }
    }
    var u = unit;
    if (u === 'dozen') { q = q * 12; u = 'piece'; qs = fmtQ(q); }
    if (per100) {
      var g1 = one(u || 'serving');
      if (g1 == null) return { err: 'no ' + (u || 'serving') + ' size for ' + food.name };
      grams = g1 * q;
      var gu = ml ? 'ml' : 'g';
      if (u === 'g' || u === 'ml' || u === 'kg' || u === 'l') label = String(Math.round(grams * 10) / 10) + ' ' + gu;
      else label = qs + ' ' + unitLabel(u || 'serving', q) + ' (' + Math.round(grams) + ' ' + gu + ')';
      if (assumed) label = qs + ' ' + unitLabel(u || 'serving', q) + ' (assumed)';
      return { mult: grams / 100, amount: label, assumed: assumed };
    }
    // per 1 piece or 1 serving
    var baseKey = food.unit === 'serving' ? 'serving' : 'piece';
    var base = P[baseKey];
    if (!u || u === 'piece' || u === 'slice' || u === 'serving' && baseKey === 'serving') count = q;
    else if (u === 'serving') { // piece food, "serving"
      count = (P.serving != null && base) ? q * P.serving / base : q;
    } else if (u === 'small' || u === 'medium' || u === 'large') {
      var gs = P[u];
      count = (gs != null && base) ? q * gs / base : q * SIZE_FACTOR[u];
    } else {
      var g = one(u);
      if (g == null || !base) return { err: 'no ' + u + ' size for ' + food.name };
      count = q * g / base;
    }
    var shown = (food.unit === 'serving') ? 'serving' : 'pc';
    if (u === 'small' || u === 'medium' || u === 'large') label = qs + ' ' + u;
    else if (u === 'g' || u === 'ml' || u === 'kg' || u === 'l') label = String(Math.round(q * (u === 'kg' || u === 'l' ? 1000 : 1))) + ' ' + (u === 'ml' || u === 'l' ? 'ml' : 'g');
    else if (u && u !== 'piece' && u !== 'slice' && u !== 'serving') label = qs + ' ' + unitLabel(u, q);
    else label = qs + ' ' + (u === 'serving' || shown === 'serving' ? unitLabel('serving', q) : (u === 'slice' ? unitLabel('slice', q) : 'pc'));
    if (assumed) label = qs + ' ' + (shown === 'serving' ? unitLabel('serving', q) : 'pc') + ' (assumed)';
    return { mult: count, amount: label, assumed: assumed };
  }

  function unitLabel(u, q) {
    if (u === 'g' || u === 'ml' || u === 'tbsp' || u === 'tsp' || u === 'kg' || u === 'l') return u;
    return u + (q > 1 ? (/(s|ch|sh|x)$/.test(u) ? 'es' : 's') : '');
  }

  // ---------- food pieces ----------
  function isFoodWord(t, idx) {
    if (t.k !== 'w') return false;
    if (NUMW[t.v] != null) return false;
    var s = stem(t.v);
    if (UNITS[s] || idx.units[s]) return false;
    if (IGNORE[t.v] || FILLER[t.v] || t.v === 'of' || t.v === 'a' || t.v === 'an' || t.v === 'half' || t.v === 'quarter' || t.v === 'couple') return false;
    return true;
  }

  // split a food segment into pieces at number starts that follow a food word
  function splitPieces(toks, idx) {
    var pieces = [], cur = [], seenFood = false;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var numStart = !t.prot && (t.k === 'n' || (t.k === 'w' && NUMW[t.v] != null));
      var prev = cur.length ? cur[cur.length - 1] : null;
      var prevNum = prev && (prev.k === 'n' || (prev.k === 'w' && NUMW[prev.v] != null));
      if (numStart && seenFood && !prevNum && !(t.k === 'n' && t.frac && prev)) {
        pieces.push(cur); cur = []; seenFood = false;
      }
      cur.push(t);
      if (isFoodWord(t, idx) || t.prot) seenFood = true;
    }
    if (cur.length) pieces.push(cur);
    // a piece that is only "<qty> <unit>" right after a piece with no quantity belongs to it ("rice 1 cup")
    var merged = [];
    for (var p = 0; p < pieces.length; p++) {
      var pc = pieces[p], last = merged[merged.length - 1];
      if (last && !hasLeadingQty(last) && !pc.some(function (x) { return isFoodWord(x, idx) || x.prot; }) && hasLeadingQty(pc)) {
        merged[merged.length - 1] = pc.concat(last);
      } else merged.push(pc);
    }
    return merged;
  }

  function hasLeadingQty(toks) {
    if (!toks.length || toks[0].prot) return false;
    return !!parseQty(toks, 0, null);
  }

  function pieceText(line, toks) {
    if (!toks.length) return '';
    var a = Infinity, b = 0;
    toks.forEach(function (t) { if (t.s < a) a = t.s; if (t.e > b) b = t.e; });
    return line.slice(a, b).trim();
  }

  function resolvePiece(toks, idx) {
    var out = resolvePieceAt(toks, idx, true, false);
    // "quarter pounder": a word that reads as a quantity may be part of the name
    if (out.err) {
      var again = resolvePieceAt(toks, idx, true, true);
      if (again.item) return again;
      if (toks[0] && toks[0].k === 'w') {
        again = resolvePieceAt(toks, idx, false, false);
        if (again.item) return again;
      }
    }
    // "jollibee 1 pc chickenjoy": a brand word in front of the quantity
    if (out.err && toks[0] && toks[0].k === 'w' && BRAND[toks[0].v] && toks.length > 1) {
      var nb = resolvePiece(toks.slice(1), idx);
      if (nb.item) return nb;
    }
    return out;
  }

  // "rice egg": two known foods side by side with no connector (longest first part wins)
  function splitKnown(toks, idx, depth) {
    for (var cut = toks.length - 1; cut >= 1; cut--) {
      var L = toks.slice(0, cut), R = toks.slice(cut);
      if (R[0].k !== 'w' || R[0].prot) continue;
      var a = resolvePiece(L, idx);
      if (!a.item) continue;
      var b = resolvePiece(R, idx);
      if (b.item) return [a, b];
      if (depth < 3) { var sub = splitKnown(R, idx, depth + 1); if (sub) return [a].concat(sub); }
    }
    return null;
  }

  function resolvePieceAt(toks, idx, useQty, noQuarter) {
    var q = null, i = 0, r;
    if (useQty && toks[0] && !toks[0].prot) {
      r = parseQty(toks, 0, { quirk: true, noQuarter: noQuarter });
      if (r) { q = r.v; i = r.n; }
    }
    if (toks[i] && toks[i].k === 'w' && toks[i].v === 'of') i++;
    var rest = toks.slice(i);
    if (!rest.length) return { err: 'no food named' };
    // candidate A: first word is a unit; candidate B: no unit
    var unitTok = rest[0], unit = null;
    if (unitTok.k === 'w' && !unitTok.prot) {
      var us = stem(unitTok.v);
      unit = UNITS[us] || (idx.units[us] ? idx.units[us] : null);
    }
    var keysB = rest.filter(function (t) { return t.k !== 's' && !(t.k === 'w' && t.v === 'of' && false); }).map(keyOf);
    var mB = matchFood(keysB, idx), mA = null, restA = rest;
    if (unit) {
      restA = rest.slice(1);
      if (restA.length && restA[0].k === 'w' && restA[0].v === 'of') restA = restA.slice(1);
      var keysA = restA.map(keyOf);
      mA = restA.length ? matchFood(keysA, idx) : null;
    }
    var m, useUnit = null;
    if (mA && (!mB || mA.keys.length >= mB.keys.length)) { m = mA; useUnit = unit; }
    else if (mB) { m = mB; useUnit = null; }
    else if (unit) return { err: 'not in the food list' };
    else return { err: 'not in the food list' };
    var f = m.food, assumed = false;
    var qty = q;
    if (qty == null) {
      qty = 1;
      if (!useUnit) assumed = true;
    } else if (!useUnit && f.per === 100) {
      assumed = false; // quantity with no unit on a weighed food: count it as servings
      useUnit = 'serving';
      assumed = true;
    }
    var c = compute(f, qty, useUnit, assumed);
    if (c.err) return { err: c.err };
    var it = {
      name: f.name,
      amount: c.amount,
      kcal: Math.round(f.kcal * c.mult),
      protein: Math.round(f.protein * c.mult),
      carbs: Math.round(f.carbs * c.mult),
      fat: Math.round(f.fat * c.mult),
      foodId: f.id
    };
    if (c.assumed) it.assumed = true;
    return { item: it, meta: { food: f, mult: c.mult, explicit: q != null } };
  }

  // ---------- distance, workouts, compound food lines ----------
  var DIST_UNITS = { km: 1, kilometer: 1, kilometre: 1, k: 1, mile: 1.609344, mi: 1.609344 };
  var PACE = { running: 6, cycling: 3, hiking: 12 }; // minutes per km when no time is given
  var STEPS_PER_KM = 1300;
  var WALK_WORDS = { walk: 1, walked: 1, walking: 1, lakad: 1, naglakad: 1, nilakad: 1 };
  var WORKOUT_WORDS = { gym: 1, lift: 1, lifted: 1, lifting: 1, workout: 1, weightlifting: 1, weights: 1, exercise: 1, exercised: 1 };

  // "5k", "5 km", "3.2 miles": first number followed by a distance unit
  function findDistance(toks) {
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].k !== 'n' && toks[i].k !== 'w') continue;
      var r = parseQty(toks, i, { noQuarter: true });
      if (!r || !toks[r.n] || toks[r.n].k !== 'w') continue;
      var f = DIST_UNITS[stem(toks[r.n].v)];
      if (f) return { km: r.v * f, from: i, to: r.n + 1 };
    }
    return null;
  }

  // a dish that already holds its components (omelette holds eggs): a stated component count scales the dish, an unstated one is absorbed
  function mergeDishes(items, metas) {
    var drop = {};
    items.forEach(function (it, i) {
      var m = metas[i], d = m && m.food.contains;
      if (!d || drop[i]) return;
      for (var j = 0; j < items.length; j++) {
        if (j === i || drop[j] || !metas[j] || d.ids.indexOf(metas[j].food.id) < 0) continue;
        if (metas[j].explicit) {
          var cnt = metas[j].mult, mult = cnt / d.n, f = m.food, lab = fmtQ(cnt) + (cnt === 1 ? ' egg' : ' eggs');
          items[i] = { name: f.name.replace(/\b\d+ eggs?\b/, lab), amount: lab,
            kcal: Math.round(f.kcal * mult), protein: Math.round(f.protein * mult), carbs: Math.round(f.carbs * mult), fat: Math.round(f.fat * mult), foodId: f.id };
        }
        drop[j] = true;
        break;
      }
    });
    return { items: items.filter(function (_, i) { return !drop[i]; }) };
  }

  // ---------- sport, steps, weight ----------
  function findSport(toks) {
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].k !== 'w') continue;
      for (var kind in SPORT_WORDS) {
        var ws = SPORT_WORDS[kind];
        for (var a = 0; a < ws.length; a++) {
          var seq = ws[a].split(' '), ok = true;
          for (var j = 0; j < seq.length; j++) {
            var tk = toks[i + j];
            if (!tk || tk.k !== 'w' || tk.v !== seq[j]) { ok = false; break; }
          }
          if (ok && kind === 'other' && toks[i + seq.length] && toks[i + seq.length].v === 'drink') ok = false;
          if (ok) return { kind: kind, from: i, to: i + seq.length };
        }
      }
    }
    return null;
  }

  var HOUR = { hour: 1, hr: 1, h: 1 }, MINUTE = { minute: 1, min: 1, m: 1 }, GAME = { game: 1 };

  function findDuration(toks, skip) {
    var total = 0, found = false, used = {};
    for (var i = 0; i < toks.length; i++) {
      if (skip[i]) continue;
      var r = parseQty(toks, i, null);
      if (!r) continue;
      var u = toks[r.n], us = u && u.k === 'w' ? stem(u.v) : null;
      if (!us) continue;
      var mins = null, hour = false;
      if (HOUR[us]) { mins = r.v * 60; hour = true; }
      else if (MINUTE[us]) mins = r.v;
      else if (GAME[us]) mins = r.v * 20;
      if (mins == null) continue;
      var end = r.n + 1;
      if (hour && toks[end] && toks[end].k === 'n' && toks[end].tail) { mins += toks[end].v * 60; end++; }
      // "1h30", "1h 30": a bare number right after the hours is minutes
      else if (hour && toks[end] && toks[end].k === 'n' && !toks[end].frac && !toks[end].neg && toks[end].v >= 1 && toks[end].v < 60 && Math.floor(toks[end].v) === toks[end].v) {
        var nx = toks[end + 1];
        if (!nx || nx.k === 's' || skip[end + 1] || (nx.k === 'w' && MINUTE[stem(nx.v)])) { mins += toks[end].v; end++; if (nx && nx.k === 'w' && MINUTE[stem(nx.v)] && !skip[end]) end++; }
      }
      total += mins; found = true;
      for (var k = i; k < end; k++) used[k] = true;
      i = end - 1;
    }
    // bare "hour" / "an hour" is covered above; "half hour" too
    if (!found) {
      for (var h = 0; h < toks.length; h++) {
        if (toks[h].k === 'w' && stem(toks[h].v) === 'hour' && !skip[h] && !used[h]) {
          total += 60; found = true; used[h] = true;
        }
      }
    }
    return found ? { min: total, used: used } : null;
  }

  function sportKcal(kind, min, kg) {
    var met = MET[kind] || MET.other;
    return Math.max(0, Math.round((met - 1) * kg * min / 60));
  }

  function findSteps(toks) {
    var si = -1;
    for (var i = 0; i < toks.length; i++) if (toks[i].k === 'w' && stem(toks[i].v) === 'step') { si = i; break; }
    if (si < 0) return null;
    var best = null;
    for (var j = 0; j < toks.length; j++) {
      if (j === si) continue;
      var r = parseQty(toks, j, null);
      if (!r) continue;
      var v = r.v, n = r.n;
      if (toks[n] && toks[n].k === 'w' && toks[n].v === 'k') { v *= 1000; n++; }
      else if (toks[n] && toks[n].k === 'w' && (KG_UNITS[toks[n].v] || LB_UNITS[toks[n].v] || HOUR[stem(toks[n].v)] || MINUTE[stem(toks[n].v)] || GAME[stem(toks[n].v)])) continue;
      if (j > 0 && toks[j - 1].k === 'w' && (WEIGHT_KW[toks[j - 1].v] || toks[j - 1].v === 'in' || toks[j - 1].v === 'weight')) continue;
      var dist = Math.min(Math.abs(j - si), Math.abs(n - 1 - si));
      if (!best || dist < best.dist) best = { v: v, from: j, to: n, dist: dist };
    }
    if (!best) return { si: si, from: si, to: si + 1, none: true };
    var from = Math.min(best.from, si), to = Math.max(best.to, si + 1);
    return { si: si, v: best.v, from: from, to: to };
  }

  var WEIGHT_KW = { weight: 1, weigh: 1, weighed: 1, weighing: 1, weighin: 1, wt: 1, bw: 1, bodyweight: 1, wait: 1, waight: 1, timbang: 1, bigat: 1 };
  var KG_UNITS = { kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1 };
  var LB_UNITS = { lb: 1, lbs: 1, pound: 1, pounds: 1 };

  function findWeight(toks) {
    // keyword form: "weight 84.9", "weigh in 85", "i weighed 84.9 kg"
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.k !== 'w') continue;
      var kw = WEIGHT_KW[t.v] || (t.v === 'body' && toks[i + 1] && toks[i + 1].v === 'weight');
      if (!kw) continue;
      var j = i + 1;
      if (t.v === 'body') j++;
      if (toks[j] && toks[j].k === 'w' && toks[j].v === 'in') j++;
      while (toks[j] && toks[j].k === 'w' && { is: 1, was: 1, at: 1, of: 1, now: 1, today: 1, about: 1, around: 1, ko: 1, ay: 1, ang: 1 }[toks[j].v]) j++;
      if (toks[j] && toks[j].k === 'n' && !toks[j].frac) {
        var v = toks[j].v, n = j + 1, unit = 'kg', hasUnit = false;
        if (toks[n] && toks[n].k === 'w') {
          if (KG_UNITS[toks[n].v]) { n++; hasUnit = true; }
          else if (LB_UNITS[toks[n].v]) { unit = 'lb'; n++; hasUnit = true; }
        }
        if (t.v === 'wait' && !(v >= 40 && v <= 200)) continue; // "wait" is only a mis-heard "weight"
        return { v: v, unit: unit, hasUnit: hasUnit, from: i, to: n };
      }
      if (t.v !== 'wait' && !(t.v === 'weight' && toks[i + 1] && toks[i + 1].k === 'w')) return { none: true, from: i, to: i + 1 };
    }
    // bare form: the whole segment is "<number> kg"
    if (toks.length === 2 && toks[0].k === 'n' && !toks[0].frac && toks[1].k === 'w') {
      if (KG_UNITS[toks[1].v]) return { v: toks[0].v, unit: 'kg', hasUnit: true, from: 0, to: 2 };
      if (LB_UNITS[toks[1].v]) return { v: toks[0].v, unit: 'lb', hasUnit: true, from: 0, to: 2 };
    }
    return null;
  }

  // ---------- tape measurements: "waist 92", "hips 38 in", "my neck is 39 cm" ----------
  var MEASURE_WORDS = { waist: 'waist', waistline: 'waist', hip: 'hips', hips: 'hips', chest: 'chest', arm: 'arm', arms: 'arm', bicep: 'arm', biceps: 'arm', thigh: 'thigh', thighs: 'thigh', neck: 'neck' };
  // plausible range in cm; a bare number is read in the person's unit first, then in the other one
  var MEASURE_LIMITS = { waist: [55, 200], hips: [60, 200], chest: [60, 200], arm: [15, 80], thigh: [30, 120], neck: [20, 70] };
  var MEASURE_LEAD = { my: 1, the: 1, new: 1, current: 1, now: 1, body: 1, measurement: 1, measurements: 1, measure: 1, measured: 1, tape: 1 };
  var MEASURE_GAP = { is: 1, was: 1, at: 1, of: 1, now: 1, today: 1, about: 1, around: 1, to: 1, measures: 1, measured: 1, 'at': 1 };
  var CM_WORDS = { cm: 1, cms: 1, centimeter: 1, centimeters: 1, centimetre: 1, centimetres: 1 };
  var IN_WORDS = { in: 1, inch: 1, inches: 1 };

  function findMeasure(toks) {
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.k !== 'w' || !MEASURE_WORDS[t.v]) continue;
      var from = 0, ok = true;
      for (var b = 0; b < i; b++) { if (toks[b].k !== 'w' || !MEASURE_LEAD[toks[b].v]) { ok = false; break; } }
      if (!ok) continue; // "chicken thigh 200 g" is food, not a tape
      var j = i + 1;
      while (toks[j] && toks[j].k === 'w' && MEASURE_GAP[toks[j].v]) j++;
      if (!toks[j] || toks[j].k !== 'n' || toks[j].frac) continue;
      var v = toks[j].v, n = j + 1, unit = null;
      if (toks[n] && toks[n].k === 'w') {
        if (CM_WORDS[toks[n].v]) { unit = 'cm'; n++; }
        else if (IN_WORDS[toks[n].v]) { unit = 'in'; n++; }
        else if (UNITS[stem(toks[n].v)] || FIXED_UNITS[stem(toks[n].v)]) continue; // "neck 200 g" is not a tape
      }
      return { site: MEASURE_WORDS[t.v], v: v, unit: unit, from: from, to: n };
    }
    return null;
  }

  function measureCm(site, v, unit, hUnit) {
    var lim = MEASURE_LIMITS[site], fits = function (cm) { return cm >= lim[0] && cm <= lim[1]; };
    var order = unit ? [unit] : (hUnit === 'ft' ? ['in', 'cm'] : ['cm', 'in']);
    for (var i = 0; i < order.length; i++) {
      var cm = order[i] === 'in' ? v * 2.54 : v;
      if (fits(cm)) return Math.round(cm * 10) / 10;
    }
    return null;
  }

  // ---------- main ----------
  function parse(line, ctx) {
    ctx = ctx || {};
    var text = String(line == null ? '' : line);
    var res = { actions: [], unknown: [], issues: [] };
    var idx = buildIndex(ctx.foods);
    var kg = (typeof ctx.weightKg === 'number' && ctx.weightKg > 0) ? ctx.weightKg : null;
    var foodItems = [], foodMeta = [], foodAt = -1;

    function bad(txt, why) {
      txt = String(txt).trim();
      if (!txt) return;
      res.unknown.push(txt);
      res.issues.push({ text: txt, why: why });
    }

    // note: "note: ..." or "note ..." at the start of the line or after a separator takes the rest of the line
    var nm = /(^|[,;\n])\s*notes?\s*(?::|\s)\s*([\s\S]*)$/i.exec(text);
    var noteText = null;
    if (nm && /\S/.test(nm[2])) {
      noteText = nm[2].trim();
      text = text.slice(0, nm.index + nm[1].length);
    } else if (nm) {
      text = text.slice(0, nm.index + nm[1].length);
    }

    var toks = tokenize(text);

    // protect food names that contain a connector word or a number ("fish and chips", "3 in 1 coffee")
    if (idx.protectedAl.length) {
      var keys = toks.map(function (t) { return t.k === 's' ? '\u0000' : keyOf(t); });
      idx.protectedAl.forEach(function (e) {
        var from = 0, p;
        while ((p = findSeq(keys, e.keys, from)) >= 0) {
          for (var k = p; k < p + e.keys.length; k++) toks[k].prot = true;
          from = p + e.keys.length;
        }
      });
    }

    // split into segments at separators and connector words
    var segs = [], cur = [];
    toks.forEach(function (t, ti) {
      var isSep = t.k === 's' || (t.k === 'w' && CONNECT[t.v] && !t.prot);
      if (isSep && t.v === 'at' && ti > 0 && toks[ti - 1].k === 'w' && (WEIGHT_KW[toks[ti - 1].v] || MEASURE_WORDS[toks[ti - 1].v] || stem(toks[ti - 1].v) === 'step')) isSep = false; // "weight at 84"
      if (isSep && t.v === 'and' && ti > 0 && toks[ti + 1] && toks[ti + 1].k === 'n' && toks[ti - 1].k === 'w' && HOUR[stem(toks[ti - 1].v)]) isSep = false; // "1 hour and 30 min" 
      if (isSep) { if (cur.length) segs.push(cur); cur = []; }
      else cur.push(t);
    });
    if (cur.length) segs.push(cur);
    // "rice, 2 cups": a lone "<qty> <unit>" segment belongs to the food segment before it
    segs = segs.reduce(function (acc, sg) {
      var prev = acc[acc.length - 1], u = sg.length > 1 && sg[0].k === 'n' && sg[1].k === 'w' && !sg[0].prot ? stem(sg[1].v) : null;
      if (prev && u && (UNITS[u] || idx.units[u]) && u !== 'kg' && u !== 'kilo' && sg.length === 2 && !hasLeadingQty(prev) &&
        prev.some(function (x) { return isFoodWord(x, idx); }) && !prev.some(function (x) { return WEIGHT_KW[x.v] || stem(x.v) === 'step' || MEASURE_WORDS[x.v]; }) && !findSport(prev)) {
        acc[acc.length - 1] = sg.concat(prev);
      } else acc.push(sg);
      return acc;
    }, []);

    function pushAction(a) { res.actions.push(a); }
    function hasNeg(seg) { return seg.some(function (t) { return t.k === 'n' && t.neg; }); }

    function stripLead(seg, set) {
      var i = 0;
      while (i < seg.length && seg[i].k === 'w' && !seg[i].prot && set[seg[i].v]) i++;
      return seg.slice(i);
    }

    function processSeg(seg, depth) {
      seg = stripLead(seg, FILLER);
      if (!seg.length || depth > 6) return;
      var i, used, rest;

      // steps
      var st = findSteps(seg);
      if (st) {
        if (st.none) { bad(pieceText(text, seg), 'how many steps?'); return; }
        if (hasNeg(seg)) { bad(pieceText(text, seg), 'steps cannot be negative'); return; }
        if (!(st.v >= 100 && st.v <= 200000)) { bad(pieceText(text, seg), 'that step count looks off'); return; }
        pushAction({ k: 'steps', n: Math.round(st.v) });
        used = {};
        for (i = st.from; i < st.to; i++) used[i] = true;
        if (st.from > 0 && seg[st.from - 1].k === 'w' && /^(walk|walked|did|got|hit|took|made)$/.test(seg[st.from - 1].v)) used[st.from - 1] = true;
        rest = seg.filter(function (_, n) { return !used[n]; });
        processSeg(stripLead(rest, STOP), depth + 1);
        return;
      }

      // bare "10k": steps when there is no distance or food context
      var bare = seg.filter(function (t) { return !(t.k === 'w' && (t.v === 'today' || t.v === 'steps' || t.v === 'step')); });
      if (bare.length === 2 && bare[0].k === 'n' && !bare[0].frac && !bare[0].prot && bare[1].k === 'w' && bare[1].v === 'k' && !findSport(seg)) {
        var bn = bare[0].v * 1000;
        if (hasNeg(seg)) { bad(pieceText(text, seg), 'steps cannot be negative'); return; }
        if (!(bn >= 100 && bn <= 200000)) { bad(pieceText(text, seg), 'that step count looks off'); return; }
        pushAction({ k: 'steps', n: Math.round(bn) });
        return;
      }

      // distance: "ran 5k", "ran 5 km in 30 min", "walked 3 km"
      var ds = findDistance(seg), spd = ds ? findSport(seg) : null;
      if (ds && (!spd || PACE[spd.kind])) {
        var kd = spd ? spd.kind : null, wk = -1;
        for (i = 0; i < seg.length; i++) if (seg[i].k === 'w' && WALK_WORDS[seg[i].v]) { wk = i; break; }
        if (!kd && wk < 0) { bad(pieceText(text, seg), 'ran or walked? say which'); return; }
        if (hasNeg(seg)) { bad(pieceText(text, seg), 'distance cannot be negative'); return; }
        if (!(ds.km > 0 && ds.km <= 300)) { bad(pieceText(text, seg), 'that distance looks off'); return; }
        var skipD = {};
        for (i = ds.from; i < ds.to; i++) skipD[i] = true;
        if (spd) for (i = spd.from; i < spd.to; i++) skipD[i] = true;
        if (wk >= 0) skipD[wk] = true;
        var dur = findDuration(seg, skipD);
        used = {};
        Object.keys(skipD).forEach(function (k) { used[k] = true; });
        if (dur) Object.keys(dur.used).forEach(function (k) { used[k] = true; });
        if (!kd && !dur) { // walking with no time is steps
          var wsteps = Math.round(ds.km * STEPS_PER_KM);
          if (!(wsteps >= 100 && wsteps <= 200000)) { bad(pieceText(text, seg), 'that step count looks off'); return; }
          pushAction({ k: 'steps', n: wsteps, estimated: 'about ' + STEPS_PER_KM + ' steps per km' });
        } else {
          var skind = kd || 'other', est = null, smin;
          if (dur) smin = dur.min;
          else { smin = ds.km * PACE[kd]; est = 'about ' + Math.round(smin) + ' min at ' + PACE[kd] + ' min per km'; }
          if (!(smin > 0 && smin <= 600)) { bad(pieceText(text, seg), 'that duration looks off'); return; }
          var da = { k: 'sport', kind: skind, min: Math.round(smin * 10) / 10, kcal: sportKcal(skind, smin, kg || DEFAULT_KG) };
          if (kg == null) da.assumed = true;
          if (est) da.estimated = est;
          pushAction(da);
        }
        rest = seg.filter(function (_, n) { return !used[n]; });
        processSeg(stripLead(rest, STOP), depth + 1);
        return;
      }

      // sport
      var sp = findSport(seg);
      if (sp) {
        var skipSet = {};
        for (i = sp.from; i < sp.to; i++) skipSet[i] = true;
        var du = findDuration(seg, skipSet);
        if (hasNeg(seg)) { bad(pieceText(text, seg), 'minutes cannot be negative'); return; }
        if (!du) { bad(pieceText(text, seg), 'how long did you play?'); return; }
        if (!(du.min > 0 && du.min <= 600)) { bad(pieceText(text, seg), 'that duration looks off'); return; }
        var assumedKg = kg == null;
        var a = { k: 'sport', kind: sp.kind, min: Math.round(du.min * 10) / 10, kcal: sportKcal(sp.kind, du.min, kg || DEFAULT_KG) };
        if (assumedKg) a.assumed = true;
        pushAction(a);
        used = {};
        for (i = sp.from; i < sp.to; i++) used[i] = true;
        Object.keys(du.used).forEach(function (k) { used[k] = true; });
        rest = seg.filter(function (_, n) { return !used[n]; });
        processSeg(stripLead(rest, STOP), depth + 1);
        return;
      }

      // lifting is logged with Start workout, never as a sport
      for (i = 0; i < seg.length; i++) {
        var wv = seg[i].k === 'w' && !seg[i].prot ? seg[i].v : '';
        if (WORKOUT_WORDS[wv] || (wv === 'worked' && seg[i + 1] && seg[i + 1].v === 'out') || (wv === 'weight' && seg[i + 1] && /^(training|lifting|session|workout)$/.test(seg[i + 1].v))) {
          bad(pieceText(text, seg), 'lifting goes in Start workout, not here');
          return;
        }
      }

      // weight
      var wt = findWeight(seg);
      if (wt) {
        if (wt.none) { bad(pieceText(text, seg), 'what weight?'); return; }
        if (hasNeg(seg)) { bad(pieceText(text, seg), 'weight cannot be negative'); return; }
        var wkg = wt.unit === 'lb' ? wt.v * 0.45359237 : wt.v;
        var lo = wt.hasUnit ? 25 : 30, hi = wt.hasUnit ? 300 : 250;
        if (!(wkg >= lo && wkg <= hi)) { bad(pieceText(text, seg), 'that weight looks off'); return; }
        pushAction({ k: 'weight', kg: Math.round(wkg * 10) / 10 });
        used = {};
        for (i = wt.from; i < wt.to; i++) used[i] = true;
        rest = seg.filter(function (_, n) { return !used[n]; });
        processSeg(stripLead(rest, STOP), depth + 1);
        return;
      }

      // tape measurement
      var ms = findMeasure(seg);
      if (ms) {
        var mcm = measureCm(ms.site, ms.v, ms.unit, ctx.hUnit);
        if (mcm == null) { bad(pieceText(text, seg), 'that ' + ms.site + ' measurement looks off'); return; }
        pushAction({ k: 'measure', site: ms.site, cm: mcm });
        used = {};
        for (i = ms.from; i < ms.to; i++) used[i] = true;
        rest = seg.filter(function (_, n) { return !used[n]; });
        processSeg(stripLead(rest, STOP), depth + 1);
        return;
      }

      // food
      // "one scoop whey in 300 ml milk": "in" before a quantity joins two foods
      seg = seg.filter(function (t, n) { return !(t.k === 'w' && t.v === 'in' && !t.prot && n > 0 && seg[n + 1] && parseQty(seg, n + 1, null)); });
      var pieces = splitPieces(seg, idx);
      if (pieces.length > 1) pieces = pieces.filter(function (pc) { return !(pc.length === 1 && pc[0].k === 'w' && BRAND[pc[0].v]); }); // lone "jollibee" before "1 pc chickenjoy"
      pieces.forEach(function (pc) {
        var out = resolvePiece(pc, idx), outs = [out];
        if (!out.item && out.err === 'not in the food list') { var sk = splitKnown(pc, idx, 0); if (sk) outs = sk; }
        outs.forEach(function (o) {
          if (o.item) {
            if (foodAt < 0) { foodAt = res.actions.length; res.actions.push(null); }
            foodItems.push(o.item); foodMeta.push(o.meta);
          } else bad(pieceText(text, pc), o.err);
        });
      });
    }
    segs.forEach(function (s) { processSeg(s, 0); });

    if (noteText) pushAction({ k: 'note', text: noteText });

    if (foodItems.length) {
      foodItems = mergeDishes(foodItems, foodMeta).items;
      res.actions[foodAt] = { k: 'food', items: foodItems, meal: mealNumber(ctx) };
    }
    res.actions = res.actions.filter(Boolean);
    return res;
  }

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    var d = Date.parse(v);
    return isNaN(d) ? null : d;
  }

  // next meal number, or the last one if the last item was logged within 90 minutes
  function mealNumber(ctx) {
    var last = Math.max(0, Math.floor(+ctx.lastMealNo) || 0);
    if (!last) return 1;
    var at = toMs(ctx.lastMealAt), now = toMs(ctx.now);
    if (now == null) now = Date.now();
    if (at != null && now - at <= 90 * 60000) return last;
    return last + 1;
  }

  // search box helper: foods whose name or alias holds every query word (prefix allowed), best first
  function searchFoods(query, foods, limit) {
    var qk = tokenize(query).filter(function (t) { return t.k !== 's'; }).map(keyOf);
    if (!qk.length) return [];
    var out = [];
    foodList(foods).forEach(function (f) {
      var best = 0;
      [f.name].concat(f.aliases || []).forEach(function (a) {
        var ak = tokenize(a).filter(function (t) { return t.k !== 's'; }).map(keyOf);
        var all = qk.every(function (q) { return ak.some(function (x) { return x.indexOf(q) === 0; }); });
        if (!all) return;
        var exact = qk.join(' ') === ak.join(' ');
        var score = (exact ? 100 : 10) - ak.length;
        if (score > best) best = score;
      });
      if (best) out.push({ f: f, s: best });
    });
    out.sort(function (a, b) { return b.s - a.s; });
    return out.slice(0, limit || 20).map(function (x) { return x.f; });
  }

  var api = { parse: parse, norm: norm, sportKcal: sportKcal, searchFoods: searchFoods, mealNumber: mealNumber, MET: MET, version: 1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FormaCmd = api;
})();
