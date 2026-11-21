// Void Corkboard: magnifier lens. A round lens follows the mouse over any image in Foundry (journal image pages, images inside
// journal text, image popouts, shown handouts) and shows it enlarged, sampled from the full-resolution file so small writing stays sharp.
// Hold a key (default Left Alt) or toggle it on (Shift+M, the toolbar button, or the button on a journal / image window).
// Mouse wheel changes the zoom while the lens is over an image. Client-side only: no Keeper needed, nothing stored in the world.
/** The module id; also the scope this feature's keybindings and settings are registered under. @type {string} */
const MOD = "void-corkboard";
/** Lowest and highest zoom the mouse wheel can reach. @type {number} */
const ZMIN = 1.5, ZMAX = 10;
/** Live state: hold = key currently down, toggle = switched on with a button, x/y = last mouse position, el = the lens element. */
const st = { hold: false, toggle: false, x: -1, y: -1, el: null, raf: 0 };

/**
 * Reads one of this feature's settings, falling back to a default if settings are not ready yet.
 * @param {string} key The setting key.
 * @param {*} dflt Value used when the setting cannot be read.
 * @returns {*} The setting value.
 */
const getSet = (key, dflt) => { try { return game.settings.get(MOD, key) ?? dflt; } catch { return dflt; } };
/**
 * Tells whether the lens should currently be shown.
 * @returns {boolean} True when the hold key is down or the lens is toggled on.
 */
const isOn = () => st.hold || st.toggle;

/**
 * Works out which part of an image element actually shows picture (CSS object-fit can leave empty margins).
 * @param {HTMLImageElement} img The image element.
 * @returns {{left:number,top:number,w:number,h:number}} The drawn picture's rectangle in screen pixels.
 */
function drawnRect(img) {
  const r = img.getBoundingClientRect(), cs = getComputedStyle(img);
  const p = (k) => parseFloat(cs[k]) || 0;
  const bl = p("borderLeftWidth") + p("paddingLeft"), bt = p("borderTopWidth") + p("paddingTop");
  const bw = r.width - bl - p("borderRightWidth") - p("paddingRight"), bh = r.height - bt - p("borderBottomWidth") - p("paddingBottom");
  const nw = img.naturalWidth, nh = img.naturalHeight;
  let w = bw, h = bh;
  const fit = cs.objectFit;
  if (fit === "contain") { const s = Math.min(bw / nw, bh / nh); w = nw * s; h = nh * s; }
  else if (fit === "cover") { const s = Math.max(bw / nw, bh / nh); w = nw * s; h = nh * s; }
  else if (fit === "none") { w = nw; h = nh; }
  else if (fit === "scale-down") { const s = Math.min(1, bw / nw, bh / nh); w = nw * s; h = nh * s; }
  return { left: r.left + bl + (bw - w) / 2, top: r.top + bt + (bh - h) / 2, w, h };
}

/**
 * Finds the image under the pointer, ignoring the lens itself, tiny icons, and images hidden under another window.
 * @param {number} x Pointer x in screen pixels.
 * @param {number} y Pointer y in screen pixels.
 * @returns {HTMLImageElement|null} The image to magnify, or null.
 */
