// PlumiChat service worker — intentionally minimal.
// Two jobs: (1) show notifications — both the ones the page hands us via
// registration.showNotification() and the ones the SERVER pushes with real Web
// Push (the only kind that can arrive while iOS has the app suspended), and
// (2) put the tap back into the CHAT app. It deliberately does NOT cache or
// intercept fetches — the app is always served fresh from the network.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

// Only "/" is the chat app. settings.html / operations.html / grid.html have no
// "plumi:open" listener, so focusing one of them used to swallow the tap
// entirely — the notification closed and nothing happened.
function isChatClient(url) {
  try {
    var p = new URL(url, self.location.origin).pathname;
    return p === "/" || p === "/index.html";
  } catch (e) { return false; }
}

// The push payload carries the destination as a URL; page-generated
// notifications carry {project, key}. Normalise both to one target URL.
function targetUrl(data) {
  if (data.url) return data.url;
  var q = [];
  if (data.project) q.push("project=" + encodeURIComponent(data.project));
  if (data.key) q.push("c=" + encodeURIComponent(data.key));
  return q.length ? "/?" + q.join("&") : "/";
}

// …and back the other way, so a pushed notification can still tell an ALREADY
// OPEN chat which conversation to switch to (it listens for {project, key}).
function convOf(data) {
  var project = data.project || "", key = data.key || "";
  if (!project && !key && data.url) {
    try {
      var u = new URL(data.url, self.location.origin);
      project = u.searchParams.get("project") || "";
      key = u.searchParams.get("c") || "";
    } catch (e) {}
  }
  return { project: project, key: key };
}

// Server-sent Web Push. Payload is exactly {title, body, tag, url, at}; every
// field is treated as optional so a future sender can add or drop one without
// this file needing a deploy.
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { try { d = { body: e.data.text() }; } catch (e2) { d = {}; } }
  var opts = {
    body: d.body || "",
    // Same tag as the page's own pings, so a push and a foreground ping for the
    // same turn replace each other instead of stacking.
    tag: d.tag || "plumi-turn-done",
    renotify: true,
    icon: "/favicon-512.png",
    badge: "/favicon-100.png",
    data: { url: d.url || "/" }
  };
  if (d.at) opts.timestamp = d.at;
  e.waitUntil(self.registration.showNotification(d.title || "PlumiChat", opts));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var data = e.notification.data || {};
  var url = targetUrl(data);
  var conv = convOf(data);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (!isChatClient(client.url) || !("focus" in client)) continue;
        if ((conv.project || conv.key) && "postMessage" in client) {
          client.postMessage({ type: "plumi:open", project: conv.project, key: conv.key, url: url });
        }
        return client.focus();
      }
      // No chat window open (or only Settings/Operations/Grid) — open one.
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
