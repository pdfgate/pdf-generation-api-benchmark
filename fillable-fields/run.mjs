// Sends test-form.html (or an API's own version of it) to every API with a key in ../.env,
// with fillable fields turned on, and saves results/<api>.pdf plus timing to results/summary.json.
//
//   node --env-file=../.env run.mjs            # all APIs with a key
//   node --env-file=../.env run.mjs pdfgate    # one API
//   RUNS=5 node --env-file=../.env run.mjs     # repeat for an average time
//
// Then: node verify.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const read = (f) => readFile(new URL(f, import.meta.url), "utf8");
// FORM=<name> runs another form (its DocRaptor version is <name>-docraptor.html) into results-<name>/
const FORM = process.env.FORM ?? "test-form";
const HTML = await read(`./${FORM}.html`);
const OUT = new URL(FORM === "test-form" ? "./results/" : `./results-${FORM}/`, import.meta.url);
const RUNS = Number(process.env.RUNS ?? 1);

async function ok(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 400)}`);
  return res;
}
const bytes = async (res) => Buffer.from(await (await ok(res)).arrayBuffer());
const download = async (url) => bytes(await fetch(url));

const providers = {
  pdfgate: {
    env: "PDFGATE_API_KEY",
    async render(key) {
      // PDFGATE_API_URL=http://localhost:3005 to test a local build
      const base = process.env.PDFGATE_API_URL ?? (key.startsWith("test_") ? "https://api-sandbox.pdfgate.com" : "https://api.pdfgate.com");
      return bytes(await fetch(`${base}/v1/generate/pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ html: HTML, pageSizeType: "a4", printBackground: true, enableFormFields: true, waitForNetworkIdle: true }),
      }));
    },
  },

  pdfcrowd: {
    env: "PDFCROWD_API_KEY",
    async render(key) {
      const auth = Buffer.from(`${process.env.PDFCROWD_USERNAME}:${key}`).toString("base64");
      return bytes(await fetch("https://api.pdfcrowd.com/convert/latest/", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}` },
        body: new URLSearchParams({ text: HTML, page_size: "A4", output_format: "pdf", enable_pdf_forms: "true" }),
      }));
    },
  },

  nutrient: {
    env: "NUTRIENT_API_KEY",
    // Fields come from standard inputs; nothing to switch on.
    async render(key) {
      const form = new FormData();
      form.append("instructions", JSON.stringify({ parts: [{ html: "index.html" }] }));
      form.append("index.html", new Blob([HTML], { type: "text/html" }), "index.html");
      return bytes(await fetch("https://api.nutrient.io/build", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }));
    },
  },

  docraptor: {
    env: "DOCRAPTOR_API_KEY",
    // Prince needs its CSS rule on the inputs; test-form-docraptor.html adds it.
    // test: true is free and watermarked; DOCRAPTOR_TEST=false for a clean output.
    async render(key) {
      const html = await read(`./${FORM}-docraptor.html`);
      return bytes(await fetch("https://api.docraptor.com/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_credentials: key,
          doc: { test: process.env.DOCRAPTOR_TEST !== "false", document_type: "pdf", document_content: html, javascript: false, name: "form.pdf" },
        }),
      }));
    },
  },

  pdfmonkey: {
    env: "PDFMONKEY_API_KEY",
    // Template based; fields come from PDFMonkey's markers in test-form-pdfmonkey.html.
    async setup(key, meta) {
      const html = await read("./test-form-pdfmonkey.html");
      const tpl = await (await ok(await fetch("https://api.pdfmonkey.io/api/v1/document_templates", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          document_template: {
            identifier: `form-benchmark-${Date.now()}`, edition_mode: "code",
            body: html, body_draft: html, settings: { use_forms: true }, settings_draft: { use_forms: true },
          },
        }),
      }))).json();
      meta.templateId = tpl.document_template.id;
    },
    async render(key, meta) {
      const doc = await (await ok(await fetch("https://api.pdfmonkey.io/api/v1/documents/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ document: { document_template_id: meta.templateId, status: "pending", payload: {} } }),
      }))).json();
      const card = doc.document_card ?? doc.document;
      if (card.status !== "success") throw new Error(`status ${card.status}: ${card.failure_cause ?? ""}`);
      return download(card.download_url);
    },
  },

  jsreport: {
    env: "JSREPORT_ONLINE_URL",
    // jsreport online: fields come from {{{pdfFormField}}} helpers in test-form-jsreport.html.
    async render(url) {
      const html = await read("./test-form-jsreport.html");
      const auth = Buffer.from(`${process.env.JSREPORT_ONLINE_USER}:${process.env.JSREPORT_ONLINE_PASSWORD}`).toString("base64");
      return bytes(await fetch(`${url.replace(/\/$/, "")}/api/report`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          template: { content: html, engine: "handlebars", recipe: "chrome-pdf", chrome: { format: "A4", printBackground: true } },
          data: {},
        }),
      }));
    },
  },

  // Reference: plain Puppeteer, no fields expected. Set PUPPETEER=1 to include.
  puppeteer: {
    env: "PUPPETEER",
    async render() {
      const { default: puppeteer } = await import("puppeteer");
      const browser = await puppeteer.launch();
      try {
        const page = await browser.newPage();
        await page.setContent(HTML, { waitUntil: "networkidle0" });
        return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      } finally {
        await browser.close();
      }
    },
  },
};

await mkdir(OUT, { recursive: true });
const only = process.argv.slice(2);
const SUMMARY = new URL("summary.json", OUT);
const summary = await readFile(SUMMARY, "utf8").then(JSON.parse).catch(() => ({}));

for (const [name, p] of Object.entries(providers)) {
  if (only.length && !only.includes(name)) continue;
  const key = process.env[p.env];
  if (!key) { console.log(`- ${name}: skipped (no ${p.env})`); continue; }
  const timings = [], meta = {};
  let pdf, error;
  if (p.setup) { try { await p.setup(key, meta); } catch (e) { error = `setup: ${e.message}`; } }
  for (let i = 0; i < RUNS && !error; i++) {
    const t0 = performance.now();
    try { pdf = await p.render(key, meta); timings.push(Math.round(performance.now() - t0)); }
    catch (e) { error = e.message; break; }
  }
  if (error) { summary[name] = { error }; console.log(`✗ ${name}: ${error}`); continue; }
  await writeFile(new URL(`${name}.pdf`, OUT), pdf);
  summary[name] = {
    testedAt: new Date().toISOString(),
    sizeKB: Math.round(pdf.length / 1024),
    msAverage: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
    msAll: timings,
  };
  console.log(`✓ ${name}: ${summary[name].msAverage} ms, ${summary[name].sizeKB} KB`);
}
await writeFile(SUMMARY, JSON.stringify(summary, null, 2));
