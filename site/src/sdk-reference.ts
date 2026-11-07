import { gh, u } from "../build/config";
import { code } from "../build/highlight";
import { html, md, type Raw } from "../build/html";
import type { ApiMember, ApiModule, ApiParameter, ApiSignature, ApiSymbol } from "../build/sdk-api";
import { docsNav } from "./docs-nav";
import type { Page } from "./layout";

/** The package a module belongs to: "@toip-tools/x" for "@toip-tools/x/sub". */
const libraryName = (module: ApiModule) => module.name.split("/").slice(0, 2).join("/");

export function apiModulePath(module: ApiModule): string {
  return `/toolkit/${module.library}/api/${module.subpath === "." ? "" : `${module.subpath.slice(2)}/`}`;
}
export const apiSymbolPath = (module: ApiModule, symbol: ApiSymbol) => `${apiModulePath(module)}${encodeURIComponent(symbol.name)}/`;

export function findApi(modules: ApiModule[], library: string, name: string): { module: ApiModule; symbol: ApiSymbol } | undefined {
  for (const module of modules.filter(m => m.library === library)) {
    const symbol = module.symbols.find(s => s.name === name);
    if (symbol) return { module, symbol };
  }
  return undefined;
}

function typeMarkup(text: string, module: ApiModule, all: ApiModule[]): Raw {
  let end = 0;
  const parts: (Raw | string)[] = [];
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    parts.push(text.slice(end, match.index));
    const name = match[0];
    const local = module.symbols.find(s => s.name === name);
    const sameLibrary = local ? { module, symbol: local } : findApi(all, module.library, name);
    const global = sameLibrary ? [] : all.flatMap(m => m.symbols.filter(s => s.name === name).map(symbol => ({ module: m, symbol })));
    const ref = sameLibrary ?? (global.length === 1 ? global[0] : undefined);
    parts.push(ref ? html`<a href="${u(apiSymbolPath(ref.module, ref.symbol))}">${name}</a>` : name);
    end = match.index + name.length;
  }
  parts.push(text.slice(end));
  return html`<code class="api-type">${parts}</code>`;
}

function fields(items: (ApiParameter | ApiMember)[], module: ApiModule, all: ApiModule[]): Raw {
  return html`<dl class="api-fields">${items.map(item => {
    const flags = `${item.optional ? "optional" : "required"}${"readonly" in item && item.readonly ? " · readonly" : ""}${"static" in item && item.static ? " · static" : ""}`;
    return html`<div>
    <dt><code>${item.name}</code><span data-md=" (${flags})">${flags}</span></dt>
    <dd>${typeMarkup(item.type, module, all)}
      ${item.description ? html`<div class="api-description">${md(item.description)}</div>` : ""}
      ${"defaultValue" in item && item.defaultValue !== undefined ? html`<p class="api-default">Default: <code>${item.defaultValue}</code></p>` : ""}
      ${"properties" in item && item.properties.length ? html`<details class="api-options"><summary>Fields of <code>${item.name}</code></summary>${fields(item.properties, module, all)}</details>` : ""}
    </dd>
  </div>`;
  })}</dl>`;
}

function signature(signature: ApiSignature, module: ApiModule, all: ApiModule[], opts: { name: string; member?: boolean; construct?: boolean }): Raw {
  const title = opts.member ? (s: string) => html`<h4>${s}</h4>` : (s: string) => html`<h3>${s}</h3>`;
  const text = opts.construct ? signature.text : `${opts.name}${signature.text}`;
  return html`<div class="sdk-signature">${code(text, "ts", { caption: opts.construct ? "Constructor" : "Signature" })}</div>
    ${signature.parameters.length ? html`${title("Parameters")}${fields(signature.parameters, module, all)}` : html`<p class="small quiet">No parameters.</p>`}
    ${title("Returns")}
    <div class="api-return">${typeMarkup(signature.returns, module, all)}${signature.returnDescription ? md(signature.returnDescription) : ""}</div>`;
}

function memberSections(members: ApiMember[], module: ApiModule, all: ApiModule[]): Raw {
  const properties = members.filter(m => !m.signatures.length);
  const methods = members.filter(m => m.signatures.length);
  return html`${properties.length ? html`<h2 id="properties">Properties</h2>${fields(properties, module, all)}` : ""}
    ${methods.length ? html`<h2 id="methods">Methods</h2>${methods.map(m => html`<section class="api-method" id="member-${encodeURIComponent(m.name)}">
      <h3><code>${m.static ? "static " : ""}${m.name}</code></h3>
      ${m.description ? html`<div class="prose">${md(m.description)}</div>` : ""}
      ${m.signatures.map(s => signature(s, module, all, { name: m.name, member: true }))}
    </section>`)}` : ""}`;
}

const kindTitle: Record<ApiSymbol["kind"], string> = { function: "Functions", class: "Classes", interface: "Interfaces", type: "Types", constant: "Constants", enum: "Enums" };

