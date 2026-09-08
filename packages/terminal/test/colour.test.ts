/**
 * Reading the colour a terminal answers with.
 *
 * The spellings below are the ones an `OSC 11` reply arrives in. Reading them
 * by hand is how a bare hex triple comes out as the wrong colour entirely, so
 * the cases name the exact channels rather than a light or dark verdict, which
 * survives a wrong colour often enough to hide the mistake.
 */
import { expect, test } from "bun:test";
import { loadTerminalColours } from "../src/bun/index.js";

const colours = await loadTerminalColours();

const BASE = { r: 30, g: 30, b: 46 };
const LATTE = { r: 239, g: 241, b: 245 };

test("XParseColor rgb: is read at every channel width", () => {
  expect(colours.parse("rgb:1e1e/1e1e/2e2e")).toEqual(BASE);
  expect(colours.parse("rgb:1e/1e/2e")).toEqual(BASE);
  expect(colours.parse("rgb:ef/f1/f5")).toEqual(LATTE);
  expect(colours.parse("rgb:eeee/f1f1/f5f5")).toEqual({
    r: 238,
    g: 241,
    b: 245,
  });
});

test("a hex triple is read as itself, with or without the hash", () => {
  expect(colours.parse("#1e1e2e")).toEqual(BASE);
  expect(colours.parse("1e1e2e")).toEqual(BASE);
  expect(colours.parse("#eff1f5")).toEqual(LATTE);
});

test("the wider spellings ghostty accepts are read too", () => {
  expect(colours.parse("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  expect(colours.parse("rgbi:0.1/0.1/0.2")).toEqual({ r: 25, g: 25, b: 51 });
  expect(colours.parse("ForestGreen")).toEqual({ r: 34, g: 139, b: 34 });
});

test("spaces and tabs around the value are ignored", () => {
  expect(colours.parse("  #1e1e2e\t")).toEqual(BASE);
});

test("something that is not a colour is nothing, not a failure", () => {
  // A terminal is allowed to answer something this does not understand, and
  // the caller wears the default flavour rather than reporting an error.
  for (const value of ["", "zz", "rgb:zz/zz/zz", "rgb:1e1e1e/1e1e1e/2e2e2e"])
    expect(colours.parse(value), JSON.stringify(value)).toBeUndefined();
});
