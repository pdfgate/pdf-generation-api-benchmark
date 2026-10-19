# PDF Generation API Benchmark

One HTML document, sent unchanged to 12 PDF generation APIs, scored on 14 rendering checks, speed and file size.

This repository holds everything needed to check or rerun the test: the test document, the script, and the PDF each provider returned.

**Latest run:** 11–12 October 2026.

## Results

| Provider | Engine | Checks passed | Average time | File size | Fillable fields | Average time with fields | Output |
|---|---|---|---|---|---|---|---|
| PDFGate | Chrome | 14/14 | 1.5 s | 227 KB | ✅ | 2.1 s | [PDF](results/pdfgate.pdf) |
| DocRaptor | Prince | 14/14 (own HTML version) | 2.8 s* | 90 KB | ✅ | 3.0 s* | [PDF](results/docraptor.pdf) |
| PDFShift | Chromium | 13/14 (print styles on) | 1.9 s | 271 KB | ❌ | — | [PDF](results/pdfshift.pdf) |
| PDFCrowd | Chrome | 13/14 | 3.0 s | 293 KB | ✅ | 2.9 s | [PDF](results/pdfcrowd.pdf) |
| APITemplate.io | Chromium | 13/14 (backgrounds on) | 3.2 s | 312 KB | ❌ | — | [PDF](results/apitemplate.pdf) |
| Browserless | Chrome | 13/14 | 3.3 s | 319 KB | ❌ | — | [PDF](results/browserless.pdf) |
| PDFMonkey | Chrome | 13/14 (own HTML version) | 3.7 s | 227 KB | ✅ | 9.5 s | [PDF](results/pdfmonkey.pdf) |
| Api2Pdf | Chrome | 13/14 | 4.2 s | 310 KB | ❌ | — | [PDF](results/api2pdf.pdf) |
| ConvertAPI | Chromium | 13/14 (print settings on) | 4.3 s | 308 KB | ❌ | — | [PDF](results/convertapi.pdf) |
| PDF.co | Chrome | 13/14 | 10.0 s† | 262 KB | ❌ | — | [PDF](results/pdfco.pdf) |
| CloudConvert | Chrome | 12/14 | 1.8 s | 289 KB | ❌ | — | [PDF](results/cloudconvert.pdf) |
| cloudlayer.io | Chrome | 12/14 | 2.1 s | 360 KB | ❌ | — | [PDF](results/cloudlayer.pdf) |

Average time is for conversions without fillable fields, averaged over every timed request (at least 5), from sending the request to having the finished PDF. The four providers that create fields are also shown with fields on. *DocRaptor was timed in its free test mode; its output PDF is from one production request. †PDF.co was timed in asynchronous mode, including status checks. Times depend on where you run the test from.

Output files are in [`results/`](results/), one PDF per provider, plus `summary.json` with the raw numbers.

## The test document

[`test-document.html`](test-document.html) is a 4-page invoice. Each section checks one thing that commonly breaks in HTML to PDF conversion. The check IDs are printed in the document, so you can find each one in the output.

| ID | Check | Passes when |
| --- | --- | --- |
| T1 | Google web font (Inter) | Headings use Inter, not a default font |
| T2 | `@page` margin box with `counter(pages)` | "Page X of Y" appears at the bottom of every page |
| T3 | CSS custom properties | Headings are purple and the summary cards are tinted |
| T4 | Gradient background | The header has a purple gradient, not white |
| T5 | CSS grid | The three summary cards sit side by side |
| T6 | `box-shadow` | The summary cards have a soft shadow |
| T7 | Table header repeats on a new page | The dark header row appears again at the top of page 3 |
| T8 | `break-before: page` | "Line items" starts on page 2 |
| T9 | `break-inside: avoid` | The dashed "Payment terms" box is never split across pages |
| T10 | Inline SVG | A white check mark appears in the header |
| T11 | JavaScript changes the page | The three summary cards show € amounts instead of dashes |
| T12 | Canvas drawn by JavaScript | The bar chart is visible |
| T13 | Form controls | Counted as real PDF form fields (0 means printed as static shapes) |
| T14 | Greek, Japanese, Arabic and emoji | All characters render, Arabic is right-aligned, no empty boxes |

T12 only checks that the chart appears. `summary.json` also lists the bitmap images in each PDF (`bitmaps`): Chrome-based engines store the canvas as a 700x180 bitmap, which looks soft when zoomed or printed, while a PDF without that image drew the chart as vector shapes.

The page loads Inter and Noto Sans JP from Google Fonts. It loads no font for Arabic or emoji, so T14 also shows which fonts each provider has installed on its servers.

## What was sent

Every browser-based provider received the same HTML. Only these options were set, where the API offers them:

