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
