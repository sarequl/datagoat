/*! DataGoat Shopify storefront loader | MIT */
// Installed on the storefront as a Shopify ScriptTag by POST /api/apps/shopify/connect:
//   <script src="https://<datagoat>/apps/shopify.js?id=<tracking id>[&domain=<domain>][&goals=0]">
// 1. Loads the DataGoat tracker from the same origin with data-website-id / data-domain /
//    data-api-url, unless the theme already has a tracker tag.
// 2. Copies the visitor and session cookies into hidden cart attributes
//    (_datagoat_visitor_id, _datagoat_session_id), which Shopify copies onto the order's
//    note_attributes, so the order is attributed to the visit.
// 3. Sends the add_to_cart and initiate_checkout goals (disable with &goals=0 when the custom
//    pixel sends them).
// Served as a static asset: loading it costs no Worker request.
(() => {
  const me = document.currentScript;
  if (!me?.src || window.__datagoatShopify) return;
  let src;
  try {
    src = new URL(me.src);
  } catch (_e) {
    return;
  }
  const id = src.searchParams.get("id");
  if (!id) return;
  window.__datagoatShopify = true;
  const origin = src.origin;
  const goals = src.searchParams.get("goals") !== "0";
  const domain = src.searchParams.get("domain") || location.hostname.replace(/^www\./, "");

  if (!window.datagoat && !window.datafast) {
    const queue = (...args) => {
      queue.q = queue.q || [];
      queue.q.push(args);
    };
    window.datagoat = window.datafast = queue;
  }
  if (!document.querySelector("script[data-website-id]")) {
    const tag = document.createElement("script");
    tag.defer = true;
    tag.src = `${origin}/js/script.js`;
    tag.setAttribute("data-website-id", id);
    tag.setAttribute("data-domain", domain);
    tag.setAttribute("data-api-url", `${origin}/api/events`);
    (document.head || document.documentElement).appendChild(tag);
  }

  function cookie(name) {
    const parts = document.cookie ? document.cookie.split("; ") : [];
    for (let i = 0; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (parts[i].slice(0, eq) === name) return decodeURIComponent(parts[i].slice(eq + 1));
    }
    return "";
  }
  // Our cookie first, then DataFast's (stores that switched, or data-compat="datafast").
  const idCookie = (key) => cookie(`datagoat_${key}`) || cookie(`datafast_${key}`);

  const SYNC_KEY = "datagoat_cart_attributes";
  function syncCart(force) {
    const vid = idCookie("visitor_id");
    if (!vid) return false;
    const sid = idCookie("session_id");
    const value = `${vid}|${sid}`;
    try {
      if (!force && sessionStorage.getItem(SYNC_KEY) === value) return true;
    } catch (_e) {}
    const nativeFetch = window.__datagoatNativeFetch || window.fetch;
    nativeFetch
      .call(window, "/cart/update.js", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          attributes: { _datagoat_visitor_id: vid, _datagoat_session_id: sid },
        }),
      })
      .then((res) => {
        if (res.ok) {
          try {
            sessionStorage.setItem(SYNC_KEY, value);
          } catch (_e) {}
        }
      })
      .catch(() => {});
    return true;
  }
  let tries = 0;
  function poll() {
    if (!syncCart(false) && tries++ < 40) setTimeout(poll, 250);
  }
  poll();

  if (!goals) return;
  const lastGoal = {};
  function goal(name) {
    const now = Date.now();
    if (lastGoal[name] && now - lastGoal[name] < 2000) return;
    lastGoal[name] = now;
    (window.datagoat || window.datafast)(name);
  }
  function isCartAdd(url) {
    return typeof url === "string" && /\/cart\/add(\.js)?(\?|$)/.test(url.split("#")[0]);
  }
  function onAdded() {
    goal("add_to_cart");
    syncCart(true);
  }

  // AJAX carts (fetch and XMLHttpRequest).
  if (window.fetch && !window.__datagoatNativeFetch) {
    const original = window.fetch;
    window.__datagoatNativeFetch = original;
    window.fetch = function (...args) {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url;
      const result = original.apply(this, args);
      if (isCartAdd(url)) {
        result.then((res) => {
          if (res?.ok) onAdded();
        });
      }
      return result;
    };
  }
  if (window.XMLHttpRequest) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
      if (isCartAdd(String(args[1]))) {
        this.addEventListener("load", function () {
          if (this.status >= 200 && this.status < 300) onAdded();
        });
      }
      return open.apply(this, args);
    };
  }
  // Classic form posts that navigate (themes that prevent the default use AJAX, caught above).
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || event.defaultPrevented) return;
    const action = form.getAttribute("action") || "";
    if (isCartAdd(action)) goal("add_to_cart");
  });
  document.addEventListener(
    "click",
    (event) => {
      let el = event.target;
      while (el && el !== document) {
        if (el.matches?.('[name="checkout"], a[href*="/checkout"]')) {
          goal("initiate_checkout");
          return;
        }
        el = el.parentNode;
      }
    },
    true,
  );
})();
