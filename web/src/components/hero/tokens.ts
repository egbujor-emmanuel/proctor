export type Token = "--active" | "--suspended" | "--revoked";

/** Dark-scheme status colours: for glyphs on a dark tile, and the fallback when a token can't be read. */
export const BOARD_INK: Record<Token, string> = { "--active": "#6fcf9a", "--suspended": "#e5b55c", "--revoked": "#f08a82" };
