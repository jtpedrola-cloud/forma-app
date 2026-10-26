/* Forma backend adapter (skeleton). Portable: no DOM needed except URL.createObjectURL in blobURL, no storage, no
 * app globals. Plain script, sets window.FormaBackend. Node: module.exports = FormaBackend.
 *
 *   var B = FormaBackend.create(kind, cfg)
 *
 *   kind 'github'   cfg = { repo: 'owner/name', token, branch?: 'main', fetch?: fetchFn }
 *                   cfg may also be a FUNCTION returning that object, read on every call. Use it in index.html
 *                   because the app reassigns its `cfg` variable (setup, sign out): FormaBackend.create('github',()=>cfg).
 *   kind 'supabase' cfg = { url, anonKey, client?, fetch?, libBase?, sdkUrls?, redirectTo? }. Live since v0.9.0: the same
 *                   methods over the tables in supabase/schema.sql, one logical JSON file per day mapped to rows, photos in
 *                   the private 'photos' bucket. Details above the supabase() function. Plan: docs/specs/backend.md.
 *
 * Methods (same names, arguments and results as the GH object in app/index.html, so it can be dropped in as
 * `const B = DEMO ? DEMOB : FormaBackend.create('github', () => cfg)`). All return Promises.
 *   B.tree()                       -> { [path]: sha }          every blob on main (git trees API, recursive)
 *   B.raw(p)                       -> string | null            file text, null on 404
 *   B.meta(p)                      -> { sha, data } | null     parsed JSON plus sha, null on 404
 *   B.put(p, text, sha, msg)       -> { sha }                  create (sha falsy) or update; HttpErr 409/422 on conflict
 *   B.putBin(p, b64, msg)          -> void                     binary file (photos), overwrites if it exists
 *   B.delBin(p, msg)               -> void                     delete, no-op if already gone
 *   B.meta0(p)                     -> sha | null               sha only
 *   B.blobURL(p)                   -> blob: object URL         for <img src>, raw bytes through the API (private repo)
 *   B.setKeepalive(on)             sets fetch keepalive on writes (the app turns it on at pagehide / tab hidden)
 *   B.kind                         'github' | 'supabase'
 *   B.auth = { signIn(email), signOut(), user() }
 *       github: all three resolve null (the token in Settings is the identity).
 *       supabase: signIn sends a magic link, signOut ends the session, user() -> { id, email } | null; also
 *       onChange(fn(user, event)) and ready() (loads supabase-js from cdnjs only when first needed).
 *   supabase only: B.aiUsage() -> AI meal reads used today; B.callFn(name, body, signal) -> { status, data }.
 *
 * Errors: FormaBackend.HttpErr (class name HttpErr) extends Error, has .status (HTTP code) and message 'HTTP <status>'.
 * A network failure is the browser's own TypeError from fetch, NOT an HttpErr; the app's isNet(e) relies on that.
 * Helpers exposed for the app and tests: FormaBackend.b64enc(str), FormaBackend.b64dec(b64), FormaBackend.encPath(p).
 *
 * Swap-in notes for the integrator: index.html keeps KEEP, gh(), encPath, b64enc, b64dec and HttpErr itself today.
 * Replace the whole "GitHub backend" block with the create() call above, keep `class HttpErr` pointing at
 * FormaBackend.HttpErr (so `instanceof` checks keep working), and call B.setKeepalive(true/false) where KEEP is set.
 * DEMOB stays a separate in-memory object with the same methods; it does not need to change.
 */
