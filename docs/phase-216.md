# Phase 216 — double-size lines fit on one printed line

- **Date:** 2026-10-03
- **Follows:** [phase-215.md](phase-215.md), which measured that the 48-character TOTAL KSH row, sent at double size, wraps on a 48-column printer and puts the amount on the line below the label.
- **Requested:** build double-size rows for `Math.floor(width / 2)` columns; audit every double-size entry; add a guard test; golden quoted; mutation checks.
- **Outcome:** done in code and tests. Typecheck clean; full suite **192 files, 3155 tests, all passing** (191 and 3071 before: +1 file, +84 tests); `npm run build` passes with the no-mock check. **Not done:** the paper checks (section 6): no real printer is reachable from this PC, and the release is not built or installed. Nothing fiscal or device-side changed.
- **Branch / base:** staging on `f0acaef`.

## 1. The change

One file of source, [receiptLayout.ts](../src/main/lib/receiptLayout.ts):

- New `columnsFor(style, width)`: `Math.floor(width / 2)` for `'double'`, `width` otherwise. It is the one place the rule lives.
- `keyValueLines` computes the row's gap, the label cut and the value padding against `columnsFor(style, width)`. The fallback therefore cuts the label line to `width / 2` and pads the value line to `width / 2`, never `width`, so a split double row does not wrap again. Label first, value second, as before.
- `wrappedLines` wraps to `columnsFor(style, width)`. Every centred double heading goes through it, so a heading longer than `width / 2` is now broken at a word (a single word longer than that is hard-cut), each piece printed double.
- A normal or bold row is unchanged: `columnsFor` returns `width` for them.

`printer.ts` and `pdf-receipt.ts` are not touched: both walk the layout, so both get the shorter rows.

## 2. Audit: every line printed at double size

Built with the real builders (scratch script, not in the repo). Lengths are those of the printed text, against the line holding `width / 2` = 24, 21 and 16.

| Where | Entry | 48 | 42 | 32 | Rule used |
| --- | --- | --- | --- | --- | --- |
| Fiscal slip | `FISCAL RECEIPT` | 14 | 14 | 14 | fits at all three; none needed |
| Sale record | `SALE RECORD` | 11 | 11 | 11 | fits; none needed |
| Fiscal slip, sale record | shop name `ENJOY` | 5 | 5 | 5 | fits |
| Fiscal slip, sale record | shop name `Enjoy Haile Selassie` (20) | 20, one line | 20, one line | **`Enjoy Haile` (11) / `Selassie` (8)** | wrapped at a word to `width / 2` (new) |
| Fiscal slip, sale record | shop name `Enjoy Westlands Supermarket` (27) | **`Enjoy Westlands` (15) / `Supermarket` (11)** | same | same | wrapped at a word (new); it was one 27-character line, which the printer wrapped at character 24, mid-word |
| Fiscal slip, sale record | `TOTAL KSH` row | 24 | 21 | **two entries**: `TOTAL KSH` (9), amount padded to 16 | `keyValueLines` at `width / 2`; was `width` characters |
| Enjoy slip | `E N J O Y` | 9 | 9 | 9 | fits |
| Mock provider banner (development stand-in only) | `TEST. NOT A TAX INVOICE.` | 24, double | bold | bold | already built right: double only when `length * 2 <= width`, else bold. Unchanged |

Not double size, so not affected: `*** DUPLICATE ***` (bold, 17 characters, normal width), the Enjoy slip's TOTAL (bold), every other row. The Z report prints no double-size line (it uses bold and centring only), and neither do the two test pages.

Before this change the only double-size entries wider than `width / 2` were the TOTAL KSH row (at every width) and a shop name longer than `width / 2` (at 32, the 20-character `Enjoy Haile Selassie`; at 48 and 42, a name of 25 or more). The Enjoy till's shop name is not known from this PC, so whether its heading wrapped is not known.

## 3. Tests

New [doubleSizeRows.test.ts](../tests/doubleSizeRows.test.ts) (84 tests):

- **The guard.** *"a double-size line is never longer than half the printer width"*: at 48, 42 and 32, for the fiscal slip in seven scenarios (filed, duplicate, sale record, discounted, a 123,456,789.50 total, a long shop name, a single long word as shop name), the same seven with the mock banner applied, and the Enjoy slip in four; and every layout in the golden fixture. This is the test that would have caught the phase 215 bug.
- **TOTAL KSH:** one entry of 24 characters at 48 (`TOTAL KSH       1,650.00`); one of 21 at 42; two entries at 32, label first, `        1,650.00` of 16 characters with the amount at the right edge.
- **`keyValueLines`:** the fallback pads to half the width not the full width; a label or value longer than half the width is cut to it; a normal row is still the full width.
- **Headings:** a long name breaks at a word with no word lost; one long word is hard-cut to `width / 2`; a normal-size line still wraps at the full width.
- **PDF:** measured with pdfkit at the receipt's own font size (`fontSizeForWidth(48) * 2`, Courier-Bold, the page's text width): the 24-character TOTAL KSH row is one line high; the old 48-character row is more than one and a half lines (it wrapped); every double line of the fiscal slip is one line high at 48, 42 and 32.

