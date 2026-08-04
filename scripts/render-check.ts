/**
 * Renders the formal-post template with given title/body through Gotenberg —
 * the same fill-and-screenshot Build HTML + Render PNG perform — so template
 * changes can be verified with real text before an operator hits them.
 *
 * Usage: npx tsx scripts/render-check.ts "<title>" "<body>" <out.png>
 */
import { readFileSync, writeFileSync } from "node:fs";

// A 1x1 grey PNG; the photo slot is fixed-height, so text metrics don't care.
const GREY =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNsaGj4DwAFhAJ/l2xtIQAAAABJRU5ErkJggg==";

async function main() {
  const [title, body, out] = process.argv.slice(2);
  const html = readFileSync("/opt/social/template.html", "utf8")
    .replace("{{SIZE_CLASS}}", "post")
    .replace("{{TITLE}}", title)
    .replace("{{DATE}}", "04/08/2026")
    .replace("{{IMAGE_DATA_URI}}", GREY)
    .replace("{{BODY}}", body);

  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  form.append("format", "png");
  form.append("width", "1080");
  form.append("height", "1350");
  const res = await fetch("http://127.0.0.1:3300/forms/chromium/screenshot/html", {
    method: "POST", body: form,
  });
  if (!res.ok) throw new Error(`Gotenberg HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const png = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, png);
  console.log(`rendered ${png.length} bytes -> ${out}`);
}

main();
