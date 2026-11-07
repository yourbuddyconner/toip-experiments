import { gh, ghTree, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html } from "../../build/html";
import { projects } from "../data/projects";
import type { Page } from "../layout";
import { libLinks, pageHead, status } from "../parts";

export function examplesPage(): Page {
  const body = html`
<div class="wrap docs">
  <nav class="docs__side" aria-label="Projects">
    <p class="side-h">Projects</p>
    <ul>${projects.map((p) => html`<li><a href="#${p.slug}">${p.name}</a></li>`)}</ul>
  </nav>
  <div>
    ${pageHead("Ideas you can run", "Explore the toolkit through payments, private collaboration, anonymous speech, and agent delegation. Each project has a written design; working examples include commands to run them locally.")}
    <div class="prose">
      <p><strong>Working</strong> projects run and have tests. <strong>Being built</strong> projects have a design and an implementation in progress. <strong>Design only</strong> projects are proposals ready to build.</p>
      ${code("git clone https://github.com/yourbuddyconner/toip-experiments.git\ncd toip-experiments\nnpm install", "bash", { caption: "Set up the repository once" })}
    </div>
    ${projects.map(
      (p) => html`<section class="project" id="${p.slug}" aria-labelledby="${p.slug}-h">
      <h2 id="${p.slug}-h">${p.name} ${status(p.status)}</h2>
      <div class="prose">
        <p>${p.pitch}</p>
        <h3>What it shows</h3>
        <ul>${p.demonstrates.map((d) => html`<li>${d}</li>`)}</ul>
        <p>${
          p.libraries.length
            ? html`Built on ${libLinks(p.libraries)}.`
            : html`Designed using the <a href="https://github.com/OpenVTC">OpenVTC</a> TypeScript libraries directly.`
        }${p.specs ? html` Message reference: <a href="${u(`/spec/#${p.specs}`)}"><code>${p.specs}/…</code> Trust Tasks</a>.` : ""}</p>
      </div>
      ${
        p.run
          ? html`<div class="prose"><h3>Run it</h3></div>${p.run.map((r) => code(r.cmd, "bash", { caption: r.what }))}`
          : html`<div class="prose"><h3>Build status</h3><p>${p.coming ? html`${p.coming}` : html`The design is ready for an implementation. Read it below, or <a href="${u("/get-involved/#propose")}">help build it</a>.`}</p></div>`
      }
      ${
        p.shots
          ? html`<div class="shots">${p.shots.map(
              (s) => html`<figure><a href="${u(`/${s.src}`)}"><img src="${u(`/${s.src}`)}" alt="${s.alt}" width="${s.width}" height="${s.height}" loading="lazy" decoding="async"></a><figcaption>${s.caption}</figcaption></figure>`,
            )}</div>`
          : ""
      }
      <p class="prose">Read ${p.name}'s <a href="${gh(`projects/${p.slug}/README.md`)}">README</a> and <a href="${gh(`projects/${p.slug}/docs/design.md`)}">design</a>, or browse <a href="${ghTree(`projects/${p.slug}`)}">its source</a>.</p>
    </section>`,
    )}
  </div>
</div>`;
  return {
    path: "/examples/",
    title: "Examples",
    description: "Run Trust over IP examples for payments, collaboration, anonymous speech, agent delegation, and audit trails. Explore the designs and the libraries behind them.",
    section: "examples",
    body,
  };
}
