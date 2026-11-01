// Explicit conversions between the four coordinate spaces of one string:
// Unicode code points (W3C offsets), UTF-16 code units (JS / DOM), UTF-8 bytes and 1-based line/column.
// Every offset is a boundary (0..length), never an element index; ranges are end-exclusive.

import type { CpRange } from "../types.ts";

function search(sorted: Uint32Array, value: number): number {
  // Index of value in a strictly increasing array, or -1.
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = sorted[mid];
    if (at === value) return mid;
    if (at < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function floorIndex(sorted: Uint32Array, value: number, count: number): number {
  // Largest i < count with sorted[i] <= value.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (sorted[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class TextCoords {
  readonly text: string;
  /** Length in code points. */
  readonly length: number;
  /** Length in UTF-16 code units. */
  readonly utf16Length: number;
  /** Length in UTF-8 bytes. */
  readonly utf8Length: number;
  private readonly u16: Uint32Array;
  private readonly u8: Uint32Array;
  private readonly lineStarts: Uint32Array;
  private readonly lineCount: number;

  constructor(text: string) {
    this.text = text;
    // Upper bound: one code point per UTF-16 unit.
    const u16 = new Uint32Array(text.length + 1);
    const u8 = new Uint32Array(text.length + 1);
    const starts: number[] = [0];
    let unit = 0;
    let byte = 0;
    let cp = 0;
    let previous = -1;
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i += 1;
        }
      }
      unit += code > 0xffff ? 2 : 1;
      byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      cp += 1;
      u16[cp] = unit;
      u8[cp] = byte;
      // Line breaks: LF, lone CR, and CRLF as one break (the start after CR moves past the LF).
      if (code === 0x0a) {
        if (previous === 0x0d) starts[starts.length - 1] = cp;
        else starts.push(cp);
      } else if (code === 0x0d) starts.push(cp);
      previous = code;
    }
    this.length = cp;
    this.utf16Length = unit;
    this.utf8Length = byte;
    this.u16 = cp === text.length ? u16 : u16.slice(0, cp + 1);
    this.u8 = cp === text.length ? u8 : u8.slice(0, cp + 1);
    this.lineStarts = Uint32Array.from(starts);
    this.lineCount = starts.length;
  }

  private checkCp(cp: number): void {
    if (!Number.isInteger(cp) || cp < 0 || cp > this.length) throw new RangeError(`code point offset ${cp} outside 0..${this.length}`);
  }

  cpToUtf16(cp: number): number {
    this.checkCp(cp);
    return this.u16[cp];
  }

  /** Throws for an offset that falls between the two halves of a surrogate pair. */
  utf16ToCp(unit: number): number {
    if (!Number.isInteger(unit) || unit < 0 || unit > this.utf16Length) throw new RangeError(`UTF-16 offset ${unit} outside 0..${this.utf16Length}`);
    const cp = search(this.u16, unit);
    if (cp < 0) throw new RangeError(`UTF-16 offset ${unit} splits a surrogate pair`);
    return cp;
  }

  cpToUtf8(cp: number): number {
    this.checkCp(cp);
    return this.u8[cp];
  }

  /** Throws for a byte offset inside a multi-byte sequence. */
  utf8ToCp(byte: number): number {
    if (!Number.isInteger(byte) || byte < 0 || byte > this.utf8Length) throw new RangeError(`UTF-8 offset ${byte} outside 0..${this.utf8Length}`);
    const cp = search(this.u8, byte);
    if (cp < 0) throw new RangeError(`UTF-8 offset ${byte} splits a character`);
    return cp;
  }

  /** 1-based line and 1-based column counted in code points. CRLF is one line break. */
  cpToLineCol(cp: number): { line: number; column: number } {
    this.checkCp(cp);
    const line = floorIndex(this.lineStarts, cp, this.lineCount);
    return { line: line + 1, column: cp - this.lineStarts[line] + 1 };
  }

  /** Inverse of cpToLineCol; a column may address any boundary from the line start up to the next line start. */
  lineColToCp(line: number, column: number): number {
    if (!Number.isInteger(line) || line < 1 || line > this.lineCount) throw new RangeError(`line ${line} outside 1..${this.lineCount}`);
    const start = this.lineStarts[line - 1];
    const limit = line < this.lineCount ? this.lineStarts[line] - 1 : this.length;
    const cp = start + column - 1;
    if (!Number.isInteger(column) || column < 1 || cp > limit) throw new RangeError(`column ${column} outside line ${line}`);
    return cp;
  }

  get lines(): number {
    return this.lineCount;
  }

  /** Text of a code point range. */
  slice(range: CpRange): string {
    this.checkRange(range);
    return this.text.slice(this.u16[range.start], this.u16[range.end]);
  }

  checkRange(range: CpRange): void {
    if (!range || typeof range !== "object") throw new RangeError("range must be an object");
    this.checkCp(range.start);
    this.checkCp(range.end);
    if (range.start > range.end) throw new RangeError(`range start ${range.start} after end ${range.end}`);
  }
}
