import { apiFetch } from '../api.js';
import { $, toast, pref } from '../dom.js';
import { closeDrawer } from '../library.js';

/* ======================= Pictures: make one locally ====================== */
// The everyday door to the image generator. Deliberately small: a description, a
// shape, a button. Everything else is behind "More settings", because on a turbo
// model the prompt decides the picture and the sliders mostly do not.
//
// Generation is a job, not a request. The server hands back an id and this polls
// it — a phone that locks its screen mid-picture would otherwise drop a held-open
// connection and lose a picture that was already being drawn.
//
// Nothing here names a folder. The server derives it from the signed-in account,
// which is what lets a member use this panel at all.
export let imagesNav = $("imagesNav"), studioNav = $("studioNav");
export let imgModal = $("imgModal"), imgOverlay = $("imgOverlay"), imgClose = $("imgClose");
export let imgPrompt = $("imgPrompt"), imgGo = $("imgGo"), imgStage = $("imgStage");
export let imgShapes = $("imgShapes"), imgEngine = $("imgEngine"), imgMore = $("imgMore");
export let imgModelRow = $("imgModelRow"), imgModel = $("imgModel"), imgNegative = $("imgNegative");
export let imgSeed = $("imgSeed"), imgSteps = $("imgSteps"), imgStepsOut = $("imgStepsOut");
export let imgRecent = $("imgRecent"), imgStrip = $("imgStrip");
export let imgOpen = false;

let presets = null;      // { models: [...] } once /api/image/presets has answered
let poll = null;         // interval id while a job is running
let shape = "square";
let lastSeed = 0;

const POLL_MS = 900;

/* --------------------------------- opening -------------------------------- */

export function openImages() {
  imgOpen = true;
  closeDrawer();
  imgOverlay.classList.add("open");
  imgModal.classList.add("open");
  imgModal.setAttribute("aria-hidden", "false");
  loadPresets();
  loadRecent();
  setTimeout(function () { try { imgPrompt.focus(); } catch (e) {} }, 60);
}

export function closeImages() {
  imgOpen = false;
  imgOverlay.classList.remove("open");
  imgModal.classList.remove("open");
  imgModal.setAttribute("aria-hidden", "true");
  // The job keeps running on the server; only the watching stops.
  stopPoll();
}

function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

/* --------------------------------- presets -------------------------------- */

function loadPresets() {
  if (presets) return Promise.resolve(presets);
  return apiFetch("/api/image/presets").then(function (r) { return r.json(); }).then(function (p) {
    presets = p;
    if (!p.ok) { stageMessage(p.reason || "Picture making is not set up on this machine."); return p; }
    // A model picker for one model is furniture. It appears the day a second one
    // is installed, from the server's own list.
    if (p.models.length > 1) {
      imgModelRow.hidden = false;
      imgModel.innerHTML = "";
      p.models.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.id; o.textContent = m.label;
        imgModel.appendChild(o);
      });
      var saved = pref("imageModel");
      if (saved && p.models.some(function (m) { return m.id === saved; })) imgModel.value = saved;
    }
    applyModelDefaults();
    paintEngine(p.engine);
    return p;
  }).catch(function () { stageMessage("Could not reach the server."); return null; });
}

function currentModel() {
  if (!presets || !presets.models || !presets.models.length) return null;
  var id = imgModelRow.hidden ? presets.models[0].id : imgModel.value;
  return presets.models.find(function (m) { return m.id === id; }) || presets.models[0];
}

function applyModelDefaults() {
  var m = currentModel();
  if (!m) return;
  imgSteps.value = String(m.steps);
  imgStepsOut.textContent = String(m.steps);
}

function paintEngine(e) {
  if (!e) return;
  // Lent to a render (server/imagegen.js, the lease): not broken, not loading —
  // say which, because "Cold" would promise a picture in a minute.
  if (e.lease) {
    imgEngine.dataset.state = "cold";
    imgEngine.textContent = "Paused";
    imgEngine.title = "The graphics card is busy with " + (e.lease.what || "another program") + ". Pictures come back when it finishes.";
    return;
  }
  var warm = !!e.warm;
  imgEngine.dataset.state = warm ? "warm" : "cold";
  imgEngine.textContent = warm ? "Ready" : "Cold";
  imgEngine.title = warm
    ? "The model is loaded, so the next picture is quick."
    : "The model loads on the first picture, which takes about a minute. After that it stays ready.";
}

/* ------------------------------- the picture ------------------------------ */

function stageMessage(text, isErr) {
  imgStage.innerHTML = "";
  var p = document.createElement("p");
  p.className = "img-msg" + (isErr ? " is-err" : "");
  p.textContent = text;
  imgStage.appendChild(p);
}

function stageBusy(label) {
  imgStage.innerHTML = "";
  var box = document.createElement("div");
  box.className = "img-busy";
  var bar = document.createElement("div");
  bar.className = "img-bar";
  var fill = document.createElement("i");
  bar.appendChild(fill);
  var cap = document.createElement("span");
  cap.className = "img-cap";
  cap.textContent = label;
  box.appendChild(bar); box.appendChild(cap);
  imgStage.appendChild(box);
  return { fill: fill, cap: cap };
}