export function moduleIndex(module: ApiModule, all: ApiModule[]): Page {
  const path = apiModulePath(module);
  const kinds = Object.keys(kindTitle) as ApiSymbol["kind"][];
  const active = kinds.filter(kind => module.symbols.some(s => s.kind === kind));
  const body = html`<div class="wrap docs">${docsNav(path, active.map(k => ({ label: kindTitle[k], href: `#${k}` })))}<div class="docs__content">
    <div class="doc-breadcrumbs" data-md-skip><a href="${u("/toolkit/")}">SDK reference</a><span>/</span><a href="${u(`/toolkit/${module.library}/`)}">${module.library}</a><span>/</span><span>API</span></div>
    <div class="page-head"><p class="eyebrow">API reference · ${module.runtime}</p><h1 class="mono">${module.name}</h1><p class="lede">${module.symbols.length} public exports.</p></div>
    ${code(`import { ${module.symbols.slice(0, 3).map(s => `${["interface", "type"].includes(s.kind) ? "type " : ""}${s.name}`).join(", ")} } from "${module.name}";`, "ts", { caption: "Module import" })}
    ${active.map(kind => html`<section class="sdk-api-group" id="${kind}"><h2>${kindTitle[kind]}</h2><ul class="sdk-export-list">${module.symbols.filter(s => s.kind === kind).map(symbol => html`<li>
      <a href="${u(apiSymbolPath(module, symbol))}"><code>${symbol.name}</code></a>
      ${symbol.description ? html`<p>${symbol.description.split(/\n|(?<=\.)\s/)[0]}</p>` : ""}
    </li>`)}</ul></section>`)}
    <p class="small quiet">Signatures and source documentation are generated from <a href="${gh(module.file)}"><code>${module.file}</code></a>.</p>
  </div></div>`;
  return {
    path, title: `${module.name} API`, seoTitle: `${module.name} API reference: all ${module.symbols.length} exports · toip.tools`,
    description: `Every public function, class, interface, type and constant exported by ${module.name} (${module.runtime}), with signatures and source links.`,
    section: "toolkit", kind: "reference", eyebrow: "API reference", monoTitle: true, ogFooter: `npm install ${libraryName(module)}`,
    sources: [module.file], tools: true, body,
  };
}

export function symbolPage(module: ApiModule, symbol: ApiSymbol, all: ApiModule[]): Page {
  const path = apiSymbolPath(module, symbol);
  const local = [{ label: "Declaration", href: "#declaration" }];
  if (symbol.members.some(m => !m.signatures.length)) local.push({ label: "Properties", href: "#properties" });
  if (symbol.members.some(m => m.signatures.length)) local.push({ label: "Methods", href: "#methods" });
  if (symbol.returnedMembers.length) local.push({ label: "Returned object", href: "#returned-object" });
  const body = html`<div class="wrap docs">${docsNav(path, local)}<div class="docs__content">
    <div class="doc-breadcrumbs" data-md-skip><a href="${u("/toolkit/")}">SDK reference</a><span>/</span><a href="${u(`/toolkit/${module.library}/`)}">${module.library}</a><span>/</span><a href="${u(apiModulePath(module))}">API</a></div>
    <div class="page-head"><p class="eyebrow">${symbol.kind} · ${module.runtime}</p><h1 class="mono">${symbol.name}</h1>${symbol.description ? html`<div class="prose">${md(symbol.description)}</div>` : ""}</div>
    <div class="sdk-source"><code>${module.name}</code><a href="${gh(symbol.source.file)}#L${symbol.source.line}">View source</a></div>
    ${symbol.deprecated !== undefined ? html`<div class="sdk-note"><strong>Deprecated</strong>${md(symbol.deprecated || "This export is marked deprecated in the source.")}</div>` : ""}
    ${code(`import { ${["interface", "type"].includes(symbol.kind) ? "type " : ""}${symbol.name} } from "${module.name}";`, "ts", { caption: "Import" })}
    <h2 id="declaration">${symbol.kind === "class" ? "Constructor" : "Declaration"}</h2>
    ${symbol.kind === "class" && !symbol.signatures.length ? html`<p class="prose">This class has no public constructor. Use its public factory methods below to create an instance.</p>` : ""}
    ${symbol.kind === "function" || symbol.kind === "class"
      ? symbol.signatures.map(s => signature(s, module, all, { name: symbol.name, construct: symbol.kind === "class" }))
      : html`<div class="sdk-signature">${code(symbol.declaration, "ts", { caption: symbol.kind })}</div>`}
    ${memberSections(symbol.members, module, all)}
    ${symbol.returnedMembers.length ? html`<h2 id="returned-object">Returned object</h2><p class="prose">The returned object exposes these properties and methods.</p>${memberSections(symbol.returnedMembers, module, all)}` : ""}
    ${symbol.throws.length ? html`<h2>Throws</h2><div class="prose">${symbol.throws.map(t => md(t))}</div>` : ""}
    <div class="sdk-next"><a href="${u(`/toolkit/${module.library}/#usage`)}">Usage guide</a><a href="${u(`/toolkit/${module.library}/#errors`)}">Error handling</a><a href="${u(apiModulePath(module))}">All exports</a></div>
  </div></div>`;
  const summary = symbol.description.split(/\n|(?<=\.)\s/)[0];
  return {
    path, title: `${symbol.name} · ${module.name}`, seoTitle: `${symbol.name} (${symbol.kind}) · ${module.name} API reference`,
    description: summary ? `${symbol.name}, a ${symbol.kind} in ${module.name}: ${summary}` : `${symbol.name}: a ${symbol.kind} exported by ${module.name}, with its declaration and source.`,
    section: "toolkit", kind: "reference", eyebrow: `API · ${symbol.kind}`, monoTitle: true, ogTitle: symbol.name,
    ogText: summary ? `${module.name}: ${summary}` : `A ${symbol.kind} exported by ${module.name}.`,
    ogFooter: `import { ${symbol.name} } from "${module.name}"`, sources: [symbol.source.file], tools: true, body,
  };
}
