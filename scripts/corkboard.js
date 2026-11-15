// Void Corkboard: a detective corkboard for the party. Cards pinned to cork, joined by red string, shared live.
// Storage: each board is a JournalEntry in the folder "Corkboards". Cards and strings live in that journal's flags
// (flags.void-corkboard.cards.<id> / .strings.<id>), one key each, so two players editing at once do not overwrite each other.
// Cards only point at their source (uuid, Party Note id, image path); nothing is copied. Nothing is stored in the module folder.
// Players own their boards, so no Keeper needs to be online. Reuses the Party Notes macro data (flags.world on its journals).
const MOD = "void-corkboard";
const FOLDER = "Corkboards";
const PN = "world"; // Party Notes flag scope
const PN_LINKS = "Party Notes: Links";
const L = () => CONST.DOCUMENT_OWNERSHIP_LEVELS;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const PAPER = { guifen: "#bfe3c0", amelia: "#fff3a0", mercy: "#bcd9f5" };
const paperFor = (name) => { const k = Object.keys(PAPER).find((k) => (name ?? "").toLowerCase().includes(k)); return k ? PAPER[k] : "#ffd9a8"; };
const rotOf = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 997; return ((h % 50) - 25) / 10; };
const who = (user) => user.character?.name ?? user.name;
const WIDTHS = [150, 210, 300];
const STAMPS = ["", "?", "Suspect", "Solved", "Dead end"];
const COLORS = { red: "#b01818", white: "#efe9da", blue: "#2c5fa8", green: "#2f7d3a", gold: "#c9a227" };
const DOC_TYPES = ["JournalEntry", "JournalEntryPage", "Actor", "Item"];

// ---------- boards ----------
const F = (doc, key) => doc?.flags?.[MOD]?.[key];
const isBoard = (j) => !!F(j, "board");
const boards = () => game.journal.contents.filter((j) => isBoard(j) && j.testUserPermission(game.user, "OBSERVER"))
  .sort((a, b) => kindRank(a) - kindRank(b) || a.name.localeCompare(b.name));
const kindRank = (j) => ({ party: 0, private: 1, keeper: 2 }[F(j, "board")?.kind] ?? 3);
const live = (obj) => Object.values(obj ?? {}).filter((v) => v && v.id && !v.dead);
const cardsOf = (b) => live(F(b, "cards"));
const stringsOf = (b) => live(F(b, "strings"));
const canEdit = (b) => b && b.isOwner && (game.user.isGM || !F(b, "locked"));

async function ensureSetup() {
  if (!game.users.activeGM?.isSelf) return;
  let folder = game.folders.find((f) => f.type === "JournalEntry" && f.name === FOLDER);
  if (!folder) folder = await Folder.create({ name: FOLDER, type: "JournalEntry" });
  const info = (t) => [{ name: "Info", type: "text", text: { content: `<p>${t} Open it with the corkboard button (pushpin icon).</p>`, format: 1 } }];
  const all = game.journal.contents.filter(isBoard);
  if (!all.some((j) => F(j, "board").kind === "party")) {
    await JournalEntry.create({ name: "Party Board", folder: folder.id, ownership: { default: L().OWNER }, flags: { [MOD]: { board: { kind: "party" }, cards: {}, strings: {} } }, pages: info("The party's shared corkboard.") });
  }
  for (const u of game.users.filter((u) => !u.isGM && u.name !== "Table")) {
    if (all.some((j) => F(j, "board").owner === u.id)) continue;
    await JournalEntry.create({ name: `${u.name}'s Board`, folder: folder.id, ownership: { default: L().NONE, [u.id]: L().OWNER }, flags: { [MOD]: { board: { kind: "private", owner: u.id }, cards: {}, strings: {} } }, pages: info(`${esc(u.name)}'s private corkboard.`) });
  }
}

// Remove keys from a flag map. Tries Foundry's "-=" removal, and falls back to a tombstone if that did not take.
async function removeKeys(board, pairs) {
  const upd = {}, Del = foundry.data?.operators?.ForcedDeletion;
  for (const [map, id] of pairs) { if (Del) upd[`flags.${MOD}.${map}.${id}`] = new Del(); else upd[`flags.${MOD}.${map}.-=${id}`] = null; }
  try { await board.update(upd); } catch (e) { console.warn(MOD, e); }
  const left = pairs.filter(([map, id]) => F(board, map)?.[id]);
  if (left.length) {
    const upd2 = {};
    for (const [map, id] of left) upd2[`flags.${MOD}.${map}.${id}.dead`] = true;
    await board.update(upd2);
  }
}

