#!/usr/bin/env node
/**
 * One-off extraction script (not part of the app build) that pulls the
 * vendor's embedded protocol definition out of the Tremol SDK and emits
 * two committed fixtures:
 *
 *   tests/fixtures/tremol-defs.xml      — the raw <Defs> XML, unescaped
 *                                         from its source-language string
 *                                         literal form
 *   tests/fixtures/tremol-contract.json — a machine-readable summary:
 *                                         per command, its ordered arg
 *                                         list (with type/maxLen/
 *                                         compulsory/options) and ordered
 *                                         response-field list (with
 *                                         type/maxLen/byte/bit/options)
 *
 * As of the `ZFP_SDK_KE_2509041522_ControlUnit` package (Sept 2026), the
 * authoritative copy of these definitions is the `var defs = '<Defs>…'`
 * string literal in `Libs/JS/fp.js` — this is what the shipping vendor
 * JS client actually POSTs to the server (`ServerSendDefs`), carries the
 * current `<GenerationTimeStamp>`, and is corroborated by the protocol
 * PDF and the per-command `Libs/FileServer/*.xml` templates. The earlier
 * `FP.cs`-based extraction (pre-Phase-60) came from an **older** SDK
 * drop — see `tracker/SDK_RECON.md` in that package for the full
 * command-by-command diff. Both source shapes are still supported here
 * (auto-detected by file extension) so re-running this against a future
 * `.cs` or `.js` drop needs no script changes, only a newer input file.
 *
 * Re-run this whenever the vendor ships an updated SDK — it's a
 * generator, not a source of behavior, so it isn't wired into any build
 * step.
 *
 * The optional second argument is the fixture basename, so the same
 * extractor produces the fixtures for **both** supported definition
 * versions rather than one of them being transcribed by hand:
 *
 *   node scripts/extract-tremol-contract.mjs ".../Libs/JS/fp.js"
 *   node scripts/extract-tremol-contract.mjs ".../API Files/C# Lib/FP.cs" tremol-old
 *
 * Usage: node scripts/extract-tremol-contract.mjs "<path to fp.js or FP.cs>" [basename]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('Usage: node scripts/extract-tremol-contract.mjs "<path to fp.js or FP.cs>" [basename]')
  process.exit(1)
}

/** Fixture basename, so one extractor serves both definition versions. */
const basename = process.argv[3] ?? 'tremol'

const source = readFileSync(sourcePath, 'utf8')

/**
 * Extracts the raw `<Defs>…</Defs>` XML out of the vendor's embedded
 * string literal, whichever source language shipped it.
 *
 *   - `Libs/JS/fp.js`: `var defs = '<Defs>…</Defs>';` — a single-quoted
 *     JS string. Embedded literal single quotes (inside `ArgsFormatRaw`/
 *     `ResFormatRaw` CDATA, e.g. `<\'3\'>`) are backslash-escaped;
 *     double quotes need no escaping in a single-quoted JS string, so
 *     every XML attribute quote already reads correctly as-is.
 *   - `FP.cs` (older drop): `public string defs = @"<Defs>…</Defs>";` —
 *     a C# verbatim string, which escapes a literal `"` as `""`.
 *
 * @param {string} text
 * @param {string} ext
 * @returns {string}
 */
function extractDefsXml(text, ext) {
  if (ext === '.js') {
    const startMarker = "var defs = '"
    const startIdx = text.indexOf(startMarker)
    if (startIdx === -1) throw new Error(`Could not find \`${startMarker}\` in ${sourcePath}`)
    const contentStart = startIdx + startMarker.length
    const endMarker = "</Defs>';"
    const endIdx = text.indexOf(endMarker, contentStart)
    if (endIdx === -1) throw new Error(`Could not find closing \`${endMarker}\` in ${sourcePath}`)
    const raw = text.slice(contentStart, endIdx + '</Defs>'.length)
    return raw.replace(/\\'/g, "'")
  }

  const startMarker = 'public string defs = @"'
  const startIdx = text.indexOf(startMarker)
  if (startIdx === -1) throw new Error(`Could not find \`${startMarker}\` in ${sourcePath}`)
  const contentStart = startIdx + startMarker.length
  const endMarker = '</Defs>";'
  const endIdx = text.indexOf(endMarker, contentStart)
  if (endIdx === -1) throw new Error(`Could not find closing \`${endMarker}\` in ${sourcePath}`)
  const raw = text.slice(contentStart, endIdx + '</Defs>'.length)
  return raw.replace(/""/g, '"')
}

const defsXml = extractDefsXml(source, extname(sourcePath).toLowerCase())

const fixturesDir = join(repoRoot, 'tests', 'fixtures')
mkdirSync(fixturesDir, { recursive: true })
writeFileSync(join(fixturesDir, `${basename}-defs.xml`), defsXml, 'utf8')

/** Parses `Name="value"` attribute pairs off a tag's attribute string. */
function parseAttrs(attrString) {
  const attrs = {}
  const pattern = /(\w+)="([^"]*)"/g
  let m
  while ((m = pattern.exec(attrString)) !== null) {
    attrs[m[1]] = m[2]
  }
  return attrs
}

