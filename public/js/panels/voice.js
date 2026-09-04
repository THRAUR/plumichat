import { autoGrow, updateSend } from '../composer.js';
import { $, input, toast } from '../dom.js';

/* ---------- Voice → text (browser Web Speech API) ---------- */
// Claude has no audio input, so transcription happens in the BROWSER (free, no
// server, no audio upload) and the recognized words flow straight into the
// composer for the user to review/edit before sending — just normal text.
export let SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
export let voiceBtn = $("voiceBtn");
export let recording = false, recog = null, voiceBase = "";
export function startRec() {
  if (!SpeechRec) { toast("Voice typing isn't supported in this browser.", true); return; }
  try { recog = new SpeechRec(); } catch (e) { toast("Couldn't start the microphone.", true); return; }
  recog.lang = navigator.language || "en-US";
  recog.continuous = true;
  recog.interimResults = true;
  voiceBase = input.value; // keep whatever's already typed; append speech to it
  recog.onresult = function (e) {
    var finals = "", interim = "";
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var seg = e.results[i][0].transcript;
      if (e.results[i].isFinal) finals += seg; else interim += seg;
    }
    if (finals) voiceBase = (voiceBase ? voiceBase.replace(/\s+$/, "") + " " : "") + finals.trim();
    input.value = (voiceBase + (interim ? " " + interim.trim() : "")).replace(/^\s+/, "");
    autoGrow();
  };
  recog.onerror = function (e) {
    var err = e && e.error;
    stopRec();
    if (err && err !== "aborted" && err !== "no-speech") {
      toast((err === "not-allowed" || err === "service-not-allowed")
        ? "Microphone permission denied." : "Voice error: " + err, true);
    }
  };
  recog.onend = function () { if (recording) stopRec(); };
  recording = true;
  voiceBtn.classList.add("recording");
  try { recog.start(); } catch (e) { stopRec(); }
}
export function stopRec() {
  if (!recording) return;
  recording = false;
  voiceBtn.classList.remove("recording");
  try { if (recog) recog.stop(); } catch (e) {}
  recog = null;
  input.focus();
  updateSend();
}

export function initVoice() {
  voiceBtn.addEventListener("click", function () { recording ? stopRec() : startRec(); });
}