function pickImage(x, y) {
  const els = document.elementsFromPoint(x, y).filter((e) => e !== st.el && !st.el?.contains(e));
  const root = els[0]?.closest(".application, .app");
  for (const el of els) {
    if (!(el instanceof HTMLImageElement) || !el.naturalWidth || !(el.currentSrc || el.src)) continue;
    if (root && !root.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    return el;
  }
  return null;
}

/**
 * Makes the lens element if it does not exist yet.
 * @returns {HTMLElement} The lens element, attached to the page.
 */
function lens() {
  if (!st.el) {
    st.el = document.createElement("div"); st.el.className = "vcb-lens";
    st.el.innerHTML = `<span class="vcb-lens-zoom"></span>`;
    document.body.append(st.el);
  }
  return st.el;
}

/**
 * Hides the lens.
 * @returns {void}
 */
function hide() { if (st.el) st.el.style.display = "none"; }

/**
 * Redraws the lens at the last mouse position, or hides it when it is off or not over an image.
 * @returns {void}
 */
function update() {
  st.raf = 0;
  if (!isOn() || st.x < 0) return hide();
  const img = pickImage(st.x, st.y);
  if (!img) return hide();
  const d = drawnRect(img);
  const fx = (st.x - d.left) / d.w, fy = (st.y - d.top) / d.h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return hide();
  const size = Number(getSet("lensSize", 240)), z = Number(getSet("zoom", 3));
  const el = lens();
  el.style.display = "block";
  el.style.width = el.style.height = `${size}px`;
  el.style.left = `${st.x - size / 2}px`; el.style.top = `${st.y - size / 2}px`;
  el.style.backgroundImage = `url("${(img.currentSrc || img.src).replace(/"/g, "%22")}")`;
  el.style.backgroundSize = `${d.w * z}px ${d.h * z}px`;
  el.style.backgroundPosition = `${size / 2 - fx * d.w * z}px ${size / 2 - fy * d.h * z}px`;
  el.querySelector(".vcb-lens-zoom").textContent = `${z.toFixed(1).replace(/\.0$/, "")}×`;
}
/**
 * Schedules a redraw on the next animation frame so rapid mouse moves cost one redraw.
 * @returns {void}
 */
const schedule = () => { if (!st.raf) st.raf = requestAnimationFrame(update); };

/**
 * Switches the toggle mode and refreshes the buttons that show it.
 * @param {boolean} [v] New state; flips the current one if omitted.
 * @returns {void}
 */
function setToggle(v = !st.toggle) {
  st.toggle = v;
  document.querySelectorAll(".vcb-mag").forEach((b) => b.classList.toggle("active", v));
  document.body.classList.toggle("vcb-mag-on", isOn());
  schedule();
}
/**
 * Sets whether the hold key is down.
 * @param {boolean} v True while the key is held.
 * @returns {void}
 */
function setHold(v) { st.hold = v; document.body.classList.toggle("vcb-mag-on", isOn()); schedule(); }

Hooks.once("init", () => {
  game.settings.register(MOD, "zoom", { scope: "client", config: false, type: Number, default: 3 });
  game.settings.register(MOD, "lensSize", { name: "Magnifier lens size (pixels)", hint: "Width of the round magnifier lens. Hold the magnifier key (default Left Alt) or press Shift+M, then hover over an image. Mouse wheel changes the zoom.", scope: "client", config: true, type: Number, default: 240, range: { min: 140, max: 480, step: 20 }, onChange: schedule });
  game.keybindings.register(MOD, "magnifierHold", {
    name: "Magnifier (hold)", hint: "Hold to show the magnifier lens over images.",
    editable: [{ key: "AltLeft" }],
    onDown: () => { setHold(true); return true; }, onUp: () => { setHold(false); return true; }
  });
  game.keybindings.register(MOD, "magnifierToggle", {
    name: "Magnifier (toggle)", hint: "Press to switch the magnifier lens on or off.",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    onDown: () => { setToggle(); return true; }
  });
});

window.addEventListener("pointermove", (e) => { st.x = e.clientX; st.y = e.clientY; if (isOn()) schedule(); }, { capture: true, passive: true });
window.addEventListener("pointerleave", () => hide(), true);
// Alt-Tab and similar: the key-up never arrives, so drop the hold when the window loses focus
window.addEventListener("blur", () => { setHold(false); hide(); });
// stop Alt on its own from focusing the browser menu bar
window.addEventListener("keyup", (e) => { if (e.code === "AltLeft" && !e.ctrlKey && !e.shiftKey && st.el?.style.display === "block") e.preventDefault(); }, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && st.toggle) setToggle(false); }, true);
// wheel changes zoom, but only while the lens is actually showing, so normal scrolling is untouched otherwise
window.addEventListener("wheel", (e) => {
  if (!isOn() || st.el?.style.display !== "block") return;
  e.preventDefault(); e.stopPropagation();
  const z = Math.min(ZMAX, Math.max(ZMIN, Number(getSet("zoom", 3)) * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  game.settings.set(MOD, "zoom", Math.round(z * 100) / 100).then(schedule);
  update();
}, { capture: true, passive: false });

/**
 * Adds a magnifier button to journal windows and image popouts.
 */
Hooks.on("renderApplicationV2", (sheet) => {
  const isImg = sheet instanceof foundry.applications.apps?.ImagePopout;
  if (!(sheet.document instanceof JournalEntry) && !isImg) return;
  const header = sheet.window?.header ?? sheet.element?.querySelector(".window-header");
  if (!header || header.querySelector(".vcb-mag")) return;
  const b = document.createElement("button"); b.type = "button";
  b.className = `header-control icon fa-solid fa-magnifying-glass vcb-mag${st.toggle ? " active" : ""}`;
  b.dataset.tooltip = "Magnifier (or hold Left Alt)"; b.setAttribute("aria-label", "Magnifier");
  b.addEventListener("click", (ev) => { ev.stopPropagation(); setToggle(); });
  header.insertBefore(b, header.querySelector("button.header-control") ?? null);
});
/**
 * Adds a magnifier toggle to the left toolbar.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    const tool = { name: "vcbMagnifier", title: "Magnifier", icon: "fa-solid fa-magnifying-glass", toggle: true, active: st.toggle, visible: true, order: 98, onChange: (ev, active) => setToggle(typeof active === "boolean" ? active : undefined) };
    const g = Array.isArray(controls) ? controls.find((c) => c.name === "tokens" || c.name === "token") : controls.tokens;
    if (!g) return;
    if (Array.isArray(g.tools)) g.tools.push({ ...tool, onClick: () => setToggle() }); else g.tools.vcbMagnifier = tool;
  } catch (e) { console.warn(MOD, e); }
});
