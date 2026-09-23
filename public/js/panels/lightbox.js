import { $, messages, toast } from '../dom.js';
import { fpDownload } from '../files.js';
import { CAN_SHARE_FILES, IOS_HANDOFF, blobAsFile, shareFile } from '../handoff.js';
import { basenameOf } from '../render.js';

/* ======================= Picture viewer: tap a picture ====================== */
// A picture in an answer was a bare <img>: you could look at it, and to do anything
// else you scrolled to the Download box. Right-click and long-press are the
// browser's menus, not ours, and whether a phone offers one on a picture inside an
// answer — text you can select, in a home-screen app — is up to the phone. So a
// tap opens the picture on its own, full screen, with the three things people
// actually want to do with it as buttons. The <img> in the viewer is still a plain
// image, so the browser's own menu keeps working there too.
//
// Share and Copy send a PNG, redrawn here from the picture already on screen. The
// generator writes webp (see FORMAT in server/imagegen.js), and the clipboard takes
// nothing else: Chrome's async clipboard writes image/png and only image/png. PNG is
// also the one every share target opens, where a webp dropped into some apps
// arrives as a file icon. Download keeps the original bytes.
export let lightbox = $("lightbox"), lbStage = $("lbStage"), lbImg = $("lbImg");
export let lbClose = $("lbClose"), lbShare = $("lbShare"), lbCopy = $("lbCopy"), lbSave = $("lbSave");
export let lbOpen = false;

var CAN_COPY_IMAGE = (function () {
  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) return false;
    return typeof ClipboardItem.supports === "function" ? ClipboardItem.supports("image/png") : true;
  } catch (e) { return false; }
})();

var cur = null;       // { src, path, name, png: Promise<Blob>, file: File|null }
var returnFocus = null;

// The server path behind a picture, or "" when it is not one of ours. The chat
// only ever shows a generated picture through /api/thumb?path=…, so that is the
// one URL worth reading; anything else (an image a model linked from the web)
// still opens and can still be looked at, it just has nothing to download.
function serverPath(src) {
  try {
    var u = new URL(src, location.href);
    if (u.origin !== location.origin || u.pathname !== "/api/thumb") return "";
    return u.searchParams.get("path") || "";
  } catch (e) { return ""; }
}

// Redraw the picture as a PNG. It is the viewer's own <img>, same URL as the one
// tapped, so it comes from the cache and not the network. A picture from another
// origin taints the canvas and toBlob throws: that rejection is the answer.
function pngOf(img) {
  return new Promise(function (resolve, reject) {
    var draw = function () {
      try {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        c.toBlob(function (b) { if (b) resolve(b); else reject(new Error("empty")); }, "image/png");
      } catch (e) { reject(e); }
    };
    if (img.complete && img.naturalWidth) { draw(); return; }
    img.addEventListener("load", draw, { once: true });
    img.addEventListener("error", function () { reject(new Error("load")); }, { once: true });
  });
}

export function openLightbox(src, alt) {
  if (!lightbox || !src) return;
  var path = serverPath(src);
  var base = (path ? basenameOf(path) : "").replace(/\.[a-z0-9]+$/i, "") || "picture";
  lbImg.alt = alt || "";
  lbImg.src = src;
  var job = { src: src, path: path, name: base + ".png", png: null, file: null };
  cur = job;
  job.png = pngOf(lbImg);
  // Held as a File the moment it exists, so a Share tap can hand it over in the
  // same tick. iOS only opens the share sheet from inside the tap itself; awaiting
  // the conversion first would spend the tap and leave shareFile's fallback toast.
  job.png.then(function (b) { if (cur === job) job.file = blobAsFile(b, job.name); }, function () {});

  lbShare.hidden = !CAN_SHARE_FILES;
  lbCopy.hidden = !CAN_COPY_IMAGE;
  // In the home-screen app on iOS a download IS the share sheet (handoff.js), so a
  // second button there would open the same sheet with the webp in it.
  lbSave.hidden = IOS_HANDOFF;
  // Where the share sheet is the way to a phone's photo library, say so.
  lbShare.textContent = IOS_HANDOFF ? "Save or share" : "Share";
  var first = true;
  [lbShare, lbCopy, lbSave].forEach(function (b) {
    b.classList.toggle("primary", !b.hidden && first);
    if (!b.hidden) first = false;
  });

  returnFocus = document.activeElement;
  lbOpen = true;
  lightbox.classList.add("open");
  lightbox.setAttribute("aria-hidden", "false");
  // The viewer itself takes focus, not the close button: focusing a button from a
  // tap paints a focus ring on it, and on a phone that reads as a pressed ×.
  try { lightbox.focus({ preventScroll: true }); } catch (e) {}
}

export function closeLightbox() {
  if (!lbOpen) return;
  lbOpen = false;
  cur = null;
  lightbox.classList.remove("open");
  lightbox.setAttribute("aria-hidden", "true");
  lbImg.removeAttribute("src");
  if (returnFocus && returnFocus.focus) { try { returnFocus.focus({ preventScroll: true }); } catch (e) {} }
  returnFocus = null;
}

function share() {
  var job = cur;
  if (!job) return;
  if (job.file) { shareFile(job.file); return; }
  job.png.then(function (b) { shareFile(blobAsFile(b, job.name)); }, function () {
    toast("This picture cannot be shared from here", true);
  });
}

function copy() {
  var job = cur;
  if (!job) return;
  var done = function () { toast("Picture copied"); };
  var fail = function () { toast("Could not copy the picture", true); };
  // Safari keeps the tap's permission only if the ClipboardItem is built NOW with
  // the bytes still a promise; waiting for them first and then writing is refused.
  // A browser that wants the Blob itself throws here, and gets it once it exists.
  try {
    navigator.clipboard.write([new ClipboardItem({ "image/png": job.png })]).then(done, fail);
  } catch (e) {
    job.png.then(function (b) {
      return navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
    }).then(done, fail);
  }
}

function save() {
  var job = cur;
  if (!job) return;
  if (job.path) fpDownload(job.path);
  else window.open(job.src, "_blank", "noopener");
}

/* ---------------------------------- wiring -------------------------------- */

export function initLightbox() {
  if (!lightbox) return;

  // One listener for every answer, live or replayed. A picture inside a link is
  // the link's to handle.
  messages.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || t.tagName !== "IMG" || !t.closest(".md") || t.closest("a")) return;
    openLightbox(t.currentSrc || t.src, t.getAttribute("alt") || "");
  });

  lbClose.addEventListener("click", closeLightbox);
  // The dark around the picture closes it; the picture itself does not, so a
  // long-press on it can bring up the browser's own menu without the viewer
  // vanishing underneath.
  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox || e.target === lbStage) closeLightbox();
  });
  lbShare.addEventListener("click", share);
  lbCopy.addEventListener("click", copy);
  lbSave.addEventListener("click", save);

  // Capture, and stop it there: the viewer can sit on top of the Pictures panel,
  // and one Escape should close the top thing, not both.
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !lbOpen) return;
    e.stopPropagation();
    closeLightbox();
  }, true);
}