- A4 page size
- Background colors and images on (APITemplate.io: `print_background: "1"`, which is off by default)
- JavaScript on
- Fillable form fields on
- Print styles on, where the API defaults to screen styles (PDFShift: `use_print`; ConvertAPI: `CssMediaType: print`). With screen styles, Chrome does not repeat table headers across pages.
- Print layout on, where the API lays the page out in a browser window and shrinks it onto the page (ConvertAPI: `RespectViewport: false`).
- Asynchronous mode where the synchronous request could not finish the document (PDF.co: its synchronous mode stopped at about 27 seconds). The timing covers starting the job, checking it every 0.5 seconds, and downloading the file.

Everything else is left at each API's defaults. The exact request for each provider is in [`run.mjs`](run.mjs).

DocRaptor renders with Prince, a print engine rather than a browser, so the browser version fails several checks for reasons of syntax rather than capability. To test what DocRaptor can actually do, it gets its own version, [`test-document-docraptor.html`](test-document-docraptor.html), with the same content and these changes:

- JavaScript rewritten in ES5 (`var`, `function`, no arrow functions or template strings), run with Prince's own JavaScript engine (`prince_options.javascript`).
- Flexbox instead of CSS grid for the summary cards and the international text.
- `-prince-pdf-form: enable` on `input`, `select` and `select option`, which Prince needs to create fillable fields.

With the browser version, DocRaptor passed 9 of 14 checks. Writing a separate version is a real cost of using it.

PDFMonkey creates fillable fields only from its own markers, so it gets [`test-document-pdfmonkey.html`](test-document-pdfmonkey.html), where the three form inputs are replaced with `[% data_form_field_… %]` markers and the template's `use_forms` setting is on. The markers are set in tiny white Arial, because PDFMonkey did not detect them in Inter and leaves marker text visible outside the field.

PDFMonkey only generates from templates, so the script creates the template once through PDFMonkey's API before timing starts, then generates each timed document from it with empty data. DocRaptor's free test mode adds a watermark, which is ignored when scoring.

## Run it yourself

You need Node.js 20.6 or newer, and `qpdf` for the page and form-field counts.

```bash
npm install                 # optional: Puppeteer for the local Chrome reference
cp .env.example .env        # add keys for the providers you have accounts with
npm run bench               # providers without a key are skipped
RUNS=5 npm run bench        # average over 5 requests
npm run bench -- pdfgate    # a single provider
```

Results are written to `results/`. Check each provider's free allowance before running with `RUNS=5`. PDF.co, for example, charges 2 credits for every job status check, and the script checks every 0.5 seconds, so one PDF can use around 45 credits. To test your own document, replace `test-document.html` with your HTML.

## Fillable fields benchmark

A second test, in [`fillable-fields/`](fillable-fields/), sends one 2-page form with 12 controls to every API that can create fillable PDF fields and checks each output field by field with pdf-lib: types, names, defaults, pre-filled values, `required`/`readonly`, page placement and a fill-and-flatten round trip. Run on 17–18 October 2026.

| API | How fields are created | HTML changes | Checks | Average time | Output |
|---|---|---|---|---|---|
| PDFGate | standard inputs | none | 17/17 | 1.6 s | [PDF](fillable-fields/results/pdfgate.pdf) |
| PDFCrowd | standard inputs | none | 16/17 | 2.7 s | [PDF](fillable-fields/results/pdfcrowd.pdf) |
| DocRaptor | Prince CSS rule | 3 lines | 16/17 | 2.2 s* | [PDF](fillable-fields/results/docraptor.pdf) |
| jsreport online | template helpers | 37 lines | 13/17 | 0.6 s | [PDF](fillable-fields/results/jsreport.pdf) |
| PDFMonkey | text markers | 41 lines | 12/17 | 7.2 s | [PDF](fillable-fields/results/pdfmonkey.pdf) |
| Nutrient DWS | standard inputs | none | 8/17 | 1.1 s | [PDF](fillable-fields/results/nutrient.pdf) |

*Timed in DocRaptor's free test mode. The full check matrix, what each API missed, and how to run it are in [`fillable-fields/README.md`](fillable-fields/README.md).

## Providers

PDFGate, DocRaptor, PDF.co, PDFMonkey, Api2Pdf, ConvertAPI, CloudConvert, cloudlayer.io, PDFShift, PDFCrowd, Browserless and APITemplate.io.

DocSpring is not included because it fills existing PDF forms rather than rendering HTML. CraftMyPDF is not included because it only renders templates built in its visual editor.

The local Chrome reference (Puppeteer, `PUPPETEER=1`) passes every check except T13, because plain Chrome prints form inputs as static shapes.

## About

Maintained by [PDFGate](https://pdfgate.com). Found a mistake in how a provider is called, or a result that looks wrong? Open an issue or a pull request.
