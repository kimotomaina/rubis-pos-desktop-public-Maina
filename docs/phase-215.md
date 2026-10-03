# Phase 215 — label-and-value rows: audit recorded, and the double-size TOTAL KSH row measured

- **Date:** 2026-10-03
- **Found while:** the owner's photo of a fiscal receipt and Enjoy slip printed at Enjoy Haile Selassie on 2026-10-03 15:36 (CU invoice `0110605040001000811`, trader number `LZZYNW4NOE68CQ`) seemed to show label-and-value rows with the value on the line above the label.
- **Outcome:** read-only. **No code, test or golden was changed.** The audit finds no fault in the layout or the bytes for the flat rows. The owner has since said the photo was taken at an angle (the cut edge and the Enjoy slip are visibly rotated, the apparent shift grows and shrinks down the receipt), so it is not evidence of a fault. One real defect is measured below: the double-size TOTAL KSH row is longer than the printer's double-width line and wraps.
- **Numbering:** the request said phase 213; `phase-213.md`, `phase-213-1.md` and `phase-214.md` already exist, so this is 215.
- **Branch / base:** staging on `91224dc`.

## 1. Audit (as reported, unchanged)

1. **`keyValueLines`** ([receiptLayout.ts:269-283](../src/main/lib/receiptLayout.ts#L269-L283)) returns **one** entry, `align: 'left'`, when `width - label.length - value.length >= 1`: `label + spaces + value`. Only when that gap is below 1 does it return two entries, **label first**, then the value left-padded to `width`. The Enjoy slip has no builder of its own: [enjoySlip.ts:118-139](../src/main/lib/enjoySlip.ts#L118-L139) calls the same function. It has been this shape since phase 171, and `out/main/index.js` matches the source. The golden holds these rows as single left-aligned strings.
2. **`renderEntries`** ([printer.ts:416-447](../src/main/services/printer.ts#L416-L447)): per line entry, `alignLeft()`/`alignCenter()`/`alignRight()` from `align`, then `bold(true)` or `setTextQuadArea()`+`bold(true)` for the style, then `println(text)`, then the style is reset. It never calls `alignRight()` before a line and `alignLeft()` after, and no path prints a value before its label.
3. **Fallback and width.** The fallback fires only when label + value is at least `width`. The three header rows come to 26, 22 and 13 characters (label + 1 + value) against 48, 42 and 32, so it could not fire. The resolved width is 48 unless the Enjoy till's `printers` row says 42 or 32 (`resolvePrinterSettings`: a null width falls to the default, and `renderEnjoySlip` uses `?? 48`). **Not read:** that till's `printers` row. The dev PC's `printers` table is empty.
4. **Bytes** (fixture with the same invoice, trader number and CU serial; cashier and M-Pesa ref are placeholders; real `renderReceipt` into a `ThermalPrinter` with no `interface`, then `getBuffer()`), header rows at width 48:

   ```
   1B 61 00 "Invoice No:" + 23 spaces + "LZZYNW4NOE68CQ" 0A
   1B 61 00 "Date:"       + 27 spaces + "03/10/2026 15:36" 0A
   1B 61 00 "Cashier:"    + 36 spaces + "Paul" 0A
   ```

   One `ESC a 0` per row, before the label; nothing between label and value; no `ESC a 2`. The totals, payment, CU and Enjoy TOTAL / Paid by rows have the same shape.
5. **Printer:** the queue, make, model, paper width and code page are on the Enjoy till and are **not available** from this PC (it has only the Microsoft PDF/XPS/Fax/OneNote printers). Nothing in the repo records them.
6. **Verdict:** not (a): the renderer emits one line per row, label first. The flat rows give no sign of a fault in the layout or the bytes.

The tail of both slips is `ESC d 4`, `ESC d 4`, `GS V 0`: eight line feeds, then a full cut. Whether the Enjoy slip's last footer lines were clipped is not decided here; it needs a straight-on print.

## 2. The TOTAL KSH row

The row is sent with `ESC ! 30` (double width and height) and `ESC E 1`. In the owner's photo the amount prints on the line below "TOTAL KSH".

**Bytes** (fixture total 90.00, width 48):

```
1B 61 00 1B 21 30 1B 45 01 "TOTAL KSH" + 34 spaces + "90.00" 0A
```

1. **Length and width.** The string is **48 characters**, built for a width of 48. (The golden's row at width 32 is 32 characters.)
2. **Does it wrap.** Yes. At double width a 48-column printer holds **24** characters per line, and the string is twice that. The printer wraps it after character 24: line 1 is "TOTAL KSH" and 15 spaces, line 2 is the remaining 19 spaces and the amount. That is the amount on the line below the label, as in the photo. It follows from the byte count and the ESC/POS behaviour of a line longer than the printer's width; **not** observed on the printer here. The same holds for the PDF fallback: `pdf-receipt.ts` draws a `'double'` line at twice the font size ([pdf-receipt.ts:144-147](../src/main/services/pdf-receipt.ts#L144-L147)), so a 48-character double row is 96 columns wide on a page built for 48 and wraps too.
3. **The mock-up** ([receipt-design-mockup.pdf](receipt-design-mockup.pdf), page 1, extracted text): `TOTAL KSH 1,650.00` on **one** line, in double size, the amount at the right edge: "TOTAL KSH" at the left and "1,650.00" at the right of the same large row. Pages 2 and 3 are the same, `TOTAL KSH 200.00` on page 3. So the design wants it on one line; the code does not deliver that.

Only the `'double'` style is affected. The Enjoy slip's TOTAL is `'bold'` (normal width) and is not.

## 3. Proposal (not built)

Build a double-style label-and-value row at **`width / 2`** characters: the printer's double-width line holds `width / 2` characters, so the row fills exactly one printed line. In `keyValueLines`, a `'double'` style would pad to `Math.floor(width / 2)` instead of `width`, with the existing fallback (label line, then value line, label above value) when the two do not fit.

I checked the effect without changing any file, by rendering the same fixture through the real `renderReceipt` with the double rows rebuilt at `width / 2` (a scratch bundle, not in the repo). Real bytes:

| Width | Row string | Chars | Bytes before the text |
| --- | --- | --- | --- |
| 48 | `TOTAL KSH       1,650.00` | 24 | `1B 61 00 1B 21 30 1B 45 01` |
| 42 | `TOTAL KSH    1,650.00` | 21 | same |
| 32 | `TOTAL KSH` then a second line holding `1,650.00` right-aligned in 16 columns | 9 + 16 | same on each line |

At 48 and 42 the row is one line and fits the double-width line exactly. **At 32 the row does not fit:** "TOTAL KSH" (9) plus "1,650.00" (8) is 17 characters in a 16-column double line, so the fallback prints the label line and then the value line (label above value). That matches the rule that the fallback never puts the value first, but on a 58 mm till the mock-up's single line cannot be reproduced at double size.

**Golden change** (`tests/fixtures/receipt-class-a-golden.json`, 12 rows across the 6 scenarios at 48 and 32, each now quoted):

- At `@48` (6 rows, e.g. `filedWithGroups@48/25`): `TOTAL KSH` + 31 spaces + `1,650.00` (48 characters) becomes `TOTAL KSH       1,650.00` (24 characters). Same for `1,485.00` in `discounted@48`. No index changes.
- At `@32` (6 rows, e.g. `filedWithGroups@32/26`): the single 32-character row becomes two entries: `TOTAL KSH` and the 16-character value line. Every later entry in those six scenarios moves down one index.
- The PDF renderer reads the same layout, so the PDF row changes the same way.

Nothing is built until this is accepted.

## 4. Not done, and when

- **Diagnostic print on the Enjoy till** (a line of 48 digits, a 48-dash rule, the three header rows, plus that till's queue name, driver and `printers.width`): only if the owner reports the flat receipt is misaligned when photographed straight on. Not asked for yet.
- **Real print of the proposed double row:** not done; it follows the build.

## 5. Affected files, impact, rollback

- **Affected files:** this document only.
- **Possible impact:** none; no code, test, golden, fiscal or device behaviour was touched.
- **Rollback:** delete `docs/phase-215.md`.
