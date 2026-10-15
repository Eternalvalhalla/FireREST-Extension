// FireREST overlay content script: a draggable in-page panel.
(() => {
  if (window.__fireRestLoaded) return;        // guard against double-injection
  window.__fireRestLoaded = true;
  const api = (typeof browser !== "undefined") ? browser : chrome;
  console.log("[FireREST] overlay content script injected on", location.href);

  let TOKENS = {}, ACTIVE = null, SELECTED = null, HISTORY = [];
  let shadow, panel;

  const CSS = `
    :host { all: initial; }
    .launch { position:fixed; right:16px; bottom:16px; z-index:2147483646;
      width:42px; height:42px; border-radius:50%; background:#ff8c42; color:#1a1a1a;
      border:none; font-size:20px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.4); }
    .wrap { position:fixed; right:16px; bottom:70px; z-index:2147483647; width:470px;
      max-height:82vh; display:none; flex-direction:column; background:#1e1e2e; color:#e4e6f1;
      border:1px solid #3a3d55; border-radius:9px; box-shadow:0 8px 30px rgba(0,0,0,.5);
      font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden; }
    .wrap.open { display:flex; }
    .bar { display:flex; align-items:center; gap:6px; padding:8px 10px; background:#27293d;
      border-bottom:1px solid #3a3d55; cursor:move; }
    .bar strong { flex:1; }
    .body { padding:10px; overflow:auto; }
    button { background:#27293d; color:#e4e6f1; border:1px solid #3a3d55; border-radius:5px;
      padding:4px 8px; cursor:pointer; font:inherit; }
    button:hover { border-color:#ff8c42; }
    button.primary { background:#ff8c42; color:#1a1a1a; border-color:#ff8c42; font-weight:600; }
    input,select,textarea { background:#15161f; color:#e4e6f1; border:1px solid #3a3d55;
      border-radius:5px; padding:4px 6px; font:inherit; width:100%; }
    textarea { resize:vertical; }
    .row { display:flex; gap:6px; margin-bottom:7px; align-items:center; }
    .row>label { min-width:58px; color:#9aa0c0; }
    .grow { flex:1; }
    .muted { color:#9aa0c0; font-size:11px; word-break:break-all; }
    .tag { background:#343757; border-radius:4px; padding:1px 6px; font-size:11px; }
    .method { font-weight:700; margin-right:5px; }
    .m-GET{color:#6cc5ff;} .m-POST{color:#5fd98a;} .m-PATCH{color:#ffd166;} .m-DELETE{color:#ff6b6b;}
    .hist { max-height:170px; overflow:auto; border:1px solid #3a3d55; border-radius:6px; margin-bottom:8px; }
    .hi { padding:6px 8px; border-bottom:1px solid #2b2d42; cursor:pointer; }
    .hi:hover { background:#2d2f45; } .hi.sel { background:#343757; border-left:3px solid #ff8c42; }
    #resp { white-space:pre-wrap; background:#141520; border:1px solid #3a3d55; border-radius:5px;
      padding:7px; max-height:30vh; overflow:auto; }
    table { border-collapse:collapse; width:100%; margin-top:6px; }
    td,th { border:1px solid #3a3d55; padding:3px 6px; text-align:left; }
    .s2{color:#5fd98a;} .s4,.s5,.sE{color:#ff6b6b;} .s3{color:#ffd166;}
    details{margin-top:6px;} summary{cursor:pointer;color:#9aa0c0;}
    h3{margin:10px 0 5px;}
  `;

  const HTML = `
    <button class="launch" title="FireREST">🔥</button>
    <div class="wrap">
      <div class="bar" id="bar">
        <strong>🔥 FireREST <span class="muted" id="count"></span></strong>
        <button id="clear">Clear</button>
        <button id="close">✕</button>
      </div>
      <div class="body">
        <div class="row">
          <select id="tokenSel" style="width:150px;"></select>
          <input id="tokName" placeholder="name" style="width:90px;">
          <input id="tokVal" placeholder="bearer token" class="grow">
          <button id="tokSave" title="save / rename selected">💾</button>
          <button id="tokDel" title="delete selected">−</button>
        </div>
        <div id="tokinfo" class="muted" style="margin:-3px 0 8px;"></div>
        <div class="hist" id="hist"></div>
        <div class="row">
          <select id="method" style="width:95px;">
            <option>GET</option><option>POST</option><option>PATCH</option>
            <option>DELETE</option><option>PUT</option>
          </select>
          <input id="url" class="grow" placeholder="https://firestore.googleapis.com/v1/...">
        </div>
        <div class="row" style="align-items:flex-start;">
          <label>Headers</label>
          <textarea id="headers" rows="2" class="grow"></textarea>
        </div>
        <div class="row" style="align-items:flex-start;">
          <label>Body</label>
          <textarea id="reqbody" rows="7" class="grow"></textarea>
        </div>
        <div class="row" style="flex-wrap:wrap;">
          <button id="send" class="primary">▶ Send</button>
          <button id="compare">⇄ Compare tokens</button>
          <button id="strip" title="remove where filter, limit=500 (IDOR probe)">∅ Strip filter</button>
          <button id="curl">curl</button>
          <span id="status" class="muted"></span>
        </div>
        <h3>Response</h3>
        <div id="resp" class="muted">— send a request —</div>
        <div id="matrixWrap" style="display:none;"><h3>Access-control matrix</h3><table id="matrix"></table></div>
        <details><summary>help</summary>
          <div class="muted" style="margin-top:5px;">
            Use <b>{{token}}</b> in headers/body/url (replaced by selected token); any saved token by name too, e.g. <b>{{admin}}</b>.
            <b>Compare tokens</b> fires this request once per saved token → quick access-control check.
            If history stays empty: open the add-on's background console (about:debugging → FireREST → Inspect) and watch for <b>[FireREST] captured</b> logs while using the app.
          </div>
        </details>
      </div>
    </div>`;

  // ----------------------------------------------------------- build
  function closeAllPanels() {
    // close panels in EVERY overlay host (incl. orphans from prior ext reloads)
    document.querySelectorAll("#firerest-host").forEach((h) => {
      const p = h.shadowRoot && h.shadowRoot.querySelector(".wrap");
      if (p) p.classList.remove("open");
    });
  }

  function build() {
    // remove any orphaned overlays left by a previous content-script sandbox
    document.querySelectorAll("#firerest-host").forEach((e) => e.remove());

    const host = document.createElement("div");
    host.id = "firerest-host";
    (document.documentElement || document.body).appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    const div = document.createElement("div");
    div.innerHTML = HTML;
    shadow.appendChild(div);
    panel = shadow.querySelector(".wrap");

    shadow.querySelector(".launch").onclick = toggle;
    q("#close").onclick = closeAllPanels;   // closes this panel + any orphans
    q("#clear").onclick = async () => { await api.storage.local.set({ history: [] }); SELECTED = null; };
    wireTokens(); wireActions(); makeDraggable(q("#bar"));
  }
  const q = (sel) => shadow.querySelector(sel);
  function toggle() { panel.classList.toggle("open"); }

  // ----------------------------------------------------------- history
  function renderHistory() {
    const box = q("#hist");
    q("#count").textContent = "(" + HISTORY.length + ")";
    box.innerHTML = "";
    if (!HISTORY.length) {
      box.innerHTML = '<div class="muted" style="padding:8px;">No ops captured yet. Browse the target app with this overlay active.</div>';
      return;
    }
    for (const c of HISTORY) {
      const el = document.createElement("div");
      el.className = "hi" + (c.id === SELECTED ? " sel" : "");
      el.innerHTML = `<span class="method m-${c.method}">${c.method}</span>` +
        `<span class="tag">${c.collection || c.label}</span> <span class="muted">${c.time}</span>` +
        `<div class="muted">${c.url.replace("https://firestore.googleapis.com/v1/", "…/")}</div>`;
      el.onclick = () => { SELECTED = c.id; loadEditor(c); renderHistory(); };
      box.appendChild(el);
    }
  }
  function loadEditor(c) {
    q("#method").value = c.method;
    q("#url").value = c.url;
    const h = ["Authorization: Bearer {{token}}"];
    if (c.body) h.push("Content-Type: application/json");
    q("#headers").value = h.join("\n");
    q("#reqbody").value = c.body || "";
    q("#status").textContent = c.origin ? "src: " + c.origin : "";
  }

  // ----------------------------------------------------------- tokens
  function normalizeTokens(obj) {
    const out = {};
    for (const [n, v] of Object.entries(obj || {}))
      out[n] = (typeof v === "string") ? { value: v } : v;   // migrate old {name:string}
    return out;
  }
  function tokVal(name) { const e = TOKENS[name]; return e ? e.value : ""; }
  function expLeft(e) {
    if (!e || !e.exp) return "";
    const s = e.exp - Math.floor(Date.now() / 1000);
    return s > 0 ? `exp in ${Math.floor(s / 60)}m` : "EXPIRED";
  }
  function renderTokens() {
    const sel = q("#tokenSel"); sel.innerHTML = "";
    const names = Object.keys(TOKENS);
    if (!names.length) {
      const o = document.createElement("option"); o.textContent = "(no tokens yet)"; o.disabled = true; sel.appendChild(o);
      q("#tokinfo").textContent = "Browse the app — captured JWTs appear here automatically.";
      return;
    }
    if (!ACTIVE || !TOKENS[ACTIVE]) ACTIVE = names[0];
    for (const n of names) {
      const e = TOKENS[n];
      const o = document.createElement("option"); o.value = n;
      o.textContent = n + (e.role ? ` [${e.role}]` : "");
      if (n === ACTIVE) o.selected = true; sel.appendChild(o);
    }
    showTokInfo();
  }
  function showTokInfo() {
    const e = TOKENS[ACTIVE] || {};
    const bits = [];
    if (e.role) bits.push("role=" + e.role);
    if (e.email) bits.push(e.email);
    const x = expLeft(e); if (x) bits.push(x);
    q("#tokinfo").innerHTML = bits.length
      ? bits.join(" · ") + (x === "EXPIRED" ? ' <span class="s4">(refresh in app)</span>' : "")
      : "custom token";
  }
  async function saveTokens() { await api.storage.local.set({ tokens: TOKENS, activeToken: ACTIVE }); }
  function fillEditor(name) { q("#tokName").value = name || ""; q("#tokVal").value = tokVal(name); }
  function wireTokens() {
    q("#tokSave").onclick = async () => {       // save new OR rename/edit the selected
      const newName = q("#tokName").value.trim(), v = q("#tokVal").value.trim();
      if (!newName || !v) { q("#status").textContent = "name and token required"; return; }
      const meta = TOKENS[ACTIVE] || {};
      if (ACTIVE && TOKENS[ACTIVE] && ACTIVE !== newName) delete TOKENS[ACTIVE];  // rename
      TOKENS[newName] = { value: v, sub: meta.sub || "", email: meta.email || "",
                          role: meta.role || "", exp: meta.exp || 0, updatedAt: Date.now() };
      ACTIVE = newName; await saveTokens(); renderTokens();
      q("#status").textContent = "saved: " + newName;
    };
    q("#tokDel").onclick = async () => {
      const n = q("#tokenSel").value;
      if (TOKENS[n]) { delete TOKENS[n]; ACTIVE = Object.keys(TOKENS)[0] || null; await saveTokens(); renderTokens(); fillEditor(ACTIVE); }
    };
    q("#tokenSel").onchange = async () => { ACTIVE = q("#tokenSel").value; fillEditor(ACTIVE); showTokInfo(); await saveTokens(); };
  }

  // ----------------------------------------------------------- substitution / send
  function subst(str, override) {
    if (!str) return str;
    const act = override !== undefined ? override : (ACTIVE ? tokVal(ACTIVE) : "");
    str = str.replace(/\{\{token\}\}/g, act || "");
    for (const n of Object.keys(TOKENS))
      str = str.replace(new RegExp("\\{\\{" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\}\\}", "g"), tokVal(n));
    return str;
  }
  function parseHeaders(text, override) {
    const out = {};
    for (const line of text.split("\n")) {
      const i = line.indexOf(":"); if (i < 0) continue;
      const k = line.slice(0, i).trim(); if (!k) continue;
      out[k] = subst(line.slice(i + 1).trim(), override);
    }
    return out;
  }
  function buildReq(override) {
    const method = q("#method").value;
    let body = subst(q("#reqbody").value, override);
    if (["GET", "HEAD"].includes(method)) body = "";
    return { method, url: subst(q("#url").value.trim(), override), headers: parseHeaders(q("#headers").value, override), body };
  }
  async function send(override) { return api.runtime.sendMessage({ type: "send", request: buildReq(override) }); }
  function pretty(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }

  function wireActions() {
    q("#send").onclick = async () => {
      q("#status").textContent = "sending…"; q("#matrixWrap").style.display = "none";
      const res = await send();
      if (!res.ok) { q("#resp").textContent = "ERROR: " + res.error; q("#status").textContent = ""; return; }
      q("#status").innerHTML = `<span class="s${String(res.status)[0]}">${res.status} ${res.statusText}</span> · ${res.ms}ms · ${res.body.length}b`;
      q("#resp").textContent = pretty(res.body);
    };
    q("#compare").onclick = async () => {
      const names = Object.keys(TOKENS);
      if (!names.length) { q("#status").textContent = "add tokens first"; return; }
      const tbl = q("#matrix");
      tbl.innerHTML = "<tr><th>token</th><th>status</th><th>ms</th><th>size</th><th>note</th></tr>";
      q("#matrixWrap").style.display = "block"; q("#status").textContent = "comparing…";
      for (const n of names) {
        const res = await send(tokVal(n));
        let note = "";
        if (res.ok) { try { const j = JSON.parse(res.body); note = (j.error && j.error.status) || (Array.isArray(j) && j[0] && j[0].document ? "has doc" : ""); } catch {} }
        const sc = res.ok ? String(res.status) : "E";
        const tr = document.createElement("tr");
        const lbl = n + (TOKENS[n] && TOKENS[n].role ? ` [${TOKENS[n].role}]` : "");
        tr.innerHTML = `<td>${lbl}</td><td class="s${sc[0]}">${res.ok ? res.status : "ERR"}</td>` +
          `<td>${res.ms || ""}</td><td>${res.ok ? res.body.length : ""}</td><td class="muted">${note || (res.error || "")}</td>`;
        tbl.appendChild(tr);
      }
      q("#status").textContent = "compare done";
    };
    q("#strip").onclick = () => {
      try { const b = JSON.parse(q("#reqbody").value);
        if (b.structuredQuery) { delete b.structuredQuery.where; b.structuredQuery.limit = 500;
          q("#reqbody").value = JSON.stringify(b, null, 2); q("#status").textContent = "filter stripped, limit=500"; }
        else q("#status").textContent = "no structuredQuery";
      } catch { q("#status").textContent = "body not JSON"; }
    };
    q("#curl").onclick = () => {
      const r = buildReq();
      let c = `curl -s -X ${r.method} '${r.url}'`;
      for (const [k, v] of Object.entries(r.headers)) c += ` \\\n  -H '${k}: ${v}'`;
      if (r.body) c += ` \\\n  -d '${r.body.replace(/'/g, "'\\''")}'`;
      navigator.clipboard.writeText(c); q("#status").textContent = "curl copied";
    };
  }

  // ----------------------------------------------------------- drag
  function makeDraggable(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = "auto"; panel.style.bottom = "auto";
      panel.style.left = ox + "px"; panel.style.top = oy + "px"; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + "px";
      panel.style.top = (oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  // ----------------------------------------------------------- init
  async function init() {
    build();
    const r = await api.storage.local.get(["history", "tokens", "activeToken"]);
    HISTORY = r.history || []; TOKENS = normalizeTokens(r.tokens); ACTIVE = r.activeToken || Object.keys(TOKENS)[0] || null;
    console.log("[FireREST] overlay init — history loaded:", HISTORY.length, "tokens:", Object.keys(TOKENS).length);
    renderTokens(); renderHistory();
    api.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.history) { HISTORY = ch.history.newValue || []; renderHistory(); }
      if (ch.tokens) {
        TOKENS = normalizeTokens(ch.tokens.newValue);
        const editing = shadow.activeElement && (shadow.activeElement.id === "tokName" || shadow.activeElement.id === "tokVal");
        renderTokens();
        if (!editing) fillEditor(ACTIVE);   // don't clobber a field you're typing in
      }
    });
    api.runtime.onMessage.addListener((m) => { if (m && m.type === "toggle") toggle(); });
  }
  init();
})();
