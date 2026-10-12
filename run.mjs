// Sends test-document.html (DocRaptor: test-document-docraptor.html) to every provider with a key in .env, saves each PDF
// and writes timing, size, page count and form-field results to results/summary.json.
//
//   node --env-file=.env run.mjs            # all providers with a key
//   node --env-file=.env run.mjs pdfgate    # one provider
//   RUNS=5 node --env-file=.env run.mjs     # repeat for an average time
//
// Options are kept identical where each API allows it: A4, print backgrounds on,
// JavaScript on, no extra margins (the document sets them via @page).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HTML = await readFile(new URL("./test-document.html", import.meta.url), "utf8");
// DocRaptor (Prince) is not a browser engine, so it gets a version adapted to it:
// ES5 JavaScript, flexbox instead of grid, and its CSS rule for fillable fields.
const DOCRAPTOR_HTML = await readFile(new URL("./test-document-docraptor.html", import.meta.url), "utf8");
// PDFMonkey creates fillable fields only from its own [% data_form_field_… %] markers.
const PDFMONKEY_HTML = await readFile(new URL("./test-document-pdfmonkey.html", import.meta.url), "utf8");
const OUT = new URL("./results/", import.meta.url);
const RUNS = Number(process.env.RUNS ?? 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const base = key.startsWith("test_") ? "https://api-sandbox.pdfgate.com" : "https://api.pdfgate.com";
      return bytes(await fetch(`${base}/v1/generate/pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ html: HTML, pageSizeType: "a4", printBackground: true, enableFormFields: true, waitForNetworkIdle: true }),
      }));
    },
  },

  docraptor: {
    env: "DOCRAPTOR_API_KEY",
    // test: true is free and adds a watermark; set DOCRAPTOR_TEST=false for clean output (counts toward quota).
    // Prince's own JavaScript engine runs the ES5 script, including the canvas chart;
    // DocRaptor's javascript: true option skipped the chart and broke emoji in our tests.
    async render(key) {
      return bytes(await fetch("https://api.docraptor.com/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_credentials: key,
          doc: { test: process.env.DOCRAPTOR_TEST !== "false", document_type: "pdf", document_content: DOCRAPTOR_HTML, javascript: false, prince_options: { javascript: true }, name: "benchmark.pdf" },
        }),
      }));
    },
  },

  pdfco: {
    env: "PDFCO_API_KEY",
    // Sync mode stops at about 27 s, which our document exceeded, so this uses
    // PDF.co's async jobs and polls until the file is ready.
    async render(key) {
      const headers = { "x-api-key": key, "Content-Type": "application/json" };
      const res = await (await ok(await fetch("https://api.pdf.co/v1/pdf/convert/from/html", {
        method: "POST",
        headers,
        body: JSON.stringify({ html: HTML, name: "benchmark.pdf", paperSize: "A4", printBackground: true, margins: "0px", async: true }),
      }))).json();
      if (res.error) throw new Error(res.message);
      for (let i = 0; i < 300; i++) {
        const job = await (await ok(await fetch("https://api.pdf.co/v1/job/check", {
          method: "POST",
          headers,
          body: JSON.stringify({ jobid: res.jobId }),
        }))).json();
        if (job.status === "success") return download(res.url);
        if (job.status !== "working") throw new Error(`job ${job.status}: ${job.message ?? ""}`);
        await sleep(500);
      }
      throw new Error("job did not finish in 150 s");
    },
  },

  pdfmonkey: {
    env: "PDFMONKEY_API_KEY",
    // Template based: the template is created once in setup (not timed), the way
    // PDFMonkey is used in practice; each timed request generates a document from it.
    async setup(key, meta) {
      const tpl = await (await ok(await fetch("https://api.pdfmonkey.io/api/v1/document_templates", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          document_template: {
            identifier: `benchmark-${Date.now()}`,
            edition_mode: "code",
            body: PDFMONKEY_HTML,
            body_draft: PDFMONKEY_HTML,
            settings: { use_forms: true },
            settings_draft: { use_forms: true },
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

  api2pdf: {
    env: "API2PDF_API_KEY",
    async render(key, meta) {
      const res = await (await ok(await fetch("https://v2.api2pdf.com/chrome/pdf/html", {
        method: "POST",
        headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({ html: HTML, inline: false, fileName: "benchmark.pdf", options: { printBackground: true, preferCSSPageSize: true } }),
      }))).json();
      if (!res.Success) throw new Error(res.Error);
      meta.reportedCost = res.Cost;
      return download(res.FileUrl);
    },
  },

  convertapi: {
    env: "CONVERTAPI_TOKEN",
    async render(key) {
      const res = await (await ok(await fetch("https://v2.convertapi.com/convert/html/to/pdf", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          Parameters: [
            { Name: "File", FileValue: { Name: "benchmark.html", Data: Buffer.from(HTML).toString("base64") } },
            { Name: "PageSize", Value: "a4" },
            { Name: "Background", Value: true },
            // Defaults lay the page out in a 1366px-wide window and shrink it onto A4, with
            // screen styles. These make ConvertAPI behave like Chrome's print-to-PDF.
            { Name: "RespectViewport", Value: false },
            { Name: "CssMediaType", Value: "print" },
            { Name: "StoreFile", Value: false },
          ],
        }),
      }))).json();
      return Buffer.from(res.Files[0].FileData, "base64");
    },
  },

  cloudconvert: {
    env: "CLOUDCONVERT_API_KEY",
    async render(key) {
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      const job = await (await ok(await fetch("https://api.cloudconvert.com/v2/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tasks: {
            import: { operation: "import/raw", file: HTML, filename: "benchmark.html" },
            convert: { operation: "convert", input: "import", input_format: "html", output_format: "pdf", engine: "chrome", page_format: "a4", print_background: true },
            export: { operation: "export/url", input: "convert" },
          },
        }),
      }))).json();
      const done = await (await ok(await fetch(`https://sync.api.cloudconvert.com/v2/jobs/${job.data.id}`, { headers }))).json();
      const exp = done.data.tasks.find((t) => t.name === "export");
      if (done.data.status !== "finished") throw new Error(JSON.stringify(done.data.tasks.map((t) => [t.name, t.status, t.message])));
      return download(exp.result.files[0].url);
    },
  },

  cloudlayer: {
    env: "CLOUDLAYER_API_KEY",
    async render(key) {
      const headers = { "X-API-Key": key, "Content-Type": "application/json" };
      const res = await ok(await fetch("https://api.cloudlayer.io/v2/html/pdf", {
        method: "POST",
        headers,
        body: JSON.stringify({ html: Buffer.from(HTML).toString("base64"), format: "a4", printBackground: true, preferCSSPageSize: true, async: false }),
      }));
      if (res.headers.get("content-type")?.includes("application/pdf")) return Buffer.from(await res.arrayBuffer());
      let job = await res.json();
      for (let i = 0; i < 60 && job.status !== "success" && !job.assetUrl; i++) {
        if (job.status === "error") throw new Error(job.error ?? "job failed");
        await sleep(2000);
        job = await (await ok(await fetch(`https://api.cloudlayer.io/v2/jobs/${job.id}`, { headers }))).json();
      }
      return download(job.assetUrl);
    },
  },

  pdfshift: {
    env: "PDFSHIFT_API_KEY",
    async render(key) {
      return bytes(await fetch("https://api.pdfshift.io/v3/convert/pdf", {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        // use_print: PDFShift renders with screen styles by default, and Chrome then
        // does not repeat table headers across pages
        body: JSON.stringify({ source: HTML, format: "A4", use_print: true }),
      }));
    },
  },

  pdfcrowd: {
    env: "PDFCROWD_API_KEY",
    // Basic auth with username + API key
    async render(key) {
      const auth = Buffer.from(`${process.env.PDFCROWD_USERNAME}:${key}`).toString("base64");
      return bytes(await fetch("https://api.pdfcrowd.com/convert/latest/", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}` },
        body: new URLSearchParams({ text: HTML, page_size: "A4", output_format: "pdf", enable_pdf_forms: "true" }),
      }));
    },
  },

  browserless: {
    env: "BROWSERLESS_TOKEN",
    async render(key) {
      return bytes(await fetch(`https://production-sfo.browserless.io/pdf?token=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          html: HTML,
          options: { format: "A4", printBackground: true, preferCSSPageSize: true },
          gotoOptions: { waitUntil: "networkidle0" },
        }),
      }));
    },
  },

  apitemplate: {
    env: "APITEMPLATE_API_KEY",
    async render(key) {
      const res = await (await ok(await fetch("https://rest.apitemplate.io/v2/create-pdf-from-html", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ body: HTML, css: "", data: {}, settings: { paper_size: "A4", print_background: "1" } }),
      }))).json();
      if (res.status !== "success") throw new Error(JSON.stringify(res));
      return download(res.download_url);
    },
  },

  // Baseline: plain Puppeteer on this machine, what you'd run yourself.
  // Needs `npm install`; set PUPPETEER=1 to include it.
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

