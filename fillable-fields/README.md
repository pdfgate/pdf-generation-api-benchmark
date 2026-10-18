# Fillable fields benchmark

One HTML form with 12 controls, sent to every HTML to PDF API that can turn it into fillable PDF fields, with each output checked field by field.

**Latest run:** 17–18 October 2026.

## Results

| API | How fields are created | HTML changes | Checks | Average time | File size | Output |
|---|---|---|---|---|---|---|
| PDFGate | standard inputs, `enableFormFields: true` | none | 17/17 | 1.6 s (1.3 s without fields) | 126 KB | [PDF](results/pdfgate.pdf) |
| PDFCrowd | standard inputs, `enable_pdf_forms` | none | 16/17 | 2.7 s | 149 KB | [PDF](results/pdfcrowd.pdf) |
| DocRaptor | Prince CSS rule on the inputs | 3 lines | 16/17 | 2.2 s* | 36 KB | [PDF](results/docraptor.pdf) |
| jsreport online | `pdfFormField` template helpers | 37 lines | 13/17 | 0.6 s | 33 KB | [PDF](results/jsreport.pdf) |
| PDFMonkey | `[% data_form_field_… %]` markers | 41 lines | 12/17 | 7.2 s | 81 KB | [PDF](results/pdfmonkey.pdf) |
| Nutrient DWS | standard inputs, no option needed | none | 8/17 | 1.1 s | 91 KB | [PDF](results/nutrient.pdf) |

Average time is over 5 requests, from sending the request to having the PDF. *DocRaptor was timed in its free test mode; its output is from one production request, which took 2.5 s. "HTML changes" is the number of lines that differ between `test-form.html` and the version each API needs. Plain Chrome (`results/puppeteer.pdf`) is the reference render and creates no fields.

Every check for every API:

| Check | PDFGate | PDFCrowd | DocRaptor | jsreport | PDFMonkey | Nutrient |
| --- | --- | --- | --- | --- | --- | --- |
| F1 Text inputs become text fields | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F2 Textarea becomes a multiline field | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F3 Select becomes a dropdown with all 5 options | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F4 Select default option kept | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| F5 Radios become one group with 3 options | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| F6 Radio default kept | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| F7 Checkboxes become checkboxes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F8 Checked state kept | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| F9 Pre-filled text value kept | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| F10 Field names come from the HTML `name` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| F11 `required` kept | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F12 `readonly` kept | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F13 Number and date inputs become fields | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F14 Password input masks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F15 Page-2 fields are on page 2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| F16 Exactly the 12 fields, no strays | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| F17 Fill with pdf-lib, read back, flatten | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

What each API missed:

- **PDFCrowd:** the `checked` attribute is lost, both checkboxes come out unchecked.
- **DocRaptor:** every field name is prefixed with `Form1.` (Prince names fields after the enclosing form).
- **jsreport:** its helper has no radio type, so the radio group is missing (and with it one field and one name).
- **PDFMonkey:** markers cannot carry a default or a pre-filled value, and names cannot match the HTML (`email` is a reserved marker token, underscores are not allowed).
- **Nutrient:** only `text`, `password`, `radio`, `checkbox` and `select` inputs are converted; email, number, date and textarea are skipped, names become `id_name` or a hash, and `required`/`readonly` are dropped.

`results/checks.json` lists every field each API produced (type, name, value, flags, page, rectangle) and the pass/fail per check.

## The form

[`test-form.html`](test-form.html) is a 2-page "customer onboarding form". Every control is there to test one thing:

| Control | HTML | Tests |
| --- | --- | --- |
| Full name | `<input type="text" required>` | text field, `required` flag |
| Email | `<input type="email" value="jane@example.com">` | pre-filled value survives |
| Customer ID | `<input type="text" value="C-1042" readonly>` | `readonly` flag |
| Seats | `<input type="number">` | number input becomes a field |
| Start date | `<input type="date">` | date input becomes a field |
| Country | `<select>` with 5 options, one `selected` | dropdown, options, default |
| Plan | 3 × `<input type="radio" name="plan">`, one `checked` | one radio group, default |
| Accept terms | `<input type="checkbox" checked>` | checkbox, checked state |
| Newsletter | `<input type="checkbox">` | checkbox, unchecked |
| Notes | `<textarea>` | multiline field |
| Portal password (page 2) | `<input type="password">` | password masking |
| Comments (page 2) | `<textarea>` | field placed on page 2 |

A plain bordered `div` at the end stands in for a signature line and must not become a field.

A check passes when pdf-lib finds the right kind of field with the right properties; nothing is judged by eye. A field matches its HTML control by name, or by a documented rename (Nutrient's `id_name`, DocRaptor's `Form1.` prefix); whether the name is kept exactly is its own check, F10.

## Three ways APIs create fields

- **Standard inputs become fields** (PDFGate, PDFCrowd, Nutrient): the form is sent as is. PDFGate and PDFCrowd need one request option; Nutrient needs none.
- **A CSS rule** (DocRaptor): Prince creates fields only for controls with `-prince-pdf-form: enable`, so [`test-form-docraptor.html`](test-form-docraptor.html) adds that one rule.
- **Text markers instead of inputs** (PDFMonkey, jsreport): the inputs are replaced by the service's own markers, in [`test-form-pdfmonkey.html`](test-form-pdfmonkey.html) and [`test-form-jsreport.html`](test-form-jsreport.html). PDFMonkey's markers are set in tiny white Arial because it does not detect them in the Inter web font and leaves marker text visible otherwise; they are left-aligned because the field starts where the marker starts.

## Run it yourself

Keys go in `.env` at the repository root (see `.env.example`). jsreport online uses your login email and password instead of a key; PDFMonkey generates from a template, which the script creates once before timing.

```bash
node --env-file=.env fillable-fields/run.mjs             # every API with credentials
RUNS=5 node --env-file=.env fillable-fields/run.mjs      # average over 5 requests
node --env-file=.env fillable-fields/run.mjs pdfcrowd    # one API
DOCRAPTOR_TEST=false RUNS=1 node --env-file=.env fillable-fields/run.mjs docraptor   # one clean DocRaptor document
cd fillable-fields && node verify.mjs                     # checks every PDF in results/, prints the matrix
```

To test your own form, replace `test-form.html` and adjust `EXPECTED` in `verify.mjs` to describe it.

## Not tested

Anvil creates fields from standard inputs too, but its terms of service do not allow benchmarking against other products, so it is not included. Self-hosted libraries (wkhtmltopdf with `--enable-forms`, EVO, HiQPdf, SelectPdf) are outside the scope, which is hosted APIs.

Found a result that looks wrong, or an option we should have set? Open an issue and we will rerun it.
