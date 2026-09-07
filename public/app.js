import { initAttachments } from './js/panels/attachments.js';
import { loadProjects } from './js/boot.js';
import { initCommands } from './js/panels/commands.js';
import { initContext } from './js/panels/context.js';
import { autoGrow, initComposer } from './js/composer.js';
import { initDeliverables } from './js/panels/deliverables.js';
import { initGlobalDismiss } from './js/dismiss.js';
import { initEmbedClasses } from './js/dom.js';
import { initEngineAndDeploy } from './js/panels/engine.js';
import { initDownloadMenus } from './js/exports.js';
import { initFilePicker } from './js/files.js';
import { initLibrary } from './js/library.js';
import { initModelPicker } from './js/models.js';
import { initNotepad } from './js/panels/notepad.js';
import { initNotify } from './js/panels/notify.js';
import { initPermPicker } from './js/panels/perm.js';
import { initPlugins } from './js/panels/plugins.js';
import { initProfile } from './js/profile.js';
import { initProjectPicker } from './js/projects.js';
import { initPushRow } from './js/panels/push.js';
import { initQuote } from './js/quote.js';
import { initRender } from './js/render.js';
import { initServerRestart } from './js/panels/restart.js';
import { initSheet } from './js/sheet.js';
import { initShortcutPicker } from './js/panels/shortcuts.js';
import { initSites } from './js/panels/sites.js';
import { initSkills } from './js/panels/skills.js';
import { initStream } from './js/stream.js';
import { initTasks } from './js/tasks.js';
import { initTerminal } from './js/panels/terminal.js';
import { initThemeToggle } from './js/panels/theme-toggle.js';
import { initTaskTray, initQueueSync } from './js/tray.js';
import { initUsageChip } from './js/usage.js';
import { initVoice } from './js/panels/voice.js';

/* PlumiChat — real client. Design by Claude Design; wired to the live backend.
   History is server-side: it reads the Claude Agent SDK's own session logs
   (~/.claude/projects/.../<session>.jsonl) via /api/sessions + /api/session,
   so conversations are real, persistent, and visible from any device.

   This file is the entry point index.html loads as a module, and it is deliberately
   nothing but a running order. Everything that used to live below it — one 6,300-line
   IIFE — is now in public/js/, with no build step: the server sends those files as
   they are and the browser resolves the imports.

   NOTHING may import this file. It is the only module the page loads by URL, and
   index.html loads it with a ?v= cache-buster; an import of '/app.js' from inside
   js/ would be a DIFFERENT URL, so the browser would evaluate a second copy of this
   entry — which is exactly how the first attempt at this split broke (a module read
   another module's binding before that module had been evaluated). Anything two
   modules both need lives in js/, never here. */

/* ---------- Wire-up ----------
   Every module imported above only DECLARED things when it was evaluated; none of
   them attach a listener, read a preference or start a fetch on their own. This is
   where the page wires itself up, and the order below is the order the old
   single-file app.js ran those same statements in. Keep it that way: reordering
   these is the one edit here that can change behaviour without changing any code.
   Adding a panel means adding its init() at the position its wiring belongs. */
initEmbedClasses();
initTasks();
initProjectPicker();
initModelPicker();
initPermPicker();
initSkills();
initCommands();
initDeliverables();
initNotify();
initGlobalDismiss();
initLibrary();
initNotepad();
initTerminal();
initProfile();
initShortcutPicker();
initSites();
initServerRestart();
initEngineAndDeploy();
initPlugins();
initPushRow();
initThemeToggle();
initAttachments();
initFilePicker();
initVoice();
initRender();
initDownloadMenus();
initTaskTray();
// Hold the queue's SSE stream for the whole session: it is how this window hears
// about a message queued on your phone, and about the server draining one on its
// own when a turn ends. Started after the tray so its first paint has a list.
initQueueSync();
initSheet();
initContext();
initUsageChip();
initStream();
initQuote();
initComposer();

loadProjects(false);
autoGrow();

/* The boot wink: one scanline sweep down the app shell as it comes up — Plume's
   "the machine is waking" moment, and the only load animation in the product.
   The class removes itself, so nothing is left holding a pseudo-element over the
   chat; plume.css defines the sweep only inside a no-preference media query, so a
   person who has asked for reduced motion simply never sees it. */
(function bootWink() {
  var shell = document.querySelector(".app");
  if (!shell) return;
  shell.classList.add("pl-boot");
  setTimeout(function () { shell.classList.remove("pl-boot"); }, 700);
})();