(function () {
  'use strict';

  class HttpErr extends Error {
    constructor(s, m) { super(m || ('HTTP ' + s)); this.status = s; }
  }

  function b64enc(s) {
    var u = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(s) {
    var bin = atob(s.replace(/\s/g, '')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  /* ---------- GitHub contents API (copied from GH in app/index.html, behaviour unchanged) ---------- */
  function github(cfgIn) {
    var keep = false;
    var C = function () { return (typeof cfgIn === 'function' ? cfgIn() : cfgIn) || {}; };
    var branch = function () { return C().branch || 'main'; };

    async function gh(method, path, body, raw) {
      var c = C();
      var f = c.fetch || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) throw new TypeError('fetch is not available');
      return f('https://api.github.com/repos/' + c.repo + path, {
        method: method, cache: 'no-store', keepalive: keep && !!body,
        headers: Object.assign({
          Authorization: 'Bearer ' + c.token,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    }

    var B = {
      kind: 'github',
      setKeepalive: function (on) { keep = !!on; },
      async tree() {
        var r = await gh('GET', '/git/trees/' + branch() + '?recursive=1');
        if (!r.ok) throw new HttpErr(r.status);
        var j = await r.json(), m = {};
        (j.tree || []).forEach(function (t) { if (t.type === 'blob') m[t.path] = t.sha; });
        B.treeTruncated = !!j.truncated;
        return m;
      },
      async raw(p) {
        var r = await gh('GET', '/contents/' + encPath(p) + '?ref=' + branch(), null, true);
        if (r.status === 404) return null;
        if (!r.ok) throw new HttpErr(r.status);
        return r.text();
      },
      async meta(p) {
        var r = await gh('GET', '/contents/' + encPath(p) + '?ref=' + branch());
        if (r.status === 404) return null;
        if (!r.ok) throw new HttpErr(r.status);
        var j = await r.json();
        return { sha: j.sha, data: JSON.parse(b64dec(j.content)) };
      },
      async put(p, text, sha, msg) {
        var body = { message: msg, content: b64enc(text), branch: branch() };
        if (sha) body.sha = sha;
        var r = await gh('PUT', '/contents/' + encPath(p), body);
        if (!r.ok) throw new HttpErr(r.status);
        var j = await r.json();
        return { sha: j.content.sha };
      },
      async putBin(p, b64, msg) {
        var m = await B.meta0(p), body = { message: msg, content: b64, branch: branch() };
        if (m) body.sha = m;
        var r = await gh('PUT', '/contents/' + encPath(p), body);
        if (!r.ok) throw new HttpErr(r.status);
      },
      async delBin(p, msg) {
        var sha = await B.meta0(p);
        if (!sha) return;
        var r = await gh('DELETE', '/contents/' + encPath(p), { message: msg, sha: sha, branch: branch() });
        if (!r.ok && r.status !== 404) throw new HttpErr(r.status);
      },
      async meta0(p) {
        var r = await gh('GET', '/contents/' + encPath(p) + '?ref=' + branch());
        if (r.status === 404) return null;
        if (!r.ok) throw new HttpErr(r.status);
        return (await r.json()).sha;
      },
      async blobURL(p) {
        var r = await gh('GET', '/contents/' + encPath(p) + '?ref=' + branch(), null, true);
        if (!r.ok) throw new HttpErr(r.status);
        return URL.createObjectURL(await r.blob());
      },
      auth: {
        signIn: async function () { return null; },
        signOut: async function () { return null; },
        user: async function () { return null; }
      }
    };
    return B;
  }

  /* ---------- Supabase (accounts): the same file-shaped contract over tables, so the sync engine does not change ----------
   * cfg = { url, anonKey, client?, fetch?, libBase?, sdkUrls?, redirectTo? }  (cfg may be a function, read on every call)
   *   client    a ready supabase-js client (tests); otherwise supabase-js is loaded from cdnjs (jsDelivr as a fallback)
   *             the first time it is needed and created with the implicit flow, so a magic link opened in another
   *             browser still signs in.
   *   libBase   where the shared library files live (foods, exercises, lessons). Default 'lib/' next to the page.
   * One logical file per day maps to rows (docs/specs/backend.md section 4):
   *   data/food/<d>.json -> food_items        data/log/<d>.json -> logs + workouts + sets + activities + body_fat
   *   data/profile.json -> profiles           data/program.json, program-backup.json -> programs (active row, backup row)
   *   data/meals.json -> saved_meals          data/checkins.json -> checkins (read only)
   *   data/recipes.json -> recipes            data/myfoods.json -> my_foods
   *   log.habits -> logs.habits               program.sports -> inside programs.body (the whole program is stored)
   *   data/exercises.json, foods.json, lessons.json -> the shared library plus the user's own exercises (programs.exercises)
   *   data/photos/<d>/<n>, data/progress/<d>/<n> -> bucket 'photos' at <user id>/<meal|progress>/<d>/<n> plus a photos row
   * The "sha" of a file is count:latest updated_at of its rows. put() refuses with HttpErr 409 when the sha is not the
   * current one (422 when the file already has rows and no sha was sent), exactly where GitHub would, so the app's
   * merge loop works unchanged.
   */
  var BACKUP = 'forma:backup';
  var SDK_URLS = [
    'https://cdnjs.cloudflare.com/ajax/libs/supabase-js/2.49.4/umd/supabase.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js'
  ];
  var DAY = '(\\d{4}-\\d{2}-\\d{2})';
  var POSES = { front: 1, side: 1, back: 1 };
  var FOOD_BY = { app: 1, claude: 1, ai: 1 };
  var PROF_KEYS = ['name', 'goal', 'units', 'hUnit', 'startWeight', 'startDate', 'stepGoal', 'weekStart', 'sessionMax',
    'goalRate', 'targets', 'body', 'intake', 'modules', 'exUnits'];
  var RECIPE_KEYS = ['id', 'name', 'servings', 'totalG', 'items', 'by', 't'];
  var REST_WEEK = { 0: 'rest', 1: 'rest', 2: 'rest', 3: 'rest', 4: 'rest', 5: 'rest', 6: 'rest' };

  function num(v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); }
  function whole(v) { var n = num(v); return n === null ? null : Math.round(n); }
  function str(v) { return v === null || v === undefined ? null : String(v); }
  function iso(v) { if (v === null || v === undefined || v === '') return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  // rows of one day keep their order through created_at = midnight UTC of that day + index milliseconds
  function orderStamp(day, i) { return new Date(Date.parse(day + 'T00:00:00Z') + i).toISOString(); }
  function vOf(rows) {
    if (!rows || !rows.length) return null;
    var m = '';
    rows.forEach(function (r) { if (r.updated_at > m) m = r.updated_at; });
    return rows.length + ':' + m;
  }
  function inList(a) { return '(' + a.map(function (x) { return '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }).join(',') + ')'; }
  function manilaDay() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
  function defaultProgram() { return { name: 'My program', weekdays: Object.assign({}, REST_WEEK), days: [] }; }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

  function route(p) {
    var m;
    if ((m = new RegExp('^data/food/' + DAY + '\\.json$').exec(p))) return { t: 'food', day: m[1] };
    if ((m = new RegExp('^data/log/' + DAY + '\\.json$').exec(p))) return { t: 'log', day: m[1] };
    if ((m = new RegExp('^data/(photos|progress)/' + DAY + '/([^/]+)$').exec(p))) return { t: 'photo', kind: m[1] === 'photos' ? 'meal' : 'progress', day: m[2], name: m[3] };
    var names = { 'data/profile.json': 'profile', 'data/program.json': 'program', 'data/program-backup.json': 'backup',
      'data/exercises.json': 'exercises', 'data/foods.json': 'foods', 'data/lessons.json': 'lessons',
      'data/checkins.json': 'checkins', 'data/meals.json': 'meals', 'data/recipes.json': 'recipes', 'data/myfoods.json': 'myfoods' };
    return names[p] ? { t: names[p] } : null;
  }

  function supabase(cfgIn) {
    var C = function () { return (typeof cfgIn === 'function' ? cfgIn() : cfgIn) || {}; };
    var keep = false, clientP = null, libs = {}, subs = [];

    /* ----- auth (supabase-js) ----- */
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.onload = res;
        s.onerror = function () { s.remove(); rej(new Error('sdk')); };
        document.head.appendChild(s);
      });
    }
    async function loadSdk(urls) {
      if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) return window.supabase;
      if (typeof document === 'undefined') throw new Error('No supabase client given.');
      for (var i = 0; i < urls.length; i++) {
        try { await loadScript(urls[i]); } catch (e) { continue; }
        if (window.supabase && window.supabase.createClient) return window.supabase;
      }
      throw new TypeError('The sign-in tool did not load. Check your connection.');
    }
    function client() {
      var c = C();
      if (c.client) return Promise.resolve(c.client);
      var key = c.url + '|' + c.anonKey;
      if (clientP && clientP.key === key) return clientP.p;
      var p = (async function () {
        if (!c.url || !c.anonKey) throw new Error('Add the server address and key first.');
        var lib = await loadSdk(c.sdkUrls || SDK_URLS);
        var cl = lib.createClient(c.url, c.anonKey, { auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        cl.auth.onAuthStateChange(function (ev, session) {
          var u = session && session.user ? { id: session.user.id, email: session.user.email } : null;
          subs.slice().forEach(function (fn) { try { fn(u, ev); } catch (e) { /* a listener must not break auth */ } });
        });
        return cl;
      })();
      clientP = { key: key, p: p };
      p.catch(function () { if (clientP && clientP.p === p) clientP = null; });
      return p;
    }
    async function session() {
      var cl = await client(), r = await cl.auth.getSession();
      return r && r.data ? r.data.session : null;
    }
    async function need() { var s = await session(); if (!s) throw new HttpErr(401); return s; }

    /* ----- REST, storage and functions ----- */
    async function req(method, path, o) {
      o = o || {};
      var c = C(), f = c.fetch || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) throw new TypeError('fetch is not available');
      var s = await need(), h = Object.assign({ apikey: c.anonKey, Authorization: 'Bearer ' + s.access_token }, o.headers || {});
      var body = o.body;
      if (body !== undefined && !o.rawBody) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
      if (o.prefer) h.Prefer = o.prefer;
      return f(String(c.url).replace(/\/+$/, '') + path, {
        method: method, headers: h, body: body, cache: 'no-store',
        keepalive: keep && typeof body === 'string' && body.length < 60000
      });
    }
    async function ok(r) {
      if (r.ok) return r;
      var e = new HttpErr(r.status);
      try { e.detail = (await r.text()).slice(0, 300); } catch (x) { /* ignore */ }
      throw e;
    }
    async function rows(path) { // every page of a query
      var out = [], from = 0, step = 1000;
      for (;;) {
        var r = await req('GET', '/rest/v1/' + path, { headers: { 'Range-Unit': 'items', Range: from + '-' + (from + step - 1) } });
        if (r.status === 416) break;
        await ok(r);
        var a = await r.json();
        out = out.concat(a);
        if (a.length < step) break;
        from += step;
      }
      return out;
    }
    async function write(method, path, body, prefer) {
      var r = await ok(await req(method, '/rest/v1/' + path, { body: body, prefer: prefer }));
      if (r.status === 204) return null;
      var t = await r.text();
      return t ? JSON.parse(t) : null;
    }
    var upsert = function (table, onConflict, body, ret) {
      return write('POST', table + '?on_conflict=' + onConflict + (ret ? '&select=' + ret : ''), body,
        'resolution=merge-duplicates,return=' + (ret ? 'representation' : 'minimal'));
    };
    var insert = function (table, body) { return write('POST', table, body, 'return=minimal'); };
    var remove = function (path) { return write('DELETE', path, undefined, 'return=minimal'); };

    function lib(name) {
      if (!libs[name]) {
        libs[name] = (async function () {
          var c = C(), f = c.fetch || fetch;
          var r = await f(String(c.libBase || 'lib/') + name + '.json', { cache: 'no-cache' });
          if (!r.ok) throw new HttpErr(r.status);
          return r.json();
        })();
        libs[name].catch(function () { delete libs[name]; });
      }
      return libs[name];
    }

    /* ----- versions ("sha") ----- */
    function activeProg(uid, cols) { return rows('programs?author_id=eq.' + uid + '&active=eq.true&select=' + (cols || 'id,updated_at') + '&limit=1'); }
    function backupProg(uid, cols) { return rows('programs?author_id=eq.' + uid + '&description=eq.' + encodeURIComponent(BACKUP) + '&select=' + (cols || 'id,updated_at') + '&limit=1'); }
    async function version(r) {
      var s = await need(), uid = s.user.id;
      switch (r.t) {
        case 'food': return vOf(await rows('food_items?day=eq.' + r.day + '&select=updated_at'));
        case 'log': return vOf(await rows('logs?day=eq.' + r.day + '&select=updated_at'));
        case 'profile': return vOf(await rows('profiles?select=updated_at')) || 'none';
        case 'program': return vOf(await activeProg(uid)) || 'none';
        case 'backup': return vOf(await backupProg(uid));
        case 'exercises': return 'lib:' + (vOf(await activeProg(uid)) || '');
        case 'checkins': return vOf(await rows('checkins?select=updated_at'));
        case 'meals': return vOf(await rows('saved_meals?select=updated_at'));
        case 'recipes': return vOf(await rows('recipes?select=updated_at'));
        case 'myfoods': return vOf(await rows('my_foods?select=updated_at'));
        case 'photo': {
          var k = uid + '/' + r.kind + '/' + r.day + '/' + r.name;
          var p = await rows('photos?path=eq.' + encodeURIComponent(k) + '&select=id');
          return p.length ? p[0].id : null;
        }
        default: return 'lib';
      }
    }

    /* ----- build a logical file from rows ----- */
    function foodFromRow(r, day) {
      var it = { id: r.legacy_id || r.id, meal: r.meal || 1, name: r.name, amount: r.amount || '', kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, by: r.by || 'app' };
      if (r.t) it.t = r.t;
      if (r.photos && r.photos.path) it.photo = 'data/photos/' + day + '/' + r.photos.path.split('/').pop();
      return it;
    }
    async function buildFood(day) {
      var a = await rows('food_items?day=eq.' + day + '&select=*,photos(path)&order=created_at.asc,id.asc');
      return a.length ? { date: day, items: a.map(function (r) { return foodFromRow(r, day); }) } : null;
    }
    async function buildLog(day) {
      var res = await Promise.all([
        rows('logs?day=eq.' + day + '&select=*'),
        rows('workouts?day=eq.' + day + '&select=*,sets(*)'),
        rows('activities?day=eq.' + day + '&select=*&order=created_at.asc,id.asc'),
        rows('body_fat?day=eq.' + day + '&select=*')
      ]);
      var lg = res[0][0], wk = res[1][0], acts = res[2], bf = res[3][0];
      if (!lg && !wk && !acts.length && !bf) return null;
      var d = { date: day, steps: lg ? lg.steps : null, weight: lg && lg.weight_kg != null ? Number(lg.weight_kg) : null, note: lg ? lg.note || '' : '', workout: null };
      if (wk) {
        var sets = {};
        (wk.sets || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.idx - b.idx; })
          .forEach(function (s) {
            var o = { w: s.weight_kg == null ? 0 : Number(s.weight_kg), r: s.reps == null ? 0 : s.reps, done: !!s.done };
            if (s.rir != null) o.rir = s.rir;
            if (s.drops && s.drops.length) o.drops = s.drops;
            (sets[s.exercise_id] = sets[s.exercise_id] || []).push(o);
          });
        var w = { dayId: wk.day_id, startedAt: wk.started_at, finishedAt: wk.finished_at, sets: sets, swaps: wk.swaps || {} };
        if (wk.last_at) w.lastAt = wk.last_at;
        if (wk.marked) w.marked = true;
        if (wk.extra) w.extra = wk.extra;
        if (wk.note) w.note = wk.note;
        d.workout = w;
      }
      if (bf) {
        d.bodyFat = { pct: Number(bf.pct), by: bf.by || 'claude' };
        if (bf.low != null) d.bodyFat.low = Number(bf.low);
        if (bf.high != null) d.bodyFat.high = Number(bf.high);
        if (bf.note) d.bodyFat.note = bf.note;
      }
      if (acts.length) d.activities = acts.map(function (a) { return { id: a.legacy_id || a.id, kind: a.kind, min: a.minutes, kcal: a.kcal, by: a.by || 'app' }; });
      if (lg && lg.measure && Object.keys(lg.measure).length) d.measure = lg.measure;
      if (lg && lg.habits && Object.keys(lg.habits).length) d.habits = lg.habits;
      return d;
    }
    function profFromRow(r) {
      r = r || {};
      var p = { name: r.name || '', units: r.units || 'kg' };
      if (r.goal) p.goal = r.goal;
      if (r.h_unit) p.hUnit = r.h_unit;
      if (r.start_weight != null) p.startWeight = Number(r.start_weight);
      p.startDate = r.start_date || (r.created_at ? String(r.created_at).slice(0, 10) : manilaDay());
      p.targets = r.targets || { kcal: 2000, protein: 120, carbs: 220, fat: 65 };
      p.stepGoal = r.step_goal != null ? r.step_goal : 10000;
      p.weekStart = r.week_start != null ? r.week_start : 1;
      if (r.session_max != null) p.sessionMax = r.session_max;
      if (r.goal_rate != null) p.goalRate = Number(r.goal_rate);
      p.body = r.body || { sex: 'male', age: 30, heightCm: 175, assumed: true };
      if (r.intake) p.intake = r.intake;
      if (r.modules) p.modules = r.modules;
      if (r.ex_units) p.exUnits = r.ex_units;
      return Object.assign(p, r.extra || {});
    }
    function profToRow(doc, uid) {
      var extra = {};
      Object.keys(doc).forEach(function (k) { if (PROF_KEYS.indexOf(k) < 0) extra[k] = doc[k]; });
      return {
        user_id: uid, name: str(doc.name), goal: str(doc.goal), units: doc.units === 'lb' ? 'lb' : 'kg',
        h_unit: doc.hUnit === 'ft' || doc.hUnit === 'cm' ? doc.hUnit : null, start_weight: num(doc.startWeight),
        start_date: /^\d{4}-\d{2}-\d{2}$/.test(doc.startDate || '') ? doc.startDate : null, step_goal: whole(doc.stepGoal),
        week_start: whole(doc.weekStart), session_max: whole(doc.sessionMax), goal_rate: num(doc.goalRate),
        targets: doc.targets || { kcal: 2000, protein: 120, carbs: 220, fat: 65 }, body: doc.body || null,
        intake: doc.intake || null, modules: doc.modules || null, ex_units: doc.exUnits || null,
        extra: Object.keys(extra).length ? extra : null
      };
    }
    async function build(r) {
      var s = await need(), uid = s.user.id;
      switch (r.t) {
        case 'food': return buildFood(r.day);
        case 'log': return buildLog(r.day);
        case 'profile': return profFromRow((await rows('profiles?select=*&limit=1'))[0]);
        case 'program': {
          var a = (await activeProg(uid, 'body'))[0];
          return a && a.body && a.body.weekdays ? a.body : defaultProgram();
        }
        case 'backup': { var b = (await backupProg(uid, 'body'))[0]; return b ? b.body : null; }
        case 'exercises': {
          var res = await Promise.all([lib('exercises'), activeProg(uid, 'exercises')]);
          var d = clone(res[0]), mine = res[1][0] && res[1][0].exercises;
          d.exercises = Object.assign(d.exercises || {}, mine || {});
          return d;
        }
        case 'foods': case 'lessons': return lib(r.t);
        case 'checkins': {
          var c = await rows('checkins?select=data,day&order=day.asc');
          return c.length ? { checkins: c.map(function (x) { return x.data; }) } : null;
        }
        case 'meals': {
          var m = await rows('saved_meals?select=*&order=created_at.asc,id.asc');
          return m.length ? { meals: m.map(function (x) { return { id: x.legacy_id || x.id, name: x.name, items: Array.isArray(x.items) ? x.items : [], by: 'app', t: x.created_at }; }) } : null;
        }
        case 'recipes': {
          var rc = await rows('recipes?select=*&order=created_at.asc,id.asc');
          return rc.length ? { recipes: rc.map(function (x) {
            var o = Object.assign({}, x.extra || {}, { id: x.legacy_id, name: x.name, servings: Number(x.servings), items: Array.isArray(x.items) ? x.items : [], by: x.by || 'app' });
            if (x.total_g != null) o.totalG = Number(x.total_g);
            if (x.t) o.t = x.t;
            return o;
          }) } : null;
        }
        case 'myfoods': {
          var mf = await rows('my_foods?select=*&order=created_at.asc,id.asc');
          return mf.length ? { foods: mf.map(function (x) { return Object.assign({}, x.data || {}, { id: x.legacy_id, name: x.name }); }) } : null;
        }
      }
      return null;
    }

    /* ----- write a logical file back ----- */
    async function putFood(day, doc, uid) {
      var items = Array.isArray(doc.items) ? doc.items : [];
      var photoRe = new RegExp('^data/photos/' + DAY + '/([^/]+)$'), paths = [];
      items.forEach(function (it) {
        var m = it.photo && photoRe.exec(it.photo);
        if (m) paths.push(uid + '/meal/' + m[1] + '/' + m[2]);
      });
      var ids = {};
      if (paths.length) (await rows('photos?path=in.' + encodeURIComponent(inList(paths)) + '&select=id,path')).forEach(function (p) { ids[p.path] = p.id; });
      var seen = {}, body = [];
      items.forEach(function (it, i) {
        var id = String(it.id || ('i-' + day + '-' + i));
        if (seen[id]) return;
        seen[id] = 1;
        var m = it.photo && photoRe.exec(it.photo);
        body.push({
          user_id: uid, legacy_id: id, day: day, meal: Math.max(1, whole(it.meal) || 1), name: String(it.name || 'Food'),
          amount: str(it.amount), kcal: whole(it.kcal) || 0, protein: whole(it.protein) || 0, carbs: whole(it.carbs) || 0,
          fat: whole(it.fat) || 0, by: FOOD_BY[it.by] ? it.by : 'app', t: iso(it.t),
          photo_id: m ? ids[uid + '/meal/' + m[1] + '/' + m[2]] || null : null, created_at: orderStamp(day, body.length)
        });
      });
      if (body.length) await upsert('food_items', 'user_id,legacy_id', body);
      var kept = Object.keys(seen);
      await remove('food_items?day=eq.' + day + (kept.length ? '&legacy_id=not.in.' + encodeURIComponent(inList(kept)) : ''));
    }
    async function putLog(day, doc, uid) {
      var w = doc.workout;
      if (w && typeof w === 'object') {
        var wr = (await upsert('workouts', 'user_id,day', {
          user_id: uid, day: day, day_id: str(w.dayId), started_at: iso(w.startedAt), finished_at: iso(w.finishedAt),
          last_at: iso(w.lastAt), marked: !!w.marked, swaps: w.swaps || {}, extra: w.extra || null, note: str(w.note)
        }, 'id'))[0];
        await remove('sets?workout_id=eq.' + wr.id);
        var sets = [], n = 0;
        Object.keys(w.sets || {}).forEach(function (ex) {
          (w.sets[ex] || []).forEach(function (s, k) {
            sets.push({
              user_id: uid, workout_id: wr.id, exercise_id: ex, idx: k, weight_kg: num(s.w), reps: whole(s.r), done: !!s.done,
              rir: whole(s.rir), drops: Array.isArray(s.drops) && s.drops.length ? s.drops : null, created_at: orderStamp(day, n++)
            });
          });
        });
        if (sets.length) await insert('sets', sets);
      } else {
        await remove('workouts?day=eq.' + day);
      }
      var acts = (Array.isArray(doc.activities) ? doc.activities : []).map(function (a, i) {
        return {
          user_id: uid, legacy_id: String(a.id || ('a-' + day + '-' + i)), day: day, kind: String(a.kind || 'other'),
          minutes: whole(a.min) || 0, kcal: whole(a.kcal) || 0, by: String(a.by || 'app'), created_at: orderStamp(day, i)
        };
      });
      if (acts.length) await upsert('activities', 'user_id,legacy_id', acts);
      var ak = acts.map(function (a) { return a.legacy_id; });
      await remove('activities?day=eq.' + day + (ak.length ? '&legacy_id=not.in.' + encodeURIComponent(inList(ak)) : ''));
      var b = doc.bodyFat;
      if (b && num(b.pct) !== null) {
        await upsert('body_fat', 'user_id,day', {
          user_id: uid, day: day, pct: Number(b.pct), low: num(b.low), high: num(b.high), by: String(b.by || 'claude'), note: str(b.note)
        });
      } else {
        await remove('body_fat?day=eq.' + day);
      }
      // the logs row goes last: its updated_at is the version of the whole day
      await upsert('logs', 'user_id,day', {
        user_id: uid, day: day, steps: whole(doc.steps), weight_kg: num(doc.weight), note: doc.note ? String(doc.note) : '',
        measure: doc.measure && Object.keys(doc.measure).length ? doc.measure : null,
        habits: doc.habits && Object.keys(doc.habits).length ? doc.habits : null
      });
    }
    async function putProgram(doc, uid, backup) {
      var cur = (backup ? await backupProg(uid) : await activeProg(uid))[0];
      var wd = Object.keys(doc.weekdays || {}).map(function (k) { return doc.weekdays[k]; }).filter(function (v) { return v && v !== 'rest'; });
      var fields = { title: String(doc.name || 'My program'), description: backup ? BACKUP : str(doc.summary), days_per_week: wd.length || null, body: doc };
      if (cur) await write('PATCH', 'programs?id=eq.' + cur.id, fields, 'return=minimal');
      else await insert('programs', Object.assign({ author_id: uid, visibility: 'private', active: !backup }, fields));
    }
    async function putExercises(doc, uid) {
      var base = await lib('exercises'), have = base.exercises || {}, mine = {};
      Object.keys(doc.exercises || {}).forEach(function (id) { if (!have[id]) mine[id] = doc.exercises[id]; });
      var cur = (await activeProg(uid))[0];
      if (cur) await write('PATCH', 'programs?id=eq.' + cur.id, { exercises: mine }, 'return=minimal');
      else {
        var p = defaultProgram();
        await insert('programs', { author_id: uid, title: p.name, body: p, exercises: mine, visibility: 'private', active: true });
      }
    }
    async function putMeals(doc, uid) {
      var cur = await rows('saved_meals?select=id,legacy_id'), have = {};
      cur.forEach(function (r) { have[r.legacy_id || r.id] = r.id; });
      var want = {}, add = [];
      (Array.isArray(doc.meals) ? doc.meals : []).forEach(function (m) {
        if (!m || !m.id) return;
        want[m.id] = 1;
        if (have[m.id]) return;
        var its = Array.isArray(m.items) ? m.items : [];
        var sum = function (k) { return its.reduce(function (a, x) { return a + (whole(x[k]) || 0); }, 0); };
        add.push({ user_id: uid, legacy_id: String(m.id), name: String(m.name || 'Meal'), items: its, kcal: sum('kcal'), protein: sum('protein'),
          carbs: sum('carbs'), fat: sum('fat'), created_at: iso(m.t) || new Date().toISOString() });
      });
      var del = Object.keys(have).filter(function (k) { return !want[k]; }).map(function (k) { return have[k]; });
      if (add.length) await insert('saved_meals', add);
      if (del.length) await remove('saved_meals?id=in.' + encodeURIComponent('(' + del.join(',') + ')'));
    }
    // recipes and my foods: one row per id; upsert what the document holds, delete what it no longer holds
    async function syncById(table, list, toRow, uid) {
      var seen = {}, body = [];
      (Array.isArray(list) ? list : []).forEach(function (x, i) {
        if (!x || !x.id || seen[x.id]) return;
        seen[x.id] = 1;
        body.push(Object.assign({ user_id: uid, legacy_id: String(x.id), created_at: orderStamp('1970-01-01', i) }, toRow(x)));
      });
      if (body.length) await upsert(table, 'user_id,legacy_id', body);
      var kept = Object.keys(seen);
      await remove(table + (kept.length ? '?legacy_id=not.in.' + encodeURIComponent(inList(kept)) : '?id=not.is.null'));
    }
    function putRecipes(doc, uid) {
      return syncById('recipes', doc.recipes, function (r) {
        var extra = {};
        Object.keys(r).forEach(function (k) { if (RECIPE_KEYS.indexOf(k) < 0) extra[k] = r[k]; });
        return {
          name: String(r.name || 'Recipe'), servings: num(r.servings) > 0 ? num(r.servings) : 1, total_g: num(r.totalG),
          items: Array.isArray(r.items) ? r.items : [], by: String(r.by || 'app'), t: iso(r.t),
          extra: Object.keys(extra).length ? extra : null
        };
      }, uid);
    }
    function putMyFoods(doc, uid) {
      return syncById('my_foods', doc.foods, function (f) {
        var data = {};
        Object.keys(f).forEach(function (k) { if (k !== 'id' && k !== 'name') data[k] = f[k]; });
        return { name: String(f.name || 'Food'), data: data };
      }, uid);
    }

    /* ----- the contract ----- */
    var B = {
      kind: 'supabase',
      cfg: cfgIn,
      setKeepalive: function (on) { keep = !!on; },

      async tree() {
        var s = await need(), uid = s.user.id;
        var res = await Promise.all([
          rows('food_items?select=day,updated_at'), rows('logs?select=day,updated_at'), rows('photos?select=id,kind,day,path'),
          rows('profiles?select=updated_at'), activeProg(uid), backupProg(uid), rows('checkins?select=updated_at'), rows('saved_meals?select=updated_at'),
          rows('recipes?select=updated_at'), rows('my_foods?select=updated_at')
        ]);
        var m = {};
        var group = function (a) { var g = {}; a.forEach(function (r) { (g[r.day] = g[r.day] || []).push(r); }); return g; };
        var fg = group(res[0]), lg = group(res[1]);
        Object.keys(fg).forEach(function (d) { m['data/food/' + d + '.json'] = vOf(fg[d]); });
        Object.keys(lg).forEach(function (d) { m['data/log/' + d + '.json'] = vOf(lg[d]); });
        res[2].forEach(function (p) { m['data/' + (p.kind === 'meal' ? 'photos' : 'progress') + '/' + p.day + '/' + p.path.split('/').pop()] = p.id; });
        m['data/profile.json'] = vOf(res[3]) || 'none';
        m['data/program.json'] = vOf(res[4]) || 'none';
        if (res[5].length) m['data/program-backup.json'] = vOf(res[5]);
        m['data/exercises.json'] = 'lib:' + (vOf(res[4]) || '');
        m['data/foods.json'] = 'lib';
        m['data/lessons.json'] = 'lib';
        if (res[6].length) m['data/checkins.json'] = vOf(res[6]);
        if (res[7].length) m['data/meals.json'] = vOf(res[7]);
        if (res[8].length) m['data/recipes.json'] = vOf(res[8]);
        if (res[9].length) m['data/myfoods.json'] = vOf(res[9]);
        return m;
      },
      async raw(p) {
        var r = route(p);
        if (!r || r.t === 'photo') return null;
        var d = await build(r);
        return d == null ? null : JSON.stringify(d, null, 2) + '\n';
      },
      async meta(p) {
        var r = route(p);
        if (!r || r.t === 'photo') return null;
        var ver = await version(r), d = await build(r);
        return d == null ? null : { sha: ver, data: d };
      },
      async put(p, text, sha) {
        var r = route(p), doc = JSON.parse(text);
        if (!r || r.t === 'photo' || r.t === 'foods' || r.t === 'lessons' || r.t === 'checkins') throw new HttpErr(400);
        var ver = await version(r);
        if (sha && sha !== ver) throw new HttpErr(409);
        if (!sha && ver && ver !== 'none') throw new HttpErr(422);
        var s = await need(), uid = s.user.id;
        if (r.t === 'food') await putFood(r.day, doc, uid);
        else if (r.t === 'log') await putLog(r.day, doc, uid);
        else if (r.t === 'profile') await upsert('profiles', 'user_id', profToRow(doc, uid));
        else if (r.t === 'program') await putProgram(doc, uid, false);
        else if (r.t === 'backup') await putProgram(doc, uid, true);
        else if (r.t === 'exercises') await putExercises(doc, uid);
        else if (r.t === 'meals') await putMeals(doc, uid);
        else if (r.t === 'recipes') await putRecipes(doc, uid);
        else if (r.t === 'myfoods') await putMyFoods(doc, uid);
        return { sha: await version(r) };
      },
      async putBin(p, b64) {
        var r = route(p);
        if (!r || r.t !== 'photo') throw new HttpErr(400);
        var s = await need(), key = s.user.id + '/' + r.kind + '/' + r.day + '/' + r.name;
        var bin = atob(String(b64).replace(/\s/g, '')), u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        await ok(await req('POST', '/storage/v1/object/photos/' + encPath(key), { body: u, rawBody: true, headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' } }));
        var pose = r.name.split('-')[0];
        await upsert('photos', 'user_id,path', { user_id: s.user.id, kind: r.kind, day: r.day, pose: r.kind === 'progress' && POSES[pose] ? pose : null, path: key, bytes: u.length });
      },
      async delBin(p) {
        var r = route(p);
        if (!r || r.t !== 'photo') return;
        var s = await need(), key = s.user.id + '/' + r.kind + '/' + r.day + '/' + r.name;
        var x = await req('DELETE', '/storage/v1/object/photos/' + encPath(key));
        if (!x.ok && x.status !== 404 && x.status !== 400) throw new HttpErr(x.status);
        await remove('photos?path=eq.' + encodeURIComponent(key));
      },
      async meta0(p) { var r = route(p); return r ? version(r) : null; },
      async blobURL(p) {
        var r = route(p);
        if (!r || r.t !== 'photo') throw new HttpErr(404);
        var s = await need(), key = s.user.id + '/' + r.kind + '/' + r.day + '/' + r.name;
        var x = await req('GET', '/storage/v1/object/authenticated/photos/' + encPath(key));
        if (!x.ok) throw new HttpErr(x.status === 400 ? 404 : x.status);
        return URL.createObjectURL(await x.blob());
      },

      /* AI meal reads used today (the server counts per Manila day) */
      async aiUsage() { return (await rows('ai_usage?kind=eq.meal&day=eq.' + manilaDay() + '&select=id')).length; },
      /* POST to an Edge Function with the user's token. Resolves { status, data }; a network failure is the browser's TypeError. */
      async callFn(name, body, signal) {
        var c = C(), f = c.fetch || fetch, s = await need();
        var r = await f(String(c.url).replace(/\/+$/, '') + '/functions/v1/' + name, {
          method: 'POST', signal: signal, headers: { apikey: c.anonKey, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        return { status: r.status, data: data };
      },

      auth: {
        async signIn(email) {
          var cl = await client(), c = C();
          var r = await cl.auth.signInWithOtp({ email: email, options: { emailRedirectTo: c.redirectTo || (typeof location !== 'undefined' ? location.origin + location.pathname : undefined), shouldCreateUser: true } });
          if (r.error) throw new HttpErr(r.error.status || 400, r.error.message);
          return true;
        },
        // scope local: ends this phone's session only
        async signOut() {
          var cl = await client(), r = await cl.auth.signOut({ scope: 'local' });
          if (r && r.error && typeof localStorage !== 'undefined') { // the server call failed (offline): still drop the stored session
            try { Object.keys(localStorage).forEach(function (k) { if (/^sb-.+-auth-token/.test(k)) localStorage.removeItem(k); }); } catch (e) { /* ignore */ }
          }
          return null;
        },
        async user() { var s = await session(); return s && s.user ? { id: s.user.id, email: s.user.email } : null; },
        /* fn(user|null, event) on every sign in, sign out and token refresh. Starts the SDK, so call it once at boot. */
        onChange: function (fn) { subs.push(fn); client().catch(function () { /* surfaced by the first call that needs it */ }); return function () { subs = subs.filter(function (x) { return x !== fn; }); }; },
        ready: function () { return client().then(function () { return true; }); }
      }
    };
    return B;
  }

  var FormaBackend = {
    version: 2,
    HttpErr: HttpErr,
    b64enc: b64enc, b64dec: b64dec, encPath: encPath,
    create: function (kind, cfg) {
      if (kind === 'github') return github(cfg);
      if (kind === 'supabase') return supabase(cfg);
      throw new Error('Unknown backend kind: ' + kind);
    }
  };

  if (typeof window !== 'undefined') window.FormaBackend = FormaBackend;
  if (typeof module !== 'undefined' && module.exports) module.exports = FormaBackend;
})();
