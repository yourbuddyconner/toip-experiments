import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight } from "./highlight";

for (const [lang, source] of [
  ["ts", '// A request\nconst message: string = "hello";\nawait send(message);'],
  ["bash", '# Build the site\ncd site && npm run build --workspace "site"'],
  ["json", '{ "message": "hello", "count": 42, "verified": true }'],
] as const) {
  test(`${lang} examples render distinct syntax colors`, () => {
    const rendered = highlight(source, lang);
    const colors = new Set([...rendered.matchAll(/<span style="color:([^";]+)/g)].map((m) => m[1]));
    assert.ok(colors.size >= 3, `Expected at least three syntax colors, got ${[...colors].join(", ")}`);
    assert.match(rendered, /<pre tabindex="0"/);
  });
}

test("plain output escapes HTML and preserves whitespace", () => {
  assert.equal(highlight('  <result> & "value"\n', "console"), '<pre class="shiki" tabindex="0"><code>  &lt;result&gt; &amp; &quot;value&quot;</code></pre>');
});
