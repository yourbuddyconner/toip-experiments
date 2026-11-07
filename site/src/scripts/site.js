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

// The landing page's one moment: the wire fills in, then Bob opens it.
const wire = document.querySelector(".wire");
if (wire) requestAnimationFrame(() => requestAnimationFrame(() => wire.classList.add("play")));

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
