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
    <h2>Projects</h2>
    <ul>${projects.map((p) => html`<li><a href="#${p.slug}">${p.name}</a></li>`)}</ul>
  </nav>
  <div>
    ${pageHead("Examples", "What people have built on the toolkit, and what's being built now. Every project has a design you can read; the working ones run with one command from the repository root.")}
    <div class="prose">
      <p><strong>Working</strong> means it runs today and has tests. <strong>Being built</strong> means the design is done and an MVP is being written now. <strong>Design only</strong> means there's a design and no code yet.</p>
      ${code("git clone https://github.com/yourbuddyconner/toip-experiments.git\ncd toip-experiments\nnpm install", "bash", { caption: "Once, before running any of them" })}
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
            : html`Designed directly on the <a href="https://github.com/OpenVTC">OpenVTC</a> TypeScript libraries rather than this toolkit.`
        }${p.specs ? html` Its messages are the <a href="${u(`/spec/#${p.specs}`)}"><code>${p.specs}/…</code> Trust Task types</a>.` : ""}</p>
      </div>
      ${
        p.run
          ? html`<div class="prose"><h3>Run it</h3></div>${p.run.map((r) => code(r.cmd, "bash", { caption: r.what }))}`
          : html`<div class="prose"><h3>Run it</h3><p>${p.coming ? html`Coming. ${p.coming}` : html`Not built yet. Read the design, or <a href="${u("/get-involved/#propose")}">build it yourself</a>.`}</p></div>`
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
    description: "Settle, Shared To-Do, and the projects being built on the Trust over IP toolkit: what each shows, which libraries it uses, and how to run it.",
    section: "examples",
    body,
  };
}
