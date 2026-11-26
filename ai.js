/* Pulzo AI (Claude). Portable: no DOM, no storage. It builds the request, calls the Claude API with fetch and parses
 * the answer. The caller owns the key (the app keeps it in localStorage only). Browser: window.FormaAI. Node: module.exports.
 *
 *   FormaAI.meal({ key, model, imageBase64?, text?, note?, known?, profile?, today?, fetch? })
 *       -> Promise<{ items:[{ name, amount, kcal, protein, carbs, fat, qty?, unit?, sizes?, parts?:[same, no parts] }], assumptions:[string] }>
 *   FormaAI.mealServer({ post, imageBase64?, text?, note?, units, recent? })
 *       -> Promise<{ items, assumptions, used, limit }>   signed-in path through the ai-meal Edge Function (no key on the phone)
 *   FormaAI.ask({ key, model, question, context?, history?, fetch? })
 *       -> Promise<{ text }>   Coach: a short answer (three sentences at most). context is a plain-text note of his numbers and plan,
 *          built by the app; history is the last few turns [{ role:'user'|'assistant', text }]. Personal key path.
 *   FormaAI.askServer({ post, question, context?, history? }) -> Promise<{ text, used, limit }>   same answer through ai-coach
 *   FormaAI.test({ key, model })  -> Promise<{ ok:true, text }>   one tiny request, to check the key
 *   FormaAI.testServer({ post })  -> Promise<{ ok:true, text, used, limit }>   the same check through ai-coach (mode ping)
 *       Server calls: post(body, signal) -> Promise<{ status, data }> comes from the app (FormaBackend supabase callFn, bound
 *       to the function name). Errors carry the server's own words; codes add auth, budget (monthly ceiling, 402) and
 *       daily_cap (429, with .used and .limit).
 *   FormaAI.bodyFat / FormaAI.review                              stubs, throw "not built yet"
 *
 *   model: "haiku" | "sonnet" (or a full model id). imageBase64: JPEG, raw base64 or a data: URL, under 5 MB.
 *   text: what he typed. known: foods already understood on the line [{ name, amount, kcal }], not to be repeated.
 *   note: a correction on a second ask ("half rice, no sauce").
 *   Errors are FormaAI.AIError with .code (nokey, badkey, forbidden, limit, credit, busy, network, timeout, toolarge,
 *   refused, cutoff, parse, request) and a plain-words .message; .raw holds the model text when it could not be parsed.
 *   The key is only ever sent in the x-api-key header to api.anthropic.com and is never logged or put in a URL.
 *   Raw HTTP on purpose: this is a no-build browser page. Testers use the server path (v0.19.0, DECISIONS.md); the key path
 *   stays as an Advanced option.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://api.anthropic.com/v1/messages';
  var VERSION = '2023-06-01';
  var MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
  var TIMEOUT_MS = 30000;
  var MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  function AIError(code, message, raw) {
    var e = new Error(message);
    e.name = 'AIError';
    e.code = code;
    if (raw != null) e.raw = raw;
    return e;
  }

  function modelId(m) {
    if (!m) return MODELS.haiku;
    return MODELS[m] || String(m);
  }

  var SYSTEM =
    'You estimate food for a personal calorie tracker. The user lives in the Philippines. ' +
    'Answer with JSON only: no prose, no markdown, no code fence. The shape is exactly ' +
    '{"items":[{"name":"Chicken adobo","amount":"200 g","kcal":420,"protein":38,"carbs":6,"fat":26}],"assumptions":["..."]}.\n' +
    'Rules:\n' +
    '- One item per food, not one per meal. name is short and plain. amount is a short phrase such as "200 g", "1 cup" or "2 pieces".\n' +
    '- Toppings, sauces and add-ons that belong to ONE dish are parts of it: frozen yogurt with caramel sauce is one item "Frozen yogurt with caramel" with ' +
    '"parts":[{"name":"Frozen yogurt","amount":"150 g","kcal":180,"protein":5,"carbs":32,"fat":4},{"name":"Caramel sauce","amount":"20 g","kcal":60,"protein":0,"carbs":15,"fat":0}] ' +
    'and its own numbers are the sum of the parts. Separate foods on one plate (rice and adobo) stay separate items without parts.\n' +
    '- If a brand or shop is visible or named, put it in brackets after the name: "Frozen yogurt with caramel (Seoul Krazy)". Never guess a brand.\n' +
    '- kcal, protein, carbs and fat are whole numbers (grams for the macros). kcal must be close to 4 x protein + 4 x carbs + 9 x fat.\n' +
    '- When no size is given use typical Filipino and fast-food portions (1 cup cooked rice is about 200 kcal and 45 g carbs; one Jollibee Chickenjoy thigh is about 320 kcal).\n' +
    '- From a photo, judge the portion by the plate, bowl, cup and hand size in view.\n' +
    '- Count cooking oil, sauces, dressings and drinks. They are the usual misses.\n' +
    '- Never ask a question. If something is unclear and would change the total by more than about 150 kcal, still give your best guess and state what you assumed in "assumptions" (short plain sentences, no em-dashes).\n' +
    '- If a correction note is given, it overrides what you saw or assumed.\n' +
    '- If the input has no food, return {"items":[],"assumptions":["No food found."]}.';

  var COACH_SYSTEM =
    'You are Coach inside Pulzo, a personal food, gym and steps tracker. Answer in three sentences or fewer, in plain words. ' +
    'No markdown, no lists, no headings, no em-dashes. Use his numbers below when they help and never invent numbers that are not given. ' +
    'Give at most one concrete next step. He lives in the Philippines; show money in pesos. ' +
    'For pain, injury or medical questions, say in one sentence to see a doctor or physio. ' +
    'If the question is not about food, training, steps, weight or sleep, say briefly that you only help with those.';

  function cleanB64(s) {
    s = String(s || '');
    var i = s.indexOf('base64,');
    if (i >= 0) s = s.slice(i + 7);
    return s.replace(/\s/g, '');
  }

  function b64Bytes(b64) {
    var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  function userText(o) {
    var parts = [];
    var ctx = [];
    if (o.today) ctx.push('Date: ' + o.today + '.');
    if (o.profile && o.profile.units) ctx.push('He thinks in ' + o.profile.units + '.');
    if (ctx.length) parts.push(ctx.join(' '));
    if (o.imageBase64) parts.push('Estimate the meal in this photo.' + (o.text ? '' : ' Return every food you can see.'));
    if (o.text) {
      parts.push('What he typed (voice to text, expect typos): "' + String(o.text).replace(/"/g, '\\"') + '"');
      parts.push('The line may also hold weight, steps or sport. Ignore those, only estimate foods.');
    }
    var known = (o.known || []).filter(function (k) { return k && k.name; });
    if (known.length) {
      parts.push('These foods on the line are already logged, do NOT return them again: ' +
        known.map(function (k) { return k.name + (k.amount ? ' (' + k.amount + ')' : '') + (k.kcal != null ? ' ' + k.kcal + ' kcal' : ''); }).join('; ') + '.');
      parts.push('Return only the other foods from the line.');
    }
    if (o.note) parts.push('Correction from him, follow it: "' + String(o.note).replace(/"/g, '\\"') + '"');
    parts.push('Answer with the JSON object only.');
    return parts.join('\n');
  }

  // The request exactly as it goes out: { url, headers, body }. Pure, so it can be checked without a network.
  function buildRequest(o) {
    var headers = {
      'content-type': 'application/json',
      'x-api-key': o.key,
      'anthropic-version': VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (o.ask) {
      var msgs = [];
      (o.history || []).slice(-6).forEach(function (h) {
        if (h && h.text && (h.role === 'user' || h.role === 'assistant')) {
          var last = msgs[msgs.length - 1];
          if (last && last.role === h.role) last.content += '\n' + String(h.text).slice(0, 600);
          else msgs.push({ role: h.role, content: String(h.text).slice(0, 600) });
        }
      });
      while (msgs.length && msgs[0].role !== 'user') msgs.shift();
      var lastM = msgs[msgs.length - 1];
      if (lastM && lastM.role === 'user') msgs.pop();
      msgs.push({ role: 'user', content: String(o.question).slice(0, 1500) });
      return { url: ENDPOINT, headers: headers, body: { model: modelId(o.model), max_tokens: 500, output_config: { effort: 'low' },
        system: COACH_SYSTEM + (o.context ? '\n\nHis numbers:\n' + String(o.context).slice(0, 3000) : ''), messages: msgs } };
    }
    if (o.ping) {
      return { url: ENDPOINT, headers: headers, body: { model: modelId(o.model), max_tokens: 300, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] } };
    }
    var content = [];
    if (o.imageBase64) {
      var b64 = cleanB64(o.imageBase64);
      if (b64Bytes(b64) > MAX_IMAGE_BYTES) throw AIError('toolarge', 'That photo is too big (over 5 MB). Try a smaller one.');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    }
    content.push({ type: 'text', text: userText(o) });
    return {
      url: ENDPOINT,
      headers: headers,
      body: {
        model: modelId(o.model),
        max_tokens: 4000,
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: content }]
      }
    };
  }

  function errorFor(status, data) {
    var msg = data && data.error && data.error.message ? String(data.error.message) : '';
    if (status === 401) return AIError('badkey', 'Claude says this key is wrong or was removed. Paste it again in Settings.');
    if (status === 403) return AIError('forbidden', 'This key is not allowed to use that model. Check the key in the Anthropic console.');
    if (status === 413) return AIError('toolarge', 'The photo is too big to send. Try a smaller one.');
    if (status === 429) return AIError('limit', 'Over the limit for now. Wait a minute and try again.');
    if (status === 529 || status >= 500) return AIError('busy', 'Claude is busy right now. Try again in a minute.');
    if (status === 400 && /credit balance/i.test(msg)) return AIError('credit', 'The Anthropic account is out of credit. Add credit in the Anthropic console.');
    if (status === 404) return AIError('request', 'Claude does not know that model name (' + status + ').');
    return AIError('request', 'Claude could not take that request (' + status + ').' + (msg ? ' ' + msg : ''));
  }

  async function send(o) {
    if (!o || !o.key || !String(o.key).trim()) throw AIError('nokey', 'Add your Claude API key in Settings first.');
    var key = String(o.key).trim();
    var req = buildRequest(Object.assign({}, o, { key: key }));
    var f = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw AIError('network', 'No network available here.');
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var res, data;
    try {
      res = await f(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctl ? ctl.signal : undefined });
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
      if (e && e.name === 'AbortError') throw AIError('timeout', 'Claude took longer than 30 seconds. Try again.');
      throw AIError('network', 'No connection. Check your internet and try again.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw errorFor(res.status, data);
    if (!data || !Array.isArray(data.content)) throw AIError('parse', 'Claude sent back something unexpected.', JSON.stringify(data));
    if (data.stop_reason === 'refusal') throw AIError('refused', 'Claude declined to read that. Add it by hand.');
    var text = data.content.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    if (data.stop_reason === 'max_tokens' && !text) throw AIError('cutoff', 'The answer got cut off. Try again.');
    return { text: text, model: data.model || req.body.model };
  }

  function whole(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  // One row of an answer: name, amount, four whole numbers, optional qty/unit/sizes for the portion slider and (top level
  // only) parts. A dish with 2+ parts gets the sum of its parts (handoff 070). null for a row with no name or no numbers.
  function mealRow(it, top) {
    if (!it || typeof it !== 'object') return null;
    var name = String(it.name == null ? '' : it.name).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) return null;
    var parts = top && Array.isArray(it.parts) ? it.parts.map(function (x) { return mealRow(x, false); }).filter(Boolean).slice(0, 8) : [];
    var p = whole(it.protein), c = whole(it.carbs), f = whole(it.fat), k = whole(it.kcal);
    if (parts.length >= 2) {
      k = 0; p = 0; c = 0; f = 0;
      parts.forEach(function (x) { k += x.kcal; p += x.protein; c += x.carbs; f += x.fat; });
    }
    if (!k) k = Math.round(4 * p + 4 * c + 9 * f);
    if (!k && !p && !c && !f) return null;
    var row = { name: name, amount: String(it.amount == null ? '' : it.amount).replace(/\s+/g, ' ').trim().slice(0, 60), kcal: k, protein: p, carbs: c, fat: f };
    if (typeof it.qty === 'number' && isFinite(it.qty) && it.qty > 0 && typeof it.unit === 'string' && it.unit) { row.qty = it.qty; row.unit = it.unit.slice(0, 12); }
    if (it.sizes && typeof it.sizes === 'object') {
      var sz = {};
      ['small', 'medium', 'large'].forEach(function (s) { var v = it.sizes[s]; if (typeof v === 'number' && v > 0) sz[s] = v; });
      if (Object.keys(sz).length) row.sizes = sz;
    }
    if (it.estimated) row.estimated = true;
    if (parts.length >= 2) row.parts = parts;
    return row;
  }

  // Defensive parse: fences, text around the JSON, a bare array, strings for numbers. Throws AIError('parse') with .raw.
  function parseMeal(text) {
    var raw = String(text == null ? '' : text);
    var s = raw.replace(/```(?:json)?/gi, '').trim();
    var obj = null;
    var a = s.indexOf('{'), z = s.lastIndexOf('}');
    if (a >= 0 && z > a) { try { obj = JSON.parse(s.slice(a, z + 1)); } catch (e) { obj = null; } }
    if (!obj) {
      var b = s.indexOf('['), y = s.lastIndexOf(']');
      if (b >= 0 && y > b) { try { obj = { items: JSON.parse(s.slice(b, y + 1)) }; } catch (e) { obj = null; } }
    }
    if (!obj || !Array.isArray(obj.items)) throw AIError('parse', 'Could not read the answer from Claude.', raw);
    var items = obj.items.map(function (it) { return mealRow(it, true); }).filter(Boolean);
    var notes = (Array.isArray(obj.assumptions) ? obj.assumptions : []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean).slice(0, 6);
    if (obj.items.length && !items.length) throw AIError('parse', 'Could not read the foods in the answer from Claude.', raw);
    return { items: items, assumptions: notes };
  }

  async function meal(o) {
    if (!o || (!o.imageBase64 && !(o.text && String(o.text).trim()))) throw AIError('request', 'Nothing to read. Send a photo or some text.');
    var r = await send(o);
    return parseMeal(r.text);
  }

  async function ask(o) {
    if (!o || !o.question || !String(o.question).trim()) throw AIError('request', 'Nothing to ask.');
    var r = await send(Object.assign({}, o, { ask: true }));
    var text = String(r.text || '').replace(/\u2014/g, ',').trim();
    if (!text) throw AIError('parse', 'Claude sent back an empty answer. Try again.');
    return { text: text, model: r.model };
  }

  async function test(o) {
    var r = await send({ key: o && o.key, model: o && o.model, fetch: o && o.fetch, ping: true });
    return { ok: true, text: r.text, model: r.model };
  }

  /* Server path: the app calls an Edge Function (ai-meal or ai-coach) with the user's own token, so no key is on the
   * phone and the server counts the daily caps. o.post(body, signal) -> Promise<{ status, data }> is supplied by the app.
   * The function answers its JSON or { error, code, used?, limit? } and its own words are shown as they come. */
  var SERVER_FALLBACK = {
    401: 'Your sign-in ended. Open Settings and sign in again.',
    402: 'AI budget used up for this month.',
    429: 'You have used your AI for today. Try again tomorrow.'
  };
  async function serverCall(post, body, ms, capMsg) {
    if (typeof post !== 'function') throw AIError('nokey', 'Sign in first.');
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 45000) : null;
    var res;
    try {
      res = await post(body, ctl ? ctl.signal : undefined);
    } catch (e) {
      if (e && e.name === 'AbortError') throw AIError('timeout', 'The AI took too long. Try again.');
      if (e && e.status === 401) throw AIError('auth', SERVER_FALLBACK[401]);
      throw AIError('network', 'No connection. Check your internet and try again.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    var st = res && res.status, d = (res && res.data) || {};
    if (!(st >= 200 && st < 300)) {
      var msg = typeof d.error === 'string' && d.error ? d.error : st !== 401 && typeof d.message === 'string' && d.message ? d.message : '';
      var code = d.code && typeof d.code === 'string' ? d.code : st === 401 ? 'auth' : st === 429 ? 'limit' : st === 402 ? 'budget' : st >= 500 ? 'busy' : 'request';
      if (code === 'daily_cap') code = 'limit';
      if (!msg) msg = st === 429 && capMsg ? capMsg : SERVER_FALLBACK[st] || 'The AI could not do that (' + st + '). Try again.';
      var err = AIError(code, msg);
      err.status = st;
      if (typeof d.used === 'number') err.used = d.used;
      if (typeof d.limit === 'number') err.limit = d.limit;
      throw err;
    }
    return d;
  }
  var count = function (d) { return { used: typeof d.used === 'number' ? d.used : null, limit: typeof d.limit === 'number' ? d.limit : null }; };

  async function mealServer(o) {
    if (!o || (!o.imageBase64 && !(o.text && String(o.text).trim()))) throw AIError('request', 'Nothing to read. Send a photo or some text.');
    if (!o || typeof o.post !== 'function') throw AIError('nokey', 'Sign in first.');
    var body = { units: o.units === 'lb' ? 'lb' : 'kg' };
    if (o.imageBase64) {
      var b64 = cleanB64(o.imageBase64);
      if (b64Bytes(b64) > MAX_IMAGE_BYTES) throw AIError('toolarge', 'That photo is too big (over 5 MB). Try a smaller one.');
      body.imageBase64 = b64;
    }
    if (o.text && String(o.text).trim()) body.text = String(o.text).trim();
    if (o.note) body.note = String(o.note);
    if (o.recent && o.recent.length) body.recent = o.recent.slice(0, 20);
    var d = await serverCall(o.post, body, 45000, 'You have used your AI meal reads for today. Add it by hand or try tomorrow.');
    var items = (Array.isArray(d.items) ? d.items : []).map(function (it) { return mealRow(it, true); }).filter(Boolean);
    var notes = (Array.isArray(d.assumptions) ? d.assumptions : []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean).slice(0, 8);
    return Object.assign({ items: items, assumptions: notes }, count(d));
  }

  async function askServer(o) {
    if (!o || !o.question || !String(o.question).trim()) throw AIError('request', 'Nothing to ask.');
    var hist = (o.history || []).filter(function (h) { return h && h.text && (h.role === 'user' || h.role === 'assistant'); }).slice(-6)
      .map(function (h) { return { role: h.role, text: String(h.text).slice(0, 600) }; });
    var d = await serverCall(o.post, { mode: 'ask', question: String(o.question).trim().slice(0, 1500), context: o.context ? String(o.context).slice(0, 3000) : undefined, history: hist },
      45000, 'You have used your Coach questions for today. Questions about your numbers still work.');
    var text = String(d.text == null ? '' : d.text).replace(/\u2014/g, ',').trim();
    if (!text) throw AIError('parse', 'The AI sent back an empty answer. Try again.');
    return Object.assign({ text: text }, count(d));
  }

  async function testServer(o) {
    var d = await serverCall(o && o.post, { mode: 'ping' }, 30000);
    return Object.assign({ ok: true, text: String(d.text || '') }, count(d));
  }

  function notBuilt() { throw new Error('not built yet'); }

  var api = {
    meal: meal,
    mealServer: mealServer,
    ask: ask,
    askServer: askServer,
    test: test,
    testServer: testServer,
    bodyFat: notBuilt,
    review: notBuilt,
    parseMeal: parseMeal,
    buildRequest: buildRequest,
    AIError: AIError,
    MODELS: MODELS,
    SYSTEM: SYSTEM,
    version: 2
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FormaAI = api;
})();