**Existing tests: none changed.** Apart from the golden, no existing test file was edited; before the golden was updated, exactly the 12 golden cases failed and nothing else.

## 4. Golden: every changed entry

`tests/fixtures/receipt-class-a-golden.json`: 42 lines added, 12 removed. Each of the 12 TOTAL KSH entries (6 scenarios at 48 and 32), written by rule independently of the builder and then checked by the existing golden test against what the builder prints:

```
@48   index   old text                                              new text
filedWithGroups@48/25        "TOTAL KSH                               1,650.00"   "TOTAL KSH       1,650.00"
filedNoGroups@48/25          (same old)                                           "TOTAL KSH       1,650.00"
filedNoClassOnItems@48/25    (same old)                                           "TOTAL KSH       1,650.00"
duplicate@48/26              (same old)                                           "TOTAL KSH       1,650.00"
slip@48/25                   (same old)                                           "TOTAL KSH       1,650.00"
discounted@48/26             "TOTAL KSH                               1,485.00"   "TOTAL KSH       1,485.00"

@32
filedWithGroups@32/26        "TOTAL KSH               1,650.00"  ->  "TOTAL KSH"  then  "        1,650.00"
filedNoGroups@32/26          (same)
filedNoClassOnItems@32/26    (same)
duplicate@32/27              (same)
slip@32/26                   (same)
discounted@32/27             "TOTAL KSH               1,485.00"  ->  "TOTAL KSH"  then  "        1,485.00"
```

All entries stay `align: "left"`, `style: "double"`. **Index shift at 32:** every entry after TOTAL KSH moves down one place in all six `@32` layouts (filedWithGroups, filedNoGroups, filedNoClassOnItems, duplicate, slip, discounted). The `@48` layouts keep their indices.

## 5. Mutation checks (each restored; the file is identical to its backup afterwards)

1. **Fallback value line padded to `width`** (`padStart(width)`, `slice(0, width)`): **27 tests failed**: the 32-column guard cases for all seven scenarios, with and without the banner; the 42-column huge-total cases; the three fallback `keyValueLines` tests; the 32-column TOTAL KSH test; the PDF 32-column test; and the six `@32` golden cases.
2. **Double rows built at `width`** (`columnsFor` returns `width`): **66 tests failed**: every guard case at 48, 42 and 32, both heading tests, the three width tests, the PDF 32-column test, and the golden cases.

## 6. PDF height

`computeReceiptPdfHeight` counts a double line as two rows (`2 * 1.5 * fontSize`). That **still holds, and now fits**: pdfkit draws a double line at about `2.1 * fontSize` (measured: 2.10), below the allotted `3 * fontSize` (tested). Before, a wrapped double row took two drawn lines (about `4.2 * fontSize`) against that same `3 * fontSize`, so it was under-allotted. A split heading is several double lines, each counted as two rows; that is unchanged.

## 7. Paper

- **Byte dump, width 48** (fixture: total 100.00, a duplicate; the same real `renderReceipt` and `getBuffer()`):

  ```
  0000  1B 61 00 1B 21 30 1B 45 01 54 4F 54 41 4C 20 4B  .a..!0.E.TOTAL K
  0010  53 48 20 20 20 20 20 20 20 20 20 31 30 30 2E 30  SH         100.0
  0020  30 0A                                            0.
  ```

  `TOTAL KSH         100.00`, 24 characters, one `ESC a 0`, one `ESC !`, one `LF`. The header rows are the same bytes as phase 215 (`Invoice No: ... LZZYNW4NOE68CQ`, one line each).
- **PDF fallback:** a real PDF generated at 48 columns and read back: `TOTAL KSH` at the left and `100.00` at the right of one large line, matching the mock-up.
- **Reprint on a real printer:** **not done.** This PC has no thermal or paper printer (only Microsoft PDF, XPS, Fax and OneNote).
- **Enjoy till:** not done; it needs the release built and installed. Then reprint the 15:36 sale (LZZYNW4NOE68CQ; it prints as DUPLICATE), photographed flat from directly above with a straight edge under TOTAL KSH and under Invoice No. The same print settles the Enjoy slip's footer (the tail is `ESC d 4`, `ESC d 4`, `GS V 0`).

## 8. Observed, not changed

- At **32 columns** the mock-up's single large TOTAL KSH line cannot be reproduced: `TOTAL KSH` and `1,650.00` are 17 characters in a 16-column double line. The rule you set puts the label above the amount there, both large. A narrower layout would need a smaller type size for that row.
- The mock provider banner prints bold at 42 and 32 (its existing rule); unchanged.
- The PDF page is taller than its content (the height allowance is generous); unchanged.

## 9. Affected files, impact, rollback

- **Changed:** `src/main/lib/receiptLayout.ts`, `tests/fixtures/receipt-class-a-golden.json`. **Added:** `tests/doubleSizeRows.test.ts`, this document.
- **Impact:** only where double-size text sits and breaks: the TOTAL KSH row on every slip and the PDF, and a shop name longer than half the width. No figure, fiscal field, QR, device call or Enjoy slip content changes.
- **Rollback:** revert this commit; the golden returns with it.
