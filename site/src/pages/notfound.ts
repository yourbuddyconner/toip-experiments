import { u } from "../../build/config";
import { html } from "../../build/html";
import type { Page } from "../layout";

export function notFoundPage(): Page {
  const body = html`
<div class="wrap">
  <div class="page-head prose">
    <h1>No page here</h1>
    <p class="lede">Nothing is published at this address. If you followed a Trust Task type URI, the type may have been renamed or removed.</p>
    <ul>
      <li><a href="${u("/spec/")}">Every Trust Task type</a></li>
      <li><a href="${u("/quickstart/")}">The quickstart</a></li>
      <li><a href="${u("/")}">The home page</a></li>
    </ul>
  </div>
</div>`;
  return { path: "/404.html", title: "Not found", description: "No page at this address.", section: "none", body };
}
