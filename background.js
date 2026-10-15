// FireREST background: capture Firestore WebChannel requests, convert to REST,
// store in history, perform cross-origin sends, toggle the overlay.
const api = (typeof browser !== "undefined") ? browser : chrome;

const V1 = "https://firestore.googleapis.com/v1";
const MAX_HISTORY = 400;

console.log("[FireREST] background started.",
  "webRequest?", typeof api.webRequest,
  "onBeforeRequest?", !!(api.webRequest && api.webRequest.onBeforeRequest));

// ---------------------------------------------------------------- helpers
function decodeRawBody(raw) {
  if (!raw) return {};
  const dec = new TextDecoder("utf-8");
  let s = "";
  for (const chunk of raw) if (chunk.bytes) s += dec.decode(chunk.bytes);
  const out = {};
  for (const pair of s.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const k = decodeURIComponent(pair.slice(0, i).replace(/\+/g, " "));
    const v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
    (out[k] = out[k] || []).push(v);
  }
  return out;
}

function getForm(details) {
  const rb = details.requestBody;
  if (!rb) return {};
  if (rb.formData) return rb.formData;
  if (rb.raw) return decodeRawBody(rb.raw);
  return {};
}

function extractToken(form) {
  const h = form.headers && form.headers[0];
  if (!h) return null;
  const m = /Authorization:\s*Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : null;
}

function decodeJwt(t) {
  try {
    const seg = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (seg.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(seg + pad))));
  } catch { return null; }
}

let lastToken = null;
function handleToken(token) {
  if (!token || token === lastToken) return;   // skip the flood of identical tokens
  lastToken = token;
  const p = decodeJwt(token) || {};
  const sub = p.user_id || p.sub || token.slice(-12);
  api.storage.local.get("tokens").then((res) => {
    const tokens = res.tokens || {};
    // refresh existing entry for this user (tokens rotate ~hourly), keeping its name
    let name = Object.keys(tokens).find(n => tokens[n] && tokens[n].sub === sub);
    if (!name) {
      let base = p.email || p.role || ("user-" + String(sub).slice(0, 6));
      name = base; let i = 2;
      while (tokens[name] && tokens[name].sub !== sub) name = base + "-" + (i++);
    }
    tokens[name] = {
      value: token, sub,
      email: p.email || "", role: p.role || "",
      name_claim: p.name || "", exp: p.exp || 0, updatedAt: Date.now(),
    };
    console.log("[FireREST] token captured:", name, "role=" + (p.role || "?"), "email=" + (p.email || "?"));
    api.storage.local.set({ tokens, lastSeenToken: token });
  });
}

function collOf(name) {
  const i = name.indexOf("/documents/");
  return i < 0 ? "" : name.slice(i + 11).split("/")[0];
}

function mkCall(label, coll, method, url, body, details) {
  return {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    time: new Date().toLocaleTimeString(),
    label, collection: coll, method, url, body,
    origin: details.originUrl || details.documentUrl || "",
  };
}

function dbFromUrl(url) {
  try { return new URL(url).searchParams.get("database") || null; } catch { return null; }
}

function toRestCalls(form, details) {
  const calls = [];
  const urlDb = dbFromUrl(details.url);     // writes on an open channel omit DB from the body
  for (const k of Object.keys(form)) {
    if (!k.includes("___data__")) continue;
    const vals = Array.isArray(form[k]) ? form[k] : [form[k]];
    for (const raw of vals) {
      let obj;
      try { obj = JSON.parse(raw); } catch { continue; }
      const database = obj.database || urlDb;
      const tgt = obj.addTarget;
      if (tgt) {
        const q = tgt.query;
        if (q && q.structuredQuery) {
          const sq = q.structuredQuery;
          const coll = (sq.from || []).map(f => f.collectionId || "?").join(",");
          calls.push(mkCall(`runQuery ${coll}`, coll, "POST",
            `${V1}/${q.parent}:runQuery`,
            JSON.stringify({ structuredQuery: sq }, null, 2), details));
        }
        const docs = tgt.documents;
        if (docs && docs.documents) {
          if (database) calls.push(mkCall("batchGet", "", "POST",
            `${V1}/${database}/documents:batchGet`,
            JSON.stringify({ documents: docs.documents }, null, 2), details));
          for (const nm of docs.documents)
            calls.push(mkCall("get doc", collOf(nm), "GET", `${V1}/${nm}`, "", details));
        }
        continue;
      }
      const writes = obj.writes;
      if (writes && database) {
        calls.push(mkCall("commit", "", "POST",
          `${V1}/${database}/documents:commit`,
          JSON.stringify({ writes }, null, 2), details));
        for (const w of writes) {
          if (w.update && w.update.name) {
            const mask = w.updateMask && w.updateMask.fieldPaths;
            const qs = mask ? "?" + mask.map(fp => `updateMask.fieldPaths=${fp}`).join("&") : "";
            calls.push(mkCall("patch doc", collOf(w.update.name), "PATCH",
              `${V1}/${w.update.name}${qs}`,
              JSON.stringify({ fields: w.update.fields || {} }, null, 2), details));
          } else if (w.delete) {
            calls.push(mkCall("delete doc", collOf(w.delete), "DELETE", `${V1}/${w.delete}`, "", details));
          }
        }
      }
    }
  }
  return calls;
}

// ---------------------------------------------------------------- capture
let SEEN = 0;
try {
api.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      SEEN++;
      const isFs = details.url.includes("firestore.googleapis.com");
      if (!isFs) {
        if (SEEN % 25 === 0) console.log("[FireREST] webRequest ALIVE — total requests seen:", SEEN);
        return;
      }
      console.log("[FireREST] FIRESTORE", details.method, details.url.slice(0, 95));
      if (!/\/channel/.test(details.url)) return;
      const form = getForm(details);
      handleToken(extractToken(form));

      const calls = toRestCalls(form, details);
      console.log("[FireREST] captured", details.method, details.url.slice(0, 80),
                  "-> ops:", calls.length);
      if (!calls.length) return;

      api.storage.local.get("history").then((res) => {
        let hist = res.history || [];
        const recent = new Set(hist.slice(0, 60).map(h => h.method + h.url + h.body));
        for (const c of calls) {
          const key = c.method + c.url + c.body;
          if (recent.has(key)) continue;
          recent.add(key);
          hist.unshift(c);
        }
        if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
        api.storage.local.set({ history: hist });
      });
    } catch (e) { console.error("[FireREST] capture error", e); }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);
console.log("[FireREST] webRequest listener registered OK.");
} catch (e) {
  console.error("[FireREST] FAILED to register webRequest listener:", e);
}

// ---------------------------------------------------------------- send (cross-origin)
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "send") {
    doSend(msg.request).then(sendResponse);
    return true;
  }
});

async function doSend(req) {
  const opts = { method: req.method, headers: req.headers };
  if (req.body && !["GET", "HEAD"].includes(req.method)) opts.body = req.body;
  const t0 = performance.now();
  try {
    const r = await fetch(req.url, opts);
    const text = await r.text();
    const headers = {};
    for (const [k, v] of r.headers) headers[k] = v;
    return { ok: true, status: r.status, statusText: r.statusText,
             ms: Math.round(performance.now() - t0), headers, body: text };
  } catch (e) {
    return { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  }
}

// ---------------------------------------------------------------- toggle overlay
api.browserAction.onClicked.addListener((tab) => {
  if (tab && tab.id != null) api.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});