// ---------- Party Notes data (read-only here, except link suggestions) ----------
const outboxes = () => game.journal.contents.filter((j) => j.getFlag(PN, "outboxFor"));
const canSeeEntry = (entry) => entry && (entry.testUserPermission(game.user, "OBSERVER") || entry.pages.some((p) => p.testUserPermission(game.user, "OBSERVER")));
function allNotes() {
  const out = [];
  for (const j of outboxes()) for (const n of j.getFlag(PN, "notes") ?? []) {
    const entry = fromUuidSync(n.uuid, { strict: false });
    if (entry && canSeeEntry(entry)) out.push({ ...n, entry, box: j });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
const approvedLinks = () => game.journal.getName(PN_LINKS)?.getFlag(PN, "approved") ?? [];
const isPNJournal = (j) => !!j.getFlag(PN, "outboxFor") || j.name === PN_LINKS;

// ---------- what a card shows to this viewer ----------
function resolve(card) {
  const sealed = { sealed: true };
  if (card.type === "text") return { kind: "index", text: card.text ?? "", color: card.color || paperFor(card.who) };
  if (card.type === "image") return { kind: "photo", img: card.src, title: card.caption ?? "", open: () => showImage(card.src, card.caption) };
  if (card.type === "note") {
    const box = game.journal.get(card.box);
    const n = (box?.getFlag(PN, "notes") ?? []).find((n) => n.id === card.noteId);
    const entry = n && fromUuidSync(n.uuid, { strict: false });
    if (!n || !entry || !canSeeEntry(entry)) return sealed;
    return { kind: "sticky", note: n, entry, entryUuid: entry.uuid, open: () => entry.sheet.render(true, n.pageId && entry.pages.get(n.pageId) ? { pageId: n.pageId } : {}) };
  }
  if (card.type !== "doc") return sealed;
  let doc = null;
  try { doc = fromUuidSync(card.uuid, { strict: false }); } catch (e) { /* missing */ }
  if (!doc || !doc.documentName) return sealed;
  if (doc.documentName === "JournalEntry") {
    if (!canSeeEntry(doc)) return sealed;
    const pages = doc.pages.contents.filter((p) => p.testUserPermission(game.user, "OBSERVER")).sort((a, b) => a.sort - b.sort);
    const first = pages[0];
    const base = { title: doc.name, entryUuid: doc.uuid, sub: pages.length > 1 ? `${pages.length} pages` : "", open: () => doc.sheet.render(true) };
    if (first?.type === "image" && first.src) return { kind: "photo", img: first.src, ...base };
    return { kind: "paper", snip: snippet(first), ...base };
  }
  if (doc.documentName === "JournalEntryPage") {
    if (!doc.testUserPermission(game.user, "OBSERVER")) return sealed;
    const base = { title: doc.name, sub: doc.parent.name, entryUuid: doc.parent.uuid, open: () => doc.parent.sheet.render(true, { pageId: doc.id }) };
    if (doc.type === "image" && doc.src) return { kind: "photo", img: doc.src, ...base };
    return { kind: "paper", snip: snippet(doc), ...base };
  }
  if (!doc.testUserPermission(game.user, "LIMITED")) return sealed;
  return { kind: "photo", img: doc.img, title: doc.name, open: () => doc.sheet.render(true) };
}
function snippet(page) {
  if (!page || page.type !== "text") return "";
  const d = document.createElement("div");
  d.innerHTML = String(page.text?.content ?? "").replace(/<section[^>]*class="[^"]*secret[^"]*"[\s\S]*?<\/section>/gi, "");
  const t = (d.textContent ?? "").replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, "$1").replace(/\s+/g, " ").trim();
  return t.length > 150 ? t.slice(0, 150) + "…" : t;
}
function showImage(src, title) {
  try { new foundry.applications.apps.ImagePopout({ src, window: { title: title || "Image" } }).render({ force: true }); }
  catch (e) { window.open(src, "_blank"); }
}

// ---------- dialogs ----------
const { ApplicationV2, DialogV2 } = foundry.applications.api;
async function ask(title, content, buttons) {
  try {
    return await DialogV2.wait({ window: { title }, position: { width: 420 }, content: `<div class="vcb-dialog">${content}</div>`, rejectClose: false,
      buttons: buttons.map((b, i) => ({ action: b.action, label: b.label, icon: b.icon, default: i === 0, callback: (ev, button) => ({ action: b.action, ...Object.fromEntries(new FormData(button.form).entries()) }) })) });
  } catch (e) { return null; }
}

// ---------- the window ----------
class Corkboard extends ApplicationV2 {
  static DEFAULT_OPTIONS = { id: MOD, classes: ["vcb-app"], window: { title: "Corkboard", resizable: true, icon: "fa-solid fa-thumbtack" }, position: { width: 1000, height: 720 } };
  boardId = null; pan = { x: 40, y: 30 }; zoom = 1; busy = false; dirty = false; views = {};
  get board() { return game.journal.get(this.boardId) ?? null; }
  setBoard(id) {
    if (this.boardId) this.views[this.boardId] = { pan: { ...this.pan }, zoom: this.zoom };
    this.boardId = id;
    const v = this.views[id]; this.pan = v ? { ...v.pan } : { x: 40, y: 30 }; this.zoom = v?.zoom ?? 1;
    try { localStorage.setItem(`${MOD}.last`, id); } catch (e) { /* ignore */ }
  }
  refresh() { if (this.busy) this.dirty = true; else if (this.rendered) this.render(); }

  async _renderHTML() {
    const list = boards();
    if (!this.board || !list.includes(this.board)) {
      let last = null; try { last = localStorage.getItem(`${MOD}.last`); } catch (e) { /* ignore */ }
      this.boardId = (list.find((b) => b.id === last) ?? list[0])?.id ?? null;
    }
    const b = this.board;
    if (!b) return `<div class="vcb-root"><p style="padding:20px">No corkboard is set up for you yet. Ask the Keeper to log in once so the boards are created.</p></div>`;
    const edit = canEdit(b);
    const opts = list.map((j) => `<option value="${j.id}" ${j.id === b.id ? "selected" : ""}>${esc(j.name)}${F(j, "board").kind === "keeper" ? " (Keeper only)" : ""}</option>`).join("");
    const locked = F(b, "locked");
    const bar = `<div class="vcb-bar"><select data-board>${opts}</select>
${edit ? `<button type="button" data-add="text" data-tooltip="Add an index card you can write on"><i class="fa-regular fa-note-sticky"></i> Card</button>
<button type="button" data-add="note" data-tooltip="Pin an existing Party Note"><i class="fa-solid fa-thumbtack"></i> Party Note</button>` : ""}
${edit && game.user.can("FILES_BROWSE") ? `<button type="button" data-add="image" data-tooltip="Pin a picture from the server"><i class="fa-regular fa-image"></i> Picture</button>` : ""}
<button type="button" data-fit data-tooltip="Show the whole board"><i class="fa-solid fa-expand"></i> Fit</button>
${game.user.isGM ? `<button type="button" data-lock data-tooltip="Players cannot change a locked board"><i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i> ${locked ? "Locked" : "Lock"}</button>
<button type="button" data-newboard data-tooltip="Create a Keeper-only board"><i class="fa-solid fa-plus"></i> Keeper board</button>` : ""}
<p class="vcb-hint">${edit ? "Drag journals, pages or actors from the sidebar onto the cork. Drag from a red pin to another card to tie a string. Double-click a card to open it." : (locked ? "This board is locked by the Keeper." : "You can look at this board but not change it.")}</p></div>`;
    return `<div class="vcb-root">${bar}<div class="vcb-view"><div class="vcb-world">${this.worldHTML(b, edit)}</div>${cardsOf(b).length ? "" : `<div class="vcb-empty">The board is empty.<br>Drag a journal, a handout page or a character here, or use the pin button at the top of any journal.</div>`}</div></div>`;
  }

  pinPoint(c) { return { x: c.x + WIDTHS[c.size ?? 1] / 2, y: c.y + 4 }; }

  worldHTML(b, edit) {
    const cards = cardsOf(b), byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    const res = Object.fromEntries(cards.map((c) => [c.id, resolve(c)]));
    const notes = allNotes(); const counts = {};
    for (const n of notes) counts[n.uuid] = (counts[n.uuid] ?? 0) + 1;
    // strings: the party's own, plus Keeper-approved "Related" links between pinned journals
    const strs = stringsOf(b).filter((s) => byId[s.a] && byId[s.b]).map((s) => ({ ...s }));
    const entryCards = {};
    for (const c of cards) { const u = res[c.id].entryUuid; if (u && c.type === "doc") (entryCards[u] ??= []).push(c); }
    for (const l of approvedLinks()) {
      const A = entryCards[l.a]?.[0], B = entryCards[l.b]?.[0];
      if (A && B && A !== B && !strs.some((s) => (s.a === A.id && s.b === B.id) || (s.a === B.id && s.b === A.id))) strs.push({ id: `auto-${l.id}`, a: A.id, b: B.id, label: l.reason || "Related", color: "gold", auto: true, who: l.who });
    }
    let svg = "", labels = "";
    for (const s of strs) {
      const p = this.pinPoint(byId[s.a]), q = this.pinPoint(byId[s.b]);
      const d = Math.hypot(q.x - p.x, q.y - p.y), sag = Math.min(60, d * 0.12);
      const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2 + sag;
      const path = `M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}`;
      const col = COLORS[s.color] ?? COLORS.red;
      svg += `<g data-string="${s.id}" data-a="${s.a}" data-b="${s.b}"><path class="vcb-line ${s.auto ? "vcb-auto" : ""}" d="${path}" stroke="${col}"/><path class="vcb-hit" d="${path}" data-string="${s.id}"><title>${esc(s.auto ? `Related (approved by the Keeper): ${s.label}` : `${s.label || "String"} (tied by ${s.who ?? "?"})`)}</title></path></g>`;
      if (s.label) labels += `<div class="vcb-label" data-string="${s.id}" data-a="${s.a}" data-b="${s.b}" style="left:${(p.x + q.x) / 2}px;top:${(p.y + q.y) / 2 + sag / 2}px;--vcb-c:${col}">${esc(s.label)}</div>`;
    }
    let html = "";
    for (const c of cards) {
      const r = res[c.id], w = WIDTHS[c.size ?? 1];
      let cls = "vcb-paper", body = "", style = "";
      if (r.sealed) { cls = "vcb-sealed"; body = `<div class="vcb-wax"><i class="fa-solid fa-lock"></i></div><div class="vcb-title">Sealed</div><div class="vcb-snip">You have not seen this yet.</div>`; }
      else if (r.kind === "photo") { cls = "vcb-photo"; body = `${r.img ? `<img class="vcb-img" src="${esc(r.img)}" draggable="false">` : ""}<div class="vcb-title">${esc(r.title)}</div>${r.sub ? `<div class="vcb-sub" style="text-align:center">${esc(r.sub)}</div>` : ""}`; }
      else if (r.kind === "paper") { body = `<div class="vcb-title">${esc(r.title)}</div>${r.sub ? `<div class="vcb-sub">${esc(r.sub)}</div>` : ""}<div class="vcb-snip">${esc(r.snip)}</div>`; }
      else if (r.kind === "index") { cls = "vcb-index"; style = `background-color:${esc(r.color)};`; body = `<div class="vcb-text">${esc(r.text) || "<i>Double-click to write</i>"}</div><div class="vcb-sig">${esc(c.who ?? "")}</div>`; }
      else if (r.kind === "sticky") { cls = "vcb-sticky"; style = `background:${paperFor(r.note.who)};`; body = `<div class="vcb-sub">re: ${esc([r.entry.name, r.note.pageName].filter(Boolean).join(" › "))}</div><div>${r.note.html}</div><div class="vcb-sig"><b>${esc(r.note.who)}</b> · ${esc(r.note.date)}</div>`; }
      const n = !r.sealed && c.type === "doc" && r.entryUuid ? counts[r.entryUuid] : 0;
      html += `<div class="vcb-card ${cls}" data-card="${c.id}" style="left:${c.x}px;top:${c.y}px;width:${w}px;transform:rotate(${rotOf(c.id)}deg);${style}">
<div class="vcb-pin" data-pin="${c.id}" data-tooltip="${esc(`Pinned by ${c.who ?? "?"}.${edit ? " Drag to another card to tie a string." : ""}`)}"></div>${n ? `<a class="vcb-badge" data-notes="${esc(r.entryUuid)}" data-tooltip="Party Notes on this journal">${n} <i class="fa-regular fa-note-sticky"></i></a>` : ""}
${edit ? `<div class="vcb-tools"><a data-act="stamp" data-tooltip="Stamp: question, suspect, solved, dead end"><i class="fa-solid fa-stamp"></i></a><a data-act="size" data-tooltip="Change size"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></a><a data-act="del" data-tooltip="Take this card off the board"><i class="fa-solid fa-xmark"></i></a></div>` : ""}
<div class="vcb-body">${body}</div>${c.stamp ? `<div class="vcb-stamp">${esc(c.stamp)}</div>` : ""}</div>`;
    }
    return `<svg class="vcb-strings">${svg}<path class="vcb-line vcb-temp" d="" stroke="${COLORS.red}" style="display:none"/></svg>${labels}${html}`;
  }

  applyView(root) { const w = root.querySelector(".vcb-world"); if (w) w.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`; }
  toWorld(view, ev) { const r = view.getBoundingClientRect(); return { x: (ev.clientX - r.left - view.clientLeft - this.pan.x) / this.zoom, y: (ev.clientY - r.top - view.clientTop - this.pan.y) / this.zoom }; }
  endBusy() { this.busy = false; if (this.dirty) { this.dirty = false; this.render(); } }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.style.cssText += ";padding:0;overflow:hidden;display:flex;flex-direction:column;min-height:0";
    const root = content, b = this.board, view = root.querySelector(".vcb-view"), world = root.querySelector(".vcb-world");
    root.querySelector("[data-board]")?.addEventListener("change", (ev) => { this.setBoard(ev.target.value); this.render(); });
    if (!b || !view) return;
    const edit = canEdit(b);
    this.applyView(root);

    // toolbar
    root.querySelector("[data-fit]")?.addEventListener("click", () => { this.fit(view); this.applyView(root); });
    root.querySelector("[data-lock]")?.addEventListener("click", () => b.update({ [`flags.${MOD}.locked`]: !F(b, "locked") }));
    root.querySelector("[data-newboard]")?.addEventListener("click", () => this.newKeeperBoard());
    root.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", () => {
      const r = view.getBoundingClientRect();
      const at = { x: (r.width / 2 - this.pan.x) / this.zoom - 100 + Math.random() * 60, y: (r.height / 2 - this.pan.y) / this.zoom - 80 + Math.random() * 60 };
      if (btn.dataset.add === "text") this.editText(null, at);
      else if (btn.dataset.add === "note") this.pickNote(at);
      else this.pickImage(at);
    }));

    // pan and zoom
    view.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.button !== 1) return;
      if (ev.target.closest(".vcb-card, .vcb-label, .vcb-hit")) return;
      const start = { x: ev.clientX, y: ev.clientY, px: this.pan.x, py: this.pan.y };
      view.classList.add("vcb-panning");
      const move = (e) => { this.pan.x = start.px + e.clientX - start.x; this.pan.y = start.py + e.clientY - start.y; this.applyView(root); };
      const up = () => { view.classList.remove("vcb-panning"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
    view.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = view.getBoundingClientRect(), mx = ev.clientX - r.left - view.clientLeft, my = ev.clientY - r.top - view.clientTop;
      const z = Math.min(2.5, Math.max(0.2, this.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      this.pan.x = mx - (mx - this.pan.x) * (z / this.zoom); this.pan.y = my - (my - this.pan.y) * (z / this.zoom); this.zoom = z;
      this.applyView(root);
    }, { passive: false });

    // drop documents from the sidebar or a journal
    view.addEventListener("dragover", (ev) => ev.preventDefault());
    view.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      if (!edit) return ui.notifications.warn("You cannot change this board.");
      let data = null;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* not a document */ }
      if (!data?.uuid || !DOC_TYPES.includes(data.type)) return ui.notifications.warn("That cannot be pinned. Try a journal, a journal page, a character or an item.");
      const p = this.toWorld(view, ev);
      await addCard(b, { type: "doc", uuid: data.uuid, x: Math.round(p.x - 105), y: Math.round(p.y - 10) });
    });

    // focus: hovering a card highlights what it is tied to
    const focus = (id) => {
      world.classList.toggle("vcb-focus", !!id);
      world.querySelectorAll(".vcb-on").forEach((e) => e.classList.remove("vcb-on"));
      if (!id) return;
      world.querySelector(`[data-card="${id}"]`)?.classList.add("vcb-on");
      world.querySelectorAll(`[data-a="${id}"], [data-b="${id}"]`).forEach((e) => {
        e.classList.add("vcb-on");
        world.querySelector(`[data-card="${e.dataset.a}"]`)?.classList.add("vcb-on"); world.querySelector(`[data-card="${e.dataset.b}"]`)?.classList.add("vcb-on");
      });
    };

    // cards
    world.querySelectorAll(".vcb-card").forEach((el) => {
      const id = el.dataset.card;
      el.addEventListener("pointerenter", () => { if (!this.busy && world.querySelector(`[data-a="${id}"], [data-b="${id}"]`)) focus(id); });
      el.addEventListener("pointerleave", () => { if (!this.busy) focus(null); });
      el.addEventListener("dblclick", (ev) => {
        if (ev.target.closest(".vcb-tools, .vcb-pin, .vcb-badge")) return;
        const c = F(b, "cards")?.[id]; if (!c) return;
        if (c.type === "text") { if (edit) this.editText(c); return; }
        const r = resolve(c);
        if (r.sealed) return ui.notifications.info("That card is sealed. You have not seen what it points to yet.");
        r.open?.();
      });
      el.querySelector(".vcb-badge")?.addEventListener("click", (ev) => { ev.stopPropagation(); this.showNotes(ev.currentTarget.dataset.notes); });
      el.querySelectorAll("[data-act]").forEach((a) => a.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const c = F(b, "cards")?.[id]; if (!c) return;
        if (a.dataset.act === "stamp") await b.update({ [`flags.${MOD}.cards.${id}.stamp`]: STAMPS[(STAMPS.indexOf(c.stamp ?? "") + 1) % STAMPS.length] });
        else if (a.dataset.act === "size") await b.update({ [`flags.${MOD}.cards.${id}.size`]: ((c.size ?? 1) + 1) % WIDTHS.length });
        else if (a.dataset.act === "del") await removeKeys(b, [["cards", id], ...stringsOf(b).filter((s) => s.a === id || s.b === id).map((s) => ["strings", s.id])]);
      }));
      if (!edit) return;
      // move a card
      el.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || ev.target.closest(".vcb-tools, .vcb-pin, .vcb-badge")) return;
        const c = F(b, "cards")?.[id]; if (!c) return;
        const start = { x: ev.clientX, y: ev.clientY }; let moved = false; const pos = { x: c.x, y: c.y };
        const move = (e) => {
          const dx = (e.clientX - start.x) / this.zoom, dy = (e.clientY - start.y) / this.zoom;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          if (!moved) { moved = true; this.busy = true; el.classList.add("vcb-drag"); focus(null); }
          pos.x = Math.round(c.x + dx); pos.y = Math.round(c.y + dy);
          el.style.left = pos.x + "px"; el.style.top = pos.y + "px";
          this.restring(world, b, id, pos);
        };
        const up = async () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          if (!moved) return;
          el.classList.remove("vcb-drag");
          this.dirty = true;
          try { await b.update({ [`flags.${MOD}.cards.${id}.x`]: pos.x, [`flags.${MOD}.cards.${id}.y`]: pos.y }); } finally { this.endBusy(); }
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      });
      // tie a string from the pin
      el.querySelector(".vcb-pin").addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        const c = F(b, "cards")?.[id]; if (!c) return;
        const p = this.pinPoint(c), temp = world.querySelector(".vcb-temp");
        this.busy = true; temp.style.display = "";
        const move = (e) => { const q = this.toWorld(view, e); temp.setAttribute("d", `M ${p.x} ${p.y} L ${q.x} ${q.y}`); };
        const up = async (e) => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          temp.style.display = "none"; temp.setAttribute("d", "");
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".vcb-card")?.dataset.card;
          try {
            if (target && target !== id) {
              if (stringsOf(b).some((s) => (s.a === id && s.b === target) || (s.a === target && s.b === id))) ui.notifications.info("Those two are already tied together. Click the string to change it.");
              else await this.editString(null, { a: id, b: target });
            }
          } finally { this.endBusy(); }
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      });
    });

    // strings
    world.querySelectorAll(".vcb-hit, .vcb-label").forEach((el) => el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const sid = el.dataset.string;
      if (sid.startsWith("auto-")) return ui.notifications.info("This link was approved by the Keeper through Party Notes, so it always shows when both journals are pinned.");
      const s = F(b, "strings")?.[sid];
      if (s && edit) this.editString(s);
    }));
  }

  // redraw the strings of one card while it is dragged
  restring(world, b, id, pos) {
    const cards = F(b, "cards") ?? {};
    world.querySelectorAll(`g[data-a="${id}"], g[data-b="${id}"]`).forEach((g) => {
      const A = g.dataset.a === id ? { ...cards[g.dataset.a], ...pos } : cards[g.dataset.a], B = g.dataset.b === id ? { ...cards[g.dataset.b], ...pos } : cards[g.dataset.b];
      if (!A || !B) return;
      const p = this.pinPoint(A), q = this.pinPoint(B), d = Math.hypot(q.x - p.x, q.y - p.y), sag = Math.min(60, d * 0.12);
      const path = `M ${p.x} ${p.y} Q ${(p.x + q.x) / 2} ${(p.y + q.y) / 2 + sag} ${q.x} ${q.y}`;
      g.querySelectorAll("path").forEach((el) => el.setAttribute("d", path));
      const lab = world.querySelector(`.vcb-label[data-string="${g.dataset.string}"]`);
      if (lab) { lab.style.left = (p.x + q.x) / 2 + "px"; lab.style.top = (p.y + q.y) / 2 + sag / 2 + "px"; }
    });
  }

  fit(view) {
    const cards = cardsOf(this.board); if (!cards.length) { this.pan = { x: 40, y: 30 }; this.zoom = 1; return; }
    const x0 = Math.min(...cards.map((c) => c.x)) - 40, y0 = Math.min(...cards.map((c) => c.y)) - 40;
    const x1 = Math.max(...cards.map((c) => c.x + WIDTHS[c.size ?? 1])) + 40, y1 = Math.max(...cards.map((c) => c.y)) + 320;
    const r = view.getBoundingClientRect();
    this.zoom = Math.min(1.2, Math.max(0.2, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.pan = { x: -x0 * this.zoom + (r.width - (x1 - x0) * this.zoom) / 2, y: -y0 * this.zoom + (r.height - (y1 - y0) * this.zoom) / 2 };
  }

  async editText(card, at) {
    const b = this.board;
    const colors = [["", "My colour"], ["#f1e7cf", "Plain"], ["#fff3a0", "Yellow"], ["#bfe3c0", "Green"], ["#bcd9f5", "Blue"], ["#ffd9a8", "Orange"], ["#f5c6c6", "Pink"]];
    const res = await ask(card ? "Edit card" : "New card", `<label>What does the card say?</label><textarea name="text" rows="6" autofocus>${esc(card?.text ?? "")}</textarea>
<label>Colour</label><select name="color">${colors.map(([v, l]) => `<option value="${v}" ${v === (card?.color ?? "") ? "selected" : ""}>${l}</option>`).join("")}</select>`,
      [{ action: "ok", label: card ? "Save" : "Pin it", icon: "fa-solid fa-thumbtack" }, { action: "cancel", label: "Cancel" }]);
    if (res?.action !== "ok") return;
    const text = String(res.text ?? "").slice(0, 2000);
    if (card) await b.update({ [`flags.${MOD}.cards.${card.id}.text`]: text, [`flags.${MOD}.cards.${card.id}.color`]: res.color });
    else if (text.trim()) await addCard(b, { type: "text", text, color: res.color, x: Math.round(at.x), y: Math.round(at.y) });
  }

  async pickNote(at) {
    const b = this.board, have = new Set(cardsOf(b).filter((c) => c.type === "note").map((c) => c.noteId));
    const notes = allNotes().filter((n) => !have.has(n.id));
    if (!notes.length) return ui.notifications.info("There are no Party Notes left to pin. Write one with the Party Note button on a journal.");
    const wall = notes.slice(0, 60).map((n) => `<div class="vcb-pick" data-pick="${n.id}" style="background:${paperFor(n.who)}"><div style="font-size:10px;opacity:.75">re: ${esc([n.entry.name, n.pageName].filter(Boolean).join(" › "))}</div>${n.html}<div style="font-size:10px;text-align:right"><b>${esc(n.who)}</b></div></div>`).join("");
    const dlg = new DialogV2({ window: { title: "Pin a Party Note" }, position: { width: 720 }, content: `<p>Click a note to pin it to the board.</p><div class="vcb-notewall">${wall}</div>`, buttons: [{ action: "close", label: "Close" }] });
    await dlg.render({ force: true });
    dlg.element.querySelectorAll("[data-pick]").forEach((el) => el.addEventListener("click", async () => {
      const n = notes.find((n) => n.id === el.dataset.pick);
      await addCard(b, { type: "note", box: n.box.id, noteId: n.id, x: Math.round(at.x), y: Math.round(at.y) });
      at = { x: at.x + 30, y: at.y + 30 }; el.remove();
    }));
  }

  pickImage(at) {
    const b = this.board;
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({ type: "image", callback: async (path) => {
      const res = await ask("Picture caption", `<label>Caption (optional)</label><input type="text" name="caption" autofocus>`, [{ action: "ok", label: "Pin it" }]);
      await addCard(b, { type: "image", src: path, caption: String(res?.caption ?? "").slice(0, 80), x: Math.round(at.x), y: Math.round(at.y) });
    } }).render({ force: true });
  }

  showNotes(entryUuid) {
    const notes = allNotes().filter((n) => n.uuid === entryUuid);
    const wall = notes.map((n) => `<div class="vcb-pick" style="background:${paperFor(n.who)};cursor:default;max-height:none"><div style="font-size:10px;opacity:.75">${esc(n.pageName ?? "")}</div>${n.html}<div style="font-size:10px;text-align:right"><b>${esc(n.who)}</b> · ${esc(n.date)}</div></div>`).join("");
    new DialogV2({ window: { title: `Party Notes on ${notes[0]?.entry.name ?? "this journal"}` }, position: { width: 720 }, content: `<div class="vcb-notewall">${wall}</div>`, buttons: [{ action: "close", label: "Close" }] }).render({ force: true });
  }

  async editString(s, ends) {
    const b = this.board;
    const cards = F(b, "cards") ?? {};
    const A = resolve(cards[s?.a ?? ends.a] ?? {}), B = resolve(cards[s?.b ?? ends.b] ?? {});
    const bothJournals = A.entryUuid && B.entryUuid && A.entryUuid !== B.entryUuid;
    const res = await ask(s ? "String" : "Tie a string", `<label>What connects them? (optional)</label><input type="text" name="label" value="${esc(s?.label ?? "")}" maxlength="60" autofocus>
<label>Colour</label><select name="color">${Object.keys(COLORS).filter((k) => k !== "gold").map((k) => `<option value="${k}" ${k === (s?.color ?? "red") ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select>`,
      [{ action: "ok", label: s ? "Save" : "Tie it", icon: "fa-solid fa-link" }, ...(s ? [{ action: "del", label: "Cut string", icon: "fa-solid fa-scissors" }] : []),
        ...(s && bothJournals ? [{ action: "suggest", label: "Suggest as Related", icon: "fa-solid fa-paper-plane" }] : [])]);
    if (!res) return;
    const label = String(res.label ?? "").slice(0, 60);
    if (res.action === "del") return removeKeys(b, [["strings", s.id]]);
    if (res.action === "suggest") {
      const box = outboxes().find((j) => j.getFlag(PN, "outboxFor") === game.user.id);
      if (!box) return ui.notifications.warn("Your Party Notes journal is not set up yet. Ask the Keeper to open the Party Notes macro once.");
      const links = foundry.utils.deepClone(box.getFlag(PN, "links") ?? []);
      links.push({ id: foundry.utils.randomID(), a: A.entryUuid, b: B.entryUuid, an: A.sub && A.kind !== "sticky" && cards[s.a].uuid !== A.entryUuid ? A.sub : (fromUuidSync(A.entryUuid)?.name ?? ""), bn: fromUuidSync(B.entryUuid)?.name ?? "", reason: label || "Tied together on the corkboard", who: who(game.user), ts: Date.now() });
      links.at(-1).an = fromUuidSync(A.entryUuid)?.name ?? "";
      await box.update({ [`flags.${PN}.links`]: links });
      await b.update({ [`flags.${MOD}.strings.${s.id}.label`]: label, [`flags.${MOD}.strings.${s.id}.color`]: res.color });
      return ui.notifications.info("Suggestion sent. The Keeper will review it in Party Notes.");
    }
    if (s) await b.update({ [`flags.${MOD}.strings.${s.id}.label`]: label, [`flags.${MOD}.strings.${s.id}.color`]: res.color });
    else { const id = foundry.utils.randomID(); await b.update({ [`flags.${MOD}.strings.${id}`]: { id, a: ends.a, b: ends.b, label, color: res.color || "red", by: game.user.id, who: who(game.user), ts: Date.now() } }); }
  }

  async newKeeperBoard() {
    const res = await ask("New Keeper board", `<label>Board name</label><input type="text" name="name" value="Keeper Board" autofocus><p>Only Keepers can see it. Change its ownership in the Journal sidebar to share it.</p>`, [{ action: "ok", label: "Create" }, { action: "cancel", label: "Cancel" }]);
    if (res?.action !== "ok" || !String(res.name).trim()) return;
    const folder = game.folders.find((f) => f.type === "JournalEntry" && f.name === FOLDER);
    const j = await JournalEntry.create({ name: String(res.name).trim(), folder: folder?.id, ownership: { default: L().NONE }, flags: { [MOD]: { board: { kind: "keeper" }, cards: {}, strings: {} } }, pages: [{ name: "Info", type: "text", text: { content: "<p>A Keeper corkboard. Open it with the corkboard button.</p>", format: 1 } }] });
    this.setBoard(j.id); this.render();
  }
}

async function addCard(board, data) {
  const id = foundry.utils.randomID();
  await board.update({ [`flags.${MOD}.cards.${id}`]: { id, size: 1, stamp: "", by: game.user.id, who: who(game.user), ts: Date.now(), ...data } });
  return id;
}

// ---------- opening, and pinning from a journal ----------
const app = () => foundry.applications.instances.get(MOD);
async function open(boardId) {
  let a = app();
  if (!a) a = new Corkboard();
  if (boardId && a.boardId !== boardId) a.setBoard(boardId);
  await a.render({ force: true });
  a.bringToFront?.();
  return a;
}
async function pinFromSheet(sheet) {
  const entry = sheet.document;
  const page = sheet.pageId ? entry.pages.get(sheet.pageId) : null;
  const list = boards().filter(canEdit);
  if (!list.length) return ui.notifications.warn("You have no corkboard you can pin to yet.");
  const a = app();
  let last = null; try { last = localStorage.getItem(`${MOD}.last`); } catch (e) { /* ignore */ }
  const current = a?.board && list.includes(a.board) ? a.board.id : (list.find((b) => b.id === last) ?? list[0]).id;
  const res = await ask("Pin to corkboard", `<label>Pin what?</label><select name="what">${page ? `<option value="page">This page: ${esc(page.name)}</option>` : ""}<option value="entry">The whole journal: ${esc(entry.name)}</option></select>
<label>Which board?</label><select name="board">${list.map((b) => `<option value="${b.id}" ${b.id === current ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>`,
    [{ action: "ok", label: "Pin it", icon: "fa-solid fa-thumbtack" }, { action: "cancel", label: "Cancel" }]);
  if (res?.action !== "ok") return;
  const board = game.journal.get(res.board); if (!board) return;
  const uuid = res.what === "page" && page ? page.uuid : entry.uuid;
  if (cardsOf(board).some((c) => c.uuid === uuid)) ui.notifications.info("That is already on the board.");
  else {
    const n = cardsOf(board).length;
    let at = { x: 60 + (n % 5) * 240, y: 60 + Math.floor(n / 5) * 260 };
    if (a?.rendered && a.boardId === board.id) { const r = a.element.querySelector(".vcb-view").getBoundingClientRect(); at = { x: Math.round((r.width / 2 - a.pan.x) / a.zoom - 100 + Math.random() * 80), y: Math.round((r.height / 2 - a.pan.y) / a.zoom - 100 + Math.random() * 80) }; }
    await addCard(board, { type: "doc", uuid, ...at });
    ui.notifications.info(`Pinned to ${board.name}.`);
  }
  const w = await open(board.id);
  const pos = sheet.position;
  if (pos && !a) w.setPosition({ left: Math.max(0, Math.min(pos.left + pos.width + 8, window.innerWidth - 700)), top: pos.top });
}
function partyNote(sheet) {
  if (globalThis.__pnOpen) return globalThis.__pnOpen(sheet);
  const m = game.macros.getName("Party Notes");
  if (!m) return ui.notifications.warn("The Party Notes macro was not found.");
  globalThis.__pnLastSheet = sheet;
  return m.execute();
}

// ---------- hooks ----------
const api = { open, pinFromSheet, ensureSetup };
globalThis.VoidCorkboard = api;
Hooks.once("init", () => {
  const m = game.modules.get(MOD); if (m) m.api = api;
  game.keybindings.register(MOD, "open", { name: "Open the corkboard", editable: [{ key: "KeyB", modifiers: ["Shift"] }], onDown: () => { open(); return true; } });
});
Hooks.once("ready", async () => {
  try { await ensureSetup(); } catch (e) { console.error(MOD, e); }
});
// keep every open board live
const refresh = foundry.utils.debounce(() => app()?.refresh(), 60);
for (const h of ["updateJournalEntry", "createJournalEntry", "deleteJournalEntry", "updateJournalEntryPage", "createJournalEntryPage", "deleteJournalEntryPage", "updateActor", "updateItem"]) Hooks.on(h, refresh);
// a new player joined: make sure they have a board
Hooks.on("createUser", () => ensureSetup().catch(() => {}));

// buttons on every journal window; opening a board journal opens the corkboard instead
Hooks.on("renderApplicationV2", (sheet) => {
  const doc = sheet.document;
  if (!(doc instanceof JournalEntry) || sheet.id === MOD) return;
  if (isBoard(doc)) { sheet.close({ animate: false }); open(doc.id); return; }
  if (isPNJournal(doc)) return;
  const header = sheet.window?.header ?? sheet.element?.querySelector(".window-header");
  if (!header || header.querySelector(".vcb-hdr")) return;
  const mk = (icon, tip, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = `header-control icon ${icon} vcb-hdr`; b.dataset.tooltip = tip; b.setAttribute("aria-label", tip); b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); }); return b; };
  const before = header.querySelector("button.header-control") ?? null;
  header.insertBefore(mk("fa-solid fa-thumbtack", "Pin to corkboard", () => pinFromSheet(sheet)), before);
  if (globalThis.__pnOpen || game.macros.getName("Party Notes")) header.insertBefore(mk("fa-regular fa-note-sticky", "Party Note", () => partyNote(sheet)), before);
});
// corkboard button in the left toolbar and at the top of the Journal sidebar
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    const tool = { name: "corkboard", title: "Corkboard", icon: "fa-solid fa-thumbtack", button: true, visible: true, order: 99, onChange: () => open() };
    for (const key of ["tokens", "notes"]) { const g = Array.isArray(controls) ? controls.find((c) => c.name === key || c.name === "token") : controls[key]; if (!g) continue; if (Array.isArray(g.tools)) g.tools.push({ ...tool, onClick: () => open() }); else g.tools.corkboard = { ...tool }; }
  } catch (e) { console.warn(MOD, e); }
});
Hooks.on("renderJournalDirectory", (dir, html) => {
  const el = html instanceof HTMLElement ? html : html?.[0]; if (!el || el.querySelector(".vcb-open")) return;
  const target = el.querySelector(".header-actions") ?? el.querySelector(".directory-header");
  if (!target) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "vcb-open"; b.innerHTML = `<i class="fa-solid fa-thumbtack"></i> Corkboard`;
  b.addEventListener("click", () => open()); target.append(b);
});
