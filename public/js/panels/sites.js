import { apiFetch } from '../api.js';

// "Sites" (drawer): every website this box is hosting right now — name, address and
// favicon — so a project is one tap away instead of a remembered port number. The
// server discovers them live (/api/sites), so a newly started site just shows up.
// Owner-only: the nav is revealed in loadProfile and the route enforces the same gate.

export function initSites() {
  (function setupSites() {
    var nav = document.getElementById("sitesNav");
    var list = document.getElementById("sitesList");
    if (!nav || !list) return;
    var loadedAt = 0, loading = false;

    nav.addEventListener("click", function () {
      var open = nav.getAttribute("aria-expanded") === "true";
      nav.setAttribute("aria-expanded", open ? "false" : "true");
      list.hidden = open;
      // The server caches its scan for ~30s; re-fetch whenever ours is older than that,
      // so a site started a minute ago is there the next time you open the list.
      if (!open && !loading && Date.now() - loadedAt > 30000) load();
    });

    function msg(text) {
      list.textContent = "";
      var p = document.createElement("div");
      p.className = "sites-msg";
      p.textContent = text;
      list.appendChild(p);
    }

    function load() {
      loading = true;
      if (!list.children.length) msg("Looking…");
      apiFetch("/api/sites", { cache: "no-store" })
        // A server that predates this route answers 404 with an HTML page, so a
        // failed parse must not surface as a JSON error inside the sidebar.
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d) throw new Error((res.d && res.d.error) || "Couldn't list the sites");
          loadedAt = Date.now();
          render(res.d.sites || [], res.d.groups || []);
        })
        .catch(function (e) { msg(e.message || "Couldn't list the sites"); })
        .then(function () { loading = false; });
    }

    function render(sites, groups) {
      if (!sites.length) return msg("Nothing hosted on this box right now.");
      list.textContent = "";
      var labels = {};
      groups.forEach(function (g) { labels[g.id] = g.label; });
      // The server hands the list back already ordered by group, so a heading each
      // time the group changes is all the sorting the sidebar has to do.
      var seen = null;
      sites.forEach(function (s) {
        if (s.group && s.group !== seen) {
          seen = s.group;
          var h = document.createElement("div");
          h.className = "site-group";
          h.textContent = labels[s.group] || s.group;
          list.appendChild(h);
        }
        var a = document.createElement("a");
        a.className = "site-row";
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = s.name + " — " + s.url + (s.published ? "" : " (only opens from this machine)");
        if (!s.published) a.dataset.local = "1";
        a.appendChild(favicon(s));
        a.appendChild(label(s));
        list.appendChild(a);
      });
    }

    function favicon(s) {
      var ic = document.createElement("span");
      ic.className = "site-ic";
      var initial = (s.name || "?").trim().charAt(0) || "?";
      if (!s.icon) { ic.textContent = initial; return ic; }
      var img = document.createElement("img");
      img.src = s.icon;
      img.alt = "";
      // A site can serve an icon the browser can't actually decode — fall back to the
      // initial rather than leaving an empty tile.
      img.addEventListener("error", function () { ic.textContent = initial; });
      ic.appendChild(img);
      return ic;
    }

    // Name over address. The address keeps its port in its own span so the ellipsis
    // eats the long tailnet hostname instead of the ":8443" that tells sites apart.
    function label(s) {
      var tx = document.createElement("span"); tx.className = "site-tx";
      var name = document.createElement("span"); name.className = "site-name"; name.textContent = s.name;
      var addr = String(s.url).replace(/^https?:\/\//, "");
      var cut = addr.lastIndexOf(":");
      var url = document.createElement("span"); url.className = "site-url";
      var host = document.createElement("span"); host.className = "site-host";
      var port = document.createElement("span"); port.className = "site-port";
      host.textContent = cut > 0 ? addr.slice(0, cut) : addr;
      port.textContent = cut > 0 ? addr.slice(cut) : "";
      url.appendChild(host); url.appendChild(port);
      tx.appendChild(name); tx.appendChild(url);
      return tx;
    }
  })();
}
