import { roles, type FlavourName, type Roles } from "@werk/palette";

/**
 * The one flavour this page wears, decided once when the module loads.
 *
 * The page's own colours come from `palette.css`, which carries both flavours
 * and lets `prefers-color-scheme` pick. Two surfaces cannot be reached that way:
 * the replica, whose cells are painted from resolved integers, and the preview
 * tiles, which decode SGR into inline styles. Both read this instead, so all
 * three agree on what the page is wearing.
 *
 * A page that read a different flavour in one of those places is not a
 * hypothetical: it is what the page did before, painting Catppuccin chrome
 * around a terminal in the engine's own colours.
 *
 * The choice is made once rather than followed. Changing appearance mid-session
 * would need the replica's palette reseeded, which nothing does yet.
 */
function preferred(): FlavourName {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: light)").matches
    ? "latte"
    : "mocha";
}

let chosen: Roles | undefined;

export function pageTheme(): Roles {
  if (chosen === undefined) {
    chosen = roles(preferred());
    // What the page is wearing, so a reader of the DOM can find out. A test
    // asserting on a colour reads this and then asks the palette, rather than
    // naming a flavour it cannot know the page picked.
    document.documentElement.dataset.werkFlavour = chosen.flavour;
  }
  return chosen;
}
