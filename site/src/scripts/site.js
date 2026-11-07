// Progressive enhancement only. Without this file every page reads the same.

// Copy buttons on code blocks (not on output).
for (const fig of document.querySelectorAll("figure.code:not(.code--output)")) {
  const pre = fig.querySelector("pre");
  if (!pre || !navigator.clipboard) continue;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy";
  btn.textContent = "Copy";
  const label = fig.querySelector("figcaption")?.textContent?.trim();
  btn.setAttribute("aria-label", label ? `Copy code: ${label}` : "Copy code");
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ""));
      btn.textContent = "Copied";
      status.textContent = "Copied to the clipboard";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => {
      btn.textContent = "Copy";
      status.textContent = "";
    }, 1800);
  });
  fig.append(btn, status);
}

// "Copy page as Markdown" next to each documentation page's Markdown link. The link works on its own.
for (const link of document.querySelectorAll("[data-copy-markdown]")) {
  if (!navigator.clipboard || !window.fetch) continue;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "page-tools__copy";
  btn.textContent = "Copy page as Markdown";
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  btn.addEventListener("click", async () => {
    try {
      // Safari needs the clipboard write to start inside the click, so hand it a promise of the text.
      const text = fetch(link.href).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      });
      if (typeof ClipboardItem !== "undefined" && ClipboardItem.supports?.("text/plain")) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      btn.textContent = "Copied";
      status.textContent = "Page copied to the clipboard as Markdown";
    } catch {
      btn.textContent = "Couldn't copy: open the Markdown";
    }
    setTimeout(() => {
      btn.textContent = "Copy page as Markdown";
      status.textContent = "";
    }, 2200);
  });
  link.before(btn);
  link.after(status);
}

// The landing page's one moment: the wire fills in, then Bob opens it.
const wire = document.querySelector(".wire");
if (wire) requestAnimationFrame(() => requestAnimationFrame(() => wire.classList.add("play")));

// Search the compiler-generated export catalog; module indexes remain usable without JavaScript.
const apiSearch = document.querySelector("#api-search");
if (apiSearch) {
  const catalog = JSON.parse(document.querySelector("#sdk-search-data").textContent);
  const results = document.querySelector("#api-results");
  const status = document.querySelector("#api-search-status");
  const run = () => {
    const query = apiSearch.value.trim().toLowerCase();
    results.replaceChildren();
    results.hidden = !query;
    if (!query) { status.textContent = ""; return; }
    const terms = query.split(/\s+/);
    const matches = catalog.filter(entry => terms.every(term => `${entry.name} ${entry.module} ${entry.summary} ${entry.keywords}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(b.name.toLowerCase() === query) - Number(a.name.toLowerCase() === query) || Number(b.name.toLowerCase().includes(query)) - Number(a.name.toLowerCase().includes(query)));
    status.textContent = matches.length ? `${matches.length} exports found${matches.length > 20 ? "; showing the first 20" : ""}.` : "No exports found. Try a library or symbol name.";
    for (const entry of matches.slice(0, 20)) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = entry.href;
      link.textContent = entry.name;
      const module = document.createElement("small");
      module.textContent = `${entry.module} · ${entry.kind}`;
      const summary = document.createElement("p");
      summary.textContent = entry.summary;
      item.append(link, module, summary);
      results.append(item);
    }
  };
  apiSearch.addEventListener("input", () => {
    run();
    // Keep the query in the address (?q=), so a search can be shared and linked to.
    const url = new URL(location.href);
    if (apiSearch.value.trim()) url.searchParams.set("q", apiSearch.value.trim());
    else url.searchParams.delete("q");
    history.replaceState(null, "", url);
  });
  apiSearch.form?.addEventListener("submit", (event) => event.preventDefault());
  const initial = new URLSearchParams(location.search).get("q");
  if (initial) {
    apiSearch.value = initial;
    run();
  }
}

// Image links stay usable without JavaScript; enhance them with a native modal.
const imageLinks = document.querySelectorAll(".shots a:has(img)");
if (imageLinks.length && typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function") {
  const dialog = document.createElement("dialog");
  dialog.className = "lightbox";
  dialog.setAttribute("aria-label", "Image preview");
  dialog.innerHTML = `
    <div class="lightbox__toolbar">
      <span>Image preview</span>
      <button type="button" aria-label="Close image preview" autofocus>Close <span aria-hidden="true">×</span></button>
    </div>
    <figure>
      <div class="lightbox__image"><img alt=""></div>
      <figcaption></figcaption>
    </figure>`;
  const expanded = dialog.querySelector("img");
  const caption = dialog.querySelector("figcaption");
  let trigger;
  document.body.append(dialog);

  for (const link of imageLinks) {
    link.setAttribute("aria-haspopup", "dialog");
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      expanded.src = link.href;
      expanded.alt = link.querySelector("img").alt;
      caption.textContent = link.closest("figure")?.querySelector("figcaption")?.textContent ?? expanded.alt;
      dialog.showModal();
    });
  }

  dialog.querySelector("button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => trigger?.focus({ preventScroll: true }));
}
