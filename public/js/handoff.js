import { apiFetch } from './api.js';
import { toast } from './dom.js';

/* ---------- Getting a file onto this device ---------- */
// An iOS home-screen web app has NO download manager: it drops both
// Content-Disposition: attachment and the <a download> attribute on the floor,
// so a Download tap there looked like it did nothing at all. The share sheet is
// the only hand-off that works — and it's the better one anyway, since it offers
// Quick Look preview and "Save to Files". Every other browser keeps the plain
// download, which it handles properly (and which Android/desktop users expect).
export let IOS_APP = (function () {
  var ua = navigator.userAgent || "";
  // iPadOS asks for the desktop site, so it only gives itself away by touch.
  var ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (!ios) return false;
  if (navigator.standalone === true) return true;
  try { return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches); }
  catch (e) { return false; }
})();
export let CAN_SHARE_FILES = (function () {
  try {
    return !!(navigator.share && navigator.canShare &&
      navigator.canShare({ files: [new File(["probe"], "probe.txt", { type: "text/plain" })] }));
  } catch (e) { return false; }
})();
export let IOS_HANDOFF = IOS_APP && CAN_SHARE_FILES;

export function clickDownloadLink(url) {
  var a = document.createElement("a");
  a.href = url; a.rel = "noopener";
  document.body.appendChild(a); a.click();
  setTimeout(function () { a.remove(); }, 0);
}

export function blobAsFile(blob, name) {
  return new File([blob], name, { type: (blob && blob.type) || "application/octet-stream" });
}

// Open the share sheet for a file we already hold. share() needs a live user
// gesture, and the fetch/conversion that produced the bytes may have outlived
// it — so when iOS refuses, park the file behind a tappable toast instead of
// failing silently, which is the very thing we're fixing.
export function shareFile(file) {
  var open = function () {
    return navigator.share({ files: [file] }).catch(function (err) {
      if (err && err.name === "AbortError") return; // sheet dismissed — not a failure
      throw err;
    });
  };
  open().catch(function (err) {
    if (err && err.name === "NotAllowedError") {
      toast(file.name + " is ready — tap to save", false, function () {
        open().catch(function () { toast("Could not open the share sheet", true); });
      });
      return;
    }
    toast("Could not open the share sheet", true);
  });
}

// Read the real filename off the response, so a folder keeps its .zip suffix and
// a CJK name survives (filename* is the UTF-8 one; plain filename is the fallback).
export function dispositionName(cd) {
  if (!cd) return "";
  var star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) {} }
  var m = cd.match(/filename\s*=\s*"([^"]*)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
  return m ? m[1].trim() : "";
}

export function fetchAndShare(url, label, init) {
  var opts = init || {};
  opts.credentials = "same-origin";
  toast("Preparing " + label + "…");
  apiFetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error("Download failed (" + r.status + ")");
    var name = dispositionName(r.headers.get("Content-Disposition")) || label;
    return r.blob().then(function (b) { return blobAsFile(b, name); });
  }).then(shareFile).catch(function (e) {
    toast(e.message || "Download failed", true);
  });
}

// The single entry point for "put this server file on the device".
export function handOffUrl(url, label) {
  if (!IOS_APP) { clickDownloadLink(url); return; }
  // iOS with no share sheet at all (pre-15): bounce it to real Safari, which
  // does have a download manager, rather than leaving the tap dead.
  if (!CAN_SHARE_FILES) { window.open(url, "_blank"); return; }
  fetchAndShare(url, label || "file");
}

// For places that are a real <a download> in the markup: keep the link (so it
// stays a long-pressable, middle-clickable link everywhere) and only divert the
// tap where the attribute is ignored.
export function iosifyLink(a, label) {
  if (IOS_APP) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      handOffUrl(a.getAttribute("href"), label);
    });
  }
  return a;
}