async function inspect(file) {
  const out = { pages: null, acroFormFields: null, bitmaps: null };
  try {
    out.pages = Number((await exec("qpdf", ["--show-npages", file])).stdout.trim());
    const json = JSON.parse((await exec("qpdf", ["--json", "--json-key=acroform", "--json-key=pages", file])).stdout);
    out.acroFormFields = json.acroform?.fields?.length ?? 0;
    // Bitmap images per page as "WxH". A 700x180 bitmap on page 1 is the canvas chart
    // stored as a picture; no such image means the chart was drawn as vector shapes.
    out.bitmaps = json.pages.map((page) => (page.images ?? []).map((img) => `${img.width}x${img.height}`));
  } catch {
    // qpdf missing or exits non-zero on warnings; leave nulls
  }
  return out;
}

await mkdir(OUT, { recursive: true });
const only = process.argv.slice(2);
const SUMMARY = new URL("summary.json", OUT);
// Keep results from earlier runs, so providers can be run one at a time
const summary = await readFile(SUMMARY, "utf8").then(JSON.parse).catch(() => ({}));

for (const [name, p] of Object.entries(providers)) {
  if (only.length && !only.includes(name)) continue;
  const key = process.env[p.env];
  if (!key) { console.log(`- ${name}: skipped (no ${p.env})`); continue; }

  const timings = [];
  const meta = {};
  let pdf, error;
  if (p.setup) {
    try {
      await p.setup(key, meta);
    } catch (e) {
      error = `setup: ${e.message}`;
    }
  }
  for (let i = 0; i < RUNS && !error; i++) {
    const t0 = performance.now();
    try {
      pdf = await p.render(key, meta);
      timings.push(Math.round(performance.now() - t0));
    } catch (e) {
      error = e.message;
      break;
    }
  }

  if (error) {
    summary[name] = { error };
    console.log(`✗ ${name}: ${error}`);
    continue;
  }

  const file = new URL(`${name}.pdf`, OUT).pathname;
  await writeFile(file, pdf);
  summary[name] = {
    testedAt: new Date().toISOString(),
    sizeKB: Math.round(pdf.length / 1024),
    msAverage: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
    msAll: timings,
    ...(await inspect(file)),
    ...meta,
  };
  console.log(`✓ ${name}: ${summary[name].msAverage} ms, ${summary[name].sizeKB} KB, ${summary[name].pages ?? "?"} pages, ${summary[name].acroFormFields ?? "?"} form fields`);
}

await writeFile(SUMMARY, JSON.stringify(summary, null, 2));
