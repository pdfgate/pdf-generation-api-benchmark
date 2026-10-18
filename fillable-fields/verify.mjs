// Checks the form fields in each results/*.pdf against what test-form.html asks for
// and writes results/checks.json plus a Markdown matrix to stdout.
//
//   node verify.mjs              # all PDFs in results/
//   node verify.mjs pdfgate      # one
//
// Field names: an API passes a check if it created the right kind of field for the
// HTML control. Whether the name is kept exactly is its own check (F10), because
// some APIs prefix or rename fields (Nutrient uses "<id>_<name>").

import { readFile, readdir, writeFile } from "node:fs/promises";
import { PDFDocument, PDFTextField, PDFDropdown, PDFRadioGroup, PDFCheckBox, PDFName } from "pdf-lib";

const RESULTS = new URL("./results/", import.meta.url);

// What the HTML contains, keyed by the input's name attribute
const EXPECTED = {
  full_name: { type: "text", required: true },
  // "email" is a reserved token in PDFMonkey markers, so its version names the field useremail
  email: { type: "text", value: "jane@example.com", aliases: ["useremail"] },
  customer_id: { type: "text", value: "C-1042", readonly: true },
  seats: { type: "text" },
  start_date: { type: "text" },
  country: { type: "dropdown", options: ["Greece", "France", "Germany", "Spain", "United Kingdom"], selected: "France" },
  plan: { type: "radio", options: ["starter", "pro", "business"], selected: "pro" },
  notes: { type: "text", multiline: true },
  accept_terms: { type: "checkbox", checked: true },
  newsletter: { type: "checkbox", checked: false },
  portal_password: { type: "text", password: true, page: 2 },
  comments: { type: "text", multiline: true, page: 2 },
};

const CHECKS = [
  ["F1", "Text inputs become text fields", (m) => ["full_name", "email", "customer_id"].every((n) => m[n]?.kind === "text")],
  ["F2", "Textarea becomes a multiline text field", (m) => m.notes?.kind === "text" && m.notes.multiline],
  ["F3", "Select becomes a dropdown with all 5 options", (m) => m.country?.kind === "dropdown" && sameSet(m.country.options, EXPECTED.country.options)],
  // PDF stores the option's export value; "fr" (the HTML value) and "France" (the label) both count
  ["F4", "Select default option kept", (m) => ["France", "fr"].some((v) => m.country?.selected?.includes(v))],
  ["F5", "Radios become one group with 3 options", (m) => m.plan?.kind === "radio" && m.plan.options.length === 3],
  ["F6", "Radio default kept", (m) => m.plan?.kind === "radio" && m.plan.selectedIndex === 1],
  ["F7", "Checkboxes become checkboxes", (m) => m.accept_terms?.kind === "checkbox" && m.newsletter?.kind === "checkbox"],
  ["F8", "Checked state kept", (m) => m.accept_terms?.checked === true && m.newsletter?.checked === false],
  ["F9", "Pre-filled text value kept", (m) => m.email?.value === "jane@example.com" && m.customer_id?.value === "C-1042"],
  ["F10", "Field names come from the HTML name attribute", (m) => Object.keys(EXPECTED).every((n) => m[n] && m[n].name === n)],
  ["F11", "required kept", (m) => m.full_name?.required === true],
  ["F12", "readonly kept", (m) => m.customer_id?.readonly === true],
  ["F13", "Number and date inputs become fields", (m) => m.seats?.kind === "text" && m.start_date?.kind === "text"],
  ["F14", "Password input masks", (m) => m.portal_password?.password === true],
  ["F15", "Page-2 fields are on page 2", (m) => m.portal_password?.page === 2 && m.comments?.page === 2],
  ["F16", "No stray fields", (m, all) => all.length === Object.keys(EXPECTED).length],
  ["F17", "Round trip: fill, read back, flatten", (m, all, extra) => all.length > 0 && extra.roundTrip === true],
];

const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));

// Matches a PDF field to an HTML name: exact, or "<prefix>_<name>" / "<name><suffix>" renames
function matchName(fieldName, htmlName) {
  if (fieldName === htmlName) return true;
  if ((EXPECTED[htmlName].aliases ?? []).includes(fieldName)) return true;
  if (fieldName.endsWith("_" + htmlName)) return true;
  if (fieldName.endsWith("." + htmlName)) return true;
  // marker-based APIs cannot carry underscores in names: "fullname" counts as full_name
  if (fieldName.replace(/_/g, "").toLowerCase() === htmlName.replace(/_/g, "").toLowerCase()) return true;
  return false;
}

