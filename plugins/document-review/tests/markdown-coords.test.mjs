import assert from "node:assert/strict";
import test from "node:test";
import { TextCoords } from "../core/markdown/index.ts";
import { corpusDocuments, read } from "./markdown-helpers.mjs";

// Deterministic generator (mulberry32) so the property test is reproducible.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "я", "Ё", " ", "\t", "\n", "\r\n", "\r", "😀", "👍🏽", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇷🇺", "é", "̆", "𝒳", "𠜎", "‍", "️", "&amp;", "\\*", " ", "﻿"];

function sample(rng, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

function checkRoundTrip(text) {
  const coords = new TextCoords(text);
  const cps = Array.from(text);
  assert.equal(coords.length, cps.length);
  assert.equal(coords.utf16Length, text.length);
  assert.equal(coords.utf8Length, Buffer.byteLength(text, "utf8"));
  let unit = 0;
  let byte = 0;
  for (let cp = 0; cp <= cps.length; cp += 1) {
    assert.equal(coords.cpToUtf16(cp), unit, `utf16 at ${cp}`);
    assert.equal(coords.cpToUtf8(cp), byte, `utf8 at ${cp}`);
    assert.equal(coords.utf16ToCp(unit), cp);
    assert.equal(coords.utf8ToCp(byte), cp);
    const { line, column } = coords.cpToLineCol(cp);
    assert.equal(coords.lineColToCp(line, column), cp, `line/col at ${cp}`);
    if (cp < cps.length) {
      unit += cps[cp].length;
      byte += Buffer.byteLength(cps[cp], "utf8");
    }
  }
}

test("T02 coordinates round-trip (code points ↔ UTF-16 ↔ UTF-8 ↔ line/column) on surrogate pairs, ZWJ, combining marks, entities and CRLF", () => {
  const rng = random(20261006);
  for (let i = 0; i < 300; i += 1) checkRoundTrip(sample(rng, 1 + Math.floor(rng() * 40)));
  for (const doc of corpusDocuments()) checkRoundTrip(read(doc));
});

test("T02 line/column: CRLF is one line break, lone CR and LF break lines, columns count code points", () => {
  const coords = new TextCoords("a😀\r\nб\rв\nг");
  assert.equal(coords.lines, 4);
  assert.deepEqual(coords.cpToLineCol(0), { line: 1, column: 1 });
  assert.deepEqual(coords.cpToLineCol(2), { line: 1, column: 3 }, "the emoji is one column");
  assert.deepEqual(coords.cpToLineCol(4), { line: 2, column: 1 }, "after CRLF");
  assert.deepEqual(coords.cpToLineCol(6), { line: 3, column: 1 }, "after lone CR");
  assert.deepEqual(coords.cpToLineCol(8), { line: 4, column: 1 }, "after LF");
  assert.throws(() => coords.lineColToCp(1, 6), RangeError);
  assert.throws(() => coords.lineColToCp(5, 1), RangeError);
});

test("T02 DOM offsets are not W3C offsets: a UTF-16 offset inside a surrogate pair and a byte inside a sequence are rejected", () => {
  const coords = new TextCoords("x👍🏽y");
  assert.equal(coords.length, 4, "thumbs up + skin tone are two code points");
  assert.equal(coords.utf16Length, 6);
  assert.throws(() => coords.utf16ToCp(2), /surrogate/);
  assert.throws(() => coords.utf8ToCp(2), /splits a character/);
  assert.equal(coords.utf16ToCp(5), 3);
  assert.equal(coords.slice({ start: 1, end: 3 }), "👍🏽");
  assert.throws(() => coords.slice({ start: 3, end: 1 }), RangeError);
  assert.throws(() => coords.cpToUtf16(5), RangeError);
  assert.throws(() => coords.cpToUtf16(1.5), RangeError);
});
