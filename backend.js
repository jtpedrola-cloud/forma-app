/* Forma backend adapter (skeleton). Portable: no DOM needed except URL.createObjectURL in blobURL, no storage, no
 * app globals. Plain script, sets window.FormaBackend. Node: module.exports = FormaBackend.
 *
 *   var B = FormaBackend.create(kind, cfg)
 *
 *   kind 'github'   cfg = { repo: 'owner/name', token, branch?: 'main', fetch?: fetchFn }
 *                   cfg may also be a FUNCTION returning that object, read on every call. Use it in index.html
 *                   because the app reassigns its `cfg` variable (setup, sign out): FormaBackend.create('github',()=>cfg).
 *   kind 'supabase' cfg = { url, anonKey }. A stub: every method rejects with Error('Supabase backend not set up yet').
 *                   Schema and plan: docs/specs/backend.md.
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
 *       github: all three resolve null (the token in Settings is the identity). supabase: all three throw.
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

  /* ---------- Supabase (not set up yet; see docs/specs/backend.md) ---------- */
  var NOT_READY = 'Supabase backend not set up yet';
  function supabase(cfgIn) {
    var no = async function () { throw new Error(NOT_READY); };
    return {
      kind: 'supabase',
      cfg: cfgIn,
      setKeepalive: function () { throw new Error(NOT_READY); },
      tree: no, raw: no, meta: no, put: no, putBin: no, delBin: no, meta0: no, blobURL: no,
      auth: { signIn: no, signOut: no, user: no }
    };
  }

  var FormaBackend = {
    version: 1,
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
