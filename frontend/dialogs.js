"use strict";
/* Help and About: panels that slide in over the page. They close with the
 * × button, the Escape key, or a click anywhere outside the panel. */
(() => {
  const backdrop = document.getElementById("modal-backdrop");
  const SLIDE_MS = 220; // keep in step with the transition in style.css
  let open = null, opener = null, closing = null;

  function show(id, from) {
    if (open) hide(true);
    clearTimeout(closing);
    opener = from;
    open = document.getElementById(id);
    for (const d of backdrop.querySelectorAll(".modal")) d.hidden = d !== open;
    backdrop.hidden = false;
    document.body.classList.add("modal-open");
    open.querySelector(".modal-body").scrollTop = 0;
    void backdrop.offsetWidth; // let the starting position apply before sliding in
    backdrop.classList.add("shown");
    open.focus();
  }

  function hide(immediately) {
    if (!open) return;
    const panel = open;
    open = null;
    backdrop.classList.remove("shown");
    document.body.classList.remove("modal-open");
    const finish = () => { panel.hidden = true; if (!open) backdrop.hidden = true; };
    clearTimeout(closing);
    if (immediately) finish(); else closing = setTimeout(finish, SLIDE_MS);
    if (opener) opener.focus();
  }

  document.getElementById("open-help").addEventListener("click", (ev) => show("dialog-help", ev.currentTarget));
  document.getElementById("open-about").addEventListener("click", (ev) => show("dialog-about", ev.currentTarget));
  // A press that starts on the dimmed area, outside the panel, closes it.
  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target !== backdrop) return;
    ev.preventDefault(); // or the press would take focus away from the button we return it to
    hide();
  });
  for (const b of backdrop.querySelectorAll(".modal-close")) b.addEventListener("click", () => hide());
  document.addEventListener("keydown", (ev) => {
    if (!open) return;
    if (ev.key === "Escape") { ev.stopPropagation(); hide(); return; }
    if (ev.key === " " || ev.key.startsWith("Arrow")) ev.stopPropagation(); // scroll the panel, not the animation
    if (ev.key === "Tab") { // keep keyboard focus inside the panel
      const items = [...open.querySelectorAll("a[href], button, summary")];
      const first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === open)) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  }, true);
})();