function stagePicture(job) {
  imgStage.innerHTML = "";
  var fig = document.createElement("figure");
  fig.className = "img-shot";
  var im = document.createElement("img");
  im.alt = job.prompt || "";
  im.src = job.src;
  fig.appendChild(im);

  var row = document.createElement("div");
  row.className = "img-shot-actions";

  var dl = document.createElement("a");
  dl.className = "img-btn";
  dl.href = "/api/download?path=" + encodeURIComponent(job.path);
  dl.setAttribute("download", "");
  dl.textContent = "Download";
  row.appendChild(dl);

  // The one control worth putting in front of someone: same seed, changed words.
  var again = document.createElement("button");
  again.type = "button";
  again.className = "img-btn";
  again.textContent = "Keep this seed";
  again.addEventListener("click", function () {
    imgSeed.value = String(job.seed);
    imgMore.open = true;
    toast("Seed " + job.seed + " kept — change the words and make another.");
  });
  row.appendChild(again);

  var cap = document.createElement("figcaption");
  cap.className = "img-cap";
  cap.textContent = job.width + "×" + job.height + " · " + job.secs + "s · " + Math.round(job.bytes / 1024) + " KB";
  fig.appendChild(row);
  fig.appendChild(cap);
  imgStage.appendChild(fig);
}

function busyLabel(job) {
  if (job.state === "queued") {
    return job.queuePosition ? "Waiting behind " + job.queuePosition + " in the queue…" : "Queued…";
  }
  return "Drawing… " + job.elapsed + "s";
}

function generate() {
  var prompt = String(imgPrompt.value || "").trim();
  if (prompt.length < 3) return;
  var m = currentModel();
  var body = { prompt: prompt, shape: shape };
  if (m) body.model = m.id;
  if (imgNegative.value.trim()) body.negative_prompt = imgNegative.value.trim();
  if (/^\d+$/.test(imgSeed.value.trim())) body.seed = Number(imgSeed.value.trim());
  if (imgSteps.value) body.steps = Number(imgSteps.value);

  imgGo.disabled = true;
  var ui = stageBusy("Starting…");
  // First picture after a cold start pays the model load; say so rather than
  // letting a minute of silence look like a hang.
  var expect = (presets && presets.engine && presets.engine.warm) ? 20 : 60;
  var t0 = Date.now();

  apiFetch("/api/image/generate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : "could not start");
      lastSeed = res.j.seed;
      stopPoll();
      poll = setInterval(function () {
        apiFetch("/api/image/job/" + encodeURIComponent(res.j.id))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (job) {
            if (!job) return;
            var frac = Math.min(0.97, (Date.now() - t0) / (expect * 1000));
            ui.fill.style.width = Math.round(frac * 100) + "%";
            ui.cap.textContent = busyLabel(job);
            if (job.state === "done") {
              stopPoll();
              imgGo.disabled = false;
              stagePicture(job);
              if (presets && presets.engine) { presets.engine.warm = true; paintEngine(presets.engine); }
              loadRecent();
            } else if (job.state === "failed") {
              stopPoll();
              imgGo.disabled = false;
              stageMessage(job.error || "The picture could not be made.", true);
            }
          })
          .catch(function () { /* one missed poll is not a failure */ });
      }, POLL_MS);
    })
    .catch(function (err) {
      imgGo.disabled = false;
      stageMessage(err.message || "Could not start.", true);
    });
}

/* --------------------------------- earlier -------------------------------- */

function loadRecent() {
  return apiFetch("/api/image/gallery?limit=18")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var list = (d && d.pictures) || [];
      imgRecent.hidden = !list.length;
      imgStrip.innerHTML = "";
      list.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "img-tile";
        b.title = p.name;
        var im = document.createElement("img");
        im.loading = "lazy";
        im.alt = "";
        im.src = p.src;
        b.appendChild(im);
        b.addEventListener("click", function () {
          stagePicture({
            src: p.src, path: p.path, prompt: p.name, seed: lastSeed,
            width: 0, height: 0, secs: 0, bytes: p.bytes,
          });
        });
        imgStrip.appendChild(b);
      });
    })
    .catch(function () { /* the gallery is a nicety */ });
}

/* ---------------------------------- wiring -------------------------------- */

export function initImages() {
  if (!imagesNav || !imgModal) return;

  imagesNav.addEventListener("click", openImages);
  imgClose.addEventListener("click", closeImages);
  imgOverlay.addEventListener("click", closeImages);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && imgOpen) closeImages();
  });

  // Owner-only, and a page this repo does not own — so a new tab, not a panel.
  if (studioNav) {
    studioNav.addEventListener("click", function () {
      closeDrawer();
      window.open("/sdui", "_blank", "noopener");
    });
  }

  imgShapes.addEventListener("click", function (e) {
    var b = e.target.closest(".img-shape");
    if (!b) return;
    shape = b.dataset.shape;
    Array.prototype.forEach.call(imgShapes.children, function (c) { c.classList.toggle("is-on", c === b); });
  });

  imgPrompt.addEventListener("input", function () {
    imgGo.disabled = String(imgPrompt.value || "").trim().length < 3;
  });
  // Enter sends on a keyboard; a phone keeps its return key for new lines.
  imgPrompt.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !imgGo.disabled) { e.preventDefault(); generate(); }
  });

  imgGo.addEventListener("click", generate);
  imgSteps.addEventListener("input", function () { imgStepsOut.textContent = imgSteps.value; });
  if (imgModel) {
    imgModel.addEventListener("change", function () {
      pref("imageModel", imgModel.value);
      applyModelDefaults();
    });
  }
}