async function describe(file) {
  const bytes = await readFile(file);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  // widget dict -> page index
  const widgetPage = new Map();
  pages.forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (const ref of annots.asArray()) widgetPage.set(doc.context.lookup(ref), i + 1);
  });

  const all = [];
  for (const f of doc.getForm().getFields()) {
    const d = { name: f.getName() };
    const widgets = f.acroField.getWidgets();
    d.page = widgetPage.get(widgets[0]?.dict) ?? null;
    d.rect = widgets[0] ? Object.values(widgets[0].getRectangle()).map((v) => Math.round(v)) : null;
    if (f instanceof PDFTextField) {
      d.kind = "text"; d.value = f.getText() ?? ""; d.multiline = f.isMultiline(); d.password = f.isPassword();
      d.required = f.isRequired(); d.readonly = f.isReadOnly();
    } else if (f instanceof PDFDropdown) {
      d.kind = "dropdown"; d.options = f.getOptions(); d.selected = f.getSelected();
    } else if (f instanceof PDFRadioGroup) {
      d.kind = "radio"; d.options = f.getOptions(); const s = f.getSelected(); d.selected = s;
      // options are export values; some APIs use hashes, so index is what we compare
      d.selectedIndex = s == null ? -1 : d.options.indexOf(s);
      d.pages = widgets.map((w) => widgetPage.get(w.dict) ?? null);
    } else if (f instanceof PDFCheckBox) {
      d.kind = "checkbox"; d.checked = f.isChecked();
    } else {
      d.kind = f.constructor.name;
    }
    all.push(d);
  }

  const m = {};
  for (const htmlName of Object.keys(EXPECTED)) {
    const hit = all.find((d) => matchName(d.name, htmlName));
    if (hit) m[htmlName] = hit;
  }

  // F17: fill everything with pdf-lib, save, reload, compare, then flatten
  let roundTrip = false, roundTripError = null;
  try {
    const d2 = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = d2.getForm();
    const want = {};
    for (const f of form.getFields()) {
      if (f.isReadOnly()) continue;
      if (f instanceof PDFTextField) { f.setText("filled"); want[f.getName()] = "filled"; }
      else if (f instanceof PDFDropdown) { const o = f.getOptions(); f.select(o[0]); want[f.getName()] = o[0]; }
      else if (f instanceof PDFRadioGroup) { const o = f.getOptions(); f.select(o[0]); want[f.getName()] = o[0]; }
      else if (f instanceof PDFCheckBox) { f.check(); want[f.getName()] = true; }
    }
    const saved = await d2.save();
    const d3 = await PDFDocument.load(saved);
    const f3 = d3.getForm();
    roundTrip = Object.entries(want).every(([n, v]) => {
      const f = f3.getField(n);
      if (f instanceof PDFTextField) return f.getText() === v;
      if (f instanceof PDFDropdown) return f.getSelected().includes(v);
      if (f instanceof PDFRadioGroup) return f.getSelected() === v;
      if (f instanceof PDFCheckBox) return f.isChecked() === v;
      return false;
    });
    f3.flatten();
    await d3.save();
  } catch (e) {
    roundTrip = false; roundTripError = e.message;
  }

  const results = {};
  for (const [id, label, test] of CHECKS) {
    let pass = false;
    try { pass = Boolean(test(m, all, { roundTrip })); } catch { pass = false; }
    results[id] = pass;
  }
  return { fields: all, matched: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.name])), checks: results, score: Object.values(results).filter(Boolean).length, roundTripError };
}

const only = process.argv.slice(2);
const files = (await readdir(RESULTS)).filter((f) => f.endsWith(".pdf") && (!only.length || only.includes(f.replace(/\.pdf$/, ""))));
const out = {};
for (const f of files.sort()) {
  const name = f.replace(/\.pdf$/, "");
  try {
    out[name] = await describe(new URL(f, RESULTS));
    console.log(`${name}: ${out[name].score}/${CHECKS.length}  fields=${out[name].fields.length}` + (out[name].roundTripError ? `  (round trip: ${out[name].roundTripError})` : ""));
  } catch (e) {
    out[name] = { error: e.message };
    console.log(`${name}: error ${e.message}`);
  }
}
await writeFile(new URL("checks.json", RESULTS), JSON.stringify(out, null, 2));

// Markdown matrix: one column per API
const names = Object.keys(out);
console.log("\n| Check | " + names.join(" | ") + " |");
console.log("| --- | " + names.map(() => "---").join(" | ") + " |");
for (const [id, label] of CHECKS) {
  console.log(`| ${id} ${label} | ` + names.map((n) => (out[n].checks ? (out[n].checks[id] ? "✅" : "❌") : "—")).join(" | ") + " |");
}
console.log("| **Score** | " + names.map((n) => (out[n].score ?? "—") + "/" + CHECKS.length).join(" | ") + " |");