/** Extracts `<Option Name="…" Value="…"/>` entries from an `<Options>…</Options>` block, if present. */
function extractOptions(inner) {
  const optionsBlockMatch = /<Options>([\s\S]*?)<\/Options>/.exec(inner)
  if (!optionsBlockMatch) return undefined
  const options = []
  const pattern = /<Option\s+([^>]*?)\/>/g
  let m
  while ((m = pattern.exec(optionsBlockMatch[1])) !== null) {
    const attrs = parseAttrs(m[1])
    options.push({ name: attrs.Name ?? '', value: attrs.Value ?? '' })
  }
  return options.length > 0 ? options : undefined
}

/** Extracts every top-level `<Arg …/>` or `<Arg …>…</Arg>` inside `block`, in document order. */
function extractArgs(block) {
  const args = []
  const pattern = /<Arg\s+([^>]*?)\/>|<Arg\s+([^>]*?)>([\s\S]*?)<\/Arg>/g
  let m
  while ((m = pattern.exec(block)) !== null) {
    const attrString = m[1] ?? m[2]
    const attrs = parseAttrs(attrString)
    const inner = m[3] ?? ''
    const metaMatch = /<Meta\s+([^>]*?)\/>/.exec(inner)
    const meta = metaMatch ? parseAttrs(metaMatch[1]) : {}
    const options = extractOptions(inner)
    args.push({
      name: attrs.Name ?? '',
      type: attrs.Type ?? '',
      maxLen: attrs.MaxLen ? Number(attrs.MaxLen) : undefined,
      value: attrs.Value,
      compulsory: meta.Compulsory === undefined ? true : meta.Compulsory !== 'false',
      ...(options ? { options } : {})
    })
  }
  return args
}

/** Extracts every top-level `<Res …/>` or `<Res …>…</Res>` inside a `<Response>` block, in order. */
function extractResponseFields(block) {
  const fields = []
  const pattern = /<Res\s+([^>]*?)\/>|<Res\s+([^>]*?)>([\s\S]*?)<\/Res>/g
  let m
  while ((m = pattern.exec(block)) !== null) {
    const attrString = m[1] ?? m[2]
    const attrs = parseAttrs(attrString)
    if (!attrs.Name) continue // skip the odd unnamed Res (e.g. duplicate hardcoded placeholders)
    const inner = m[3] ?? ''
    const options = extractOptions(inner)
    fields.push({
      name: attrs.Name,
      type: attrs.Type ?? '',
      maxLen: attrs.MaxLen ? Number(attrs.MaxLen) : undefined,
      byte: attrs.Byte !== undefined ? Number(attrs.Byte) : undefined,
      bit: attrs.Bit !== undefined ? Number(attrs.Bit) : undefined,
      ...(options ? { options } : {})
    })
  }
  return fields
}

const commandPattern = /<Command\s+Name="([^"]+)"\s+CmdByte="([^"]*)">([\s\S]*?)<\/Command>/g
const commands = {}
let cmdMatch
while ((cmdMatch = commandPattern.exec(defsXml)) !== null) {
  const [, name, cmdByte, body] = cmdMatch

  const argsBlockMatch = /<Args>([\s\S]*?)<\/Args>/.exec(body)
  const args = argsBlockMatch ? extractArgs(argsBlockMatch[1]) : []

  const responseBlockMatch = /<Response\b[^>]*>([\s\S]*?)<\/Response>/.exec(body)
  const response = responseBlockMatch ? extractResponseFields(responseBlockMatch[1]) : []

  const operationMatch = /<FPOperation>([\s\S]*?)<\/FPOperation>/.exec(body)

  commands[name] = {
    cmdByte,
    operation: operationMatch ? operationMatch[1].trim() : '',
    args,
    response
  }
}

const contract = {
  generatedFrom:
    extname(sourcePath).toLowerCase() === '.js'
      ? 'Tremol vendor SDK Libs/JS/fp.js (var defs)'
      : 'Tremol vendor SDK FP.cs (public string defs)',
  /**
   * The defs blob's own `<GenerationTimeStamp>` — the same value the
   * ZFPLabServer echoes as `<defVer>` on `settings()`, so a fixture
   * states which definition version it is rather than relying on its
   * filename to say so.
   */
  defVersion: /<GenerationTimeStamp>([^<]*)<\/GenerationTimeStamp>/.exec(defsXml)?.[1].trim() ?? '',
  commandCount: Object.keys(commands).length,
  commands
}

writeFileSync(
  join(fixturesDir, `${basename}-contract.json`),
  JSON.stringify(contract, null, 2) + '\n',
  'utf8'
)

console.log(`Extracted ${contract.commandCount} commands.`)
console.log(`Wrote ${join(fixturesDir, `${basename}-defs.xml`)}`)
console.log(`Wrote ${join(fixturesDir, `${basename}-contract.json`)}`)
