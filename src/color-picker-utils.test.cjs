const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeHexColor, rgbToHex, clampSamplePoint } = require("./color-picker-utils.mjs");

test("normalizeHexColor validates and normalizes 6-digit hex colors", () => {
  assert.equal(normalizeHexColor("#394351"), "#394351");
  assert.equal(normalizeHexColor("AABBCC"), "#aabbcc");
  assert.equal(normalizeHexColor(" #12ef90 "), "#12ef90");
  assert.equal(normalizeHexColor("#123"), null);
  assert.equal(normalizeHexColor("#zzzzzz"), null);
  assert.equal(normalizeHexColor(null), null);
});

test("rgbToHex formats clamped RGB bytes", () => {
  assert.equal(rgbToHex(57, 67, 81), "#394351");
  assert.equal(rgbToHex(0, 255, 16), "#00ff10");
  assert.equal(rgbToHex(-5, 300, 12.6), "#00ff0d");
});

test("clampSamplePoint maps scaled coordinates within image bounds", () => {
  assert.deepEqual(clampSamplePoint(0, 0, 1280, 720, 1920, 1080), { x: 0, y: 0 });
  assert.deepEqual(clampSamplePoint(640, 360, 1280, 720, 1920, 1080), { x: 960, y: 540 });
  assert.deepEqual(clampSamplePoint(2000, 1500, 1280, 720, 1920, 1080), { x: 1919, y: 1079 });
  assert.deepEqual(clampSamplePoint(-10, -20, 1280, 720, 1920, 1080), { x: 0, y: 0 });
});
