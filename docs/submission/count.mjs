// Prints each X post's length the way X counts it (any URL counts as 23).
//   node docs/submission/count.mjs
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("./X_THREAD.md", import.meta.url), "utf8");
const posts = text.split(/\n\*\*\d+\/\*\*.*\n/).slice(1);
let ok = true;
posts.forEach((raw, i) => {
  const post = `${i + 1}/\n\n${raw.trim()}`.replace(/https?:\/\/\S+/g, "x".repeat(23));
  const length = [...post].length;
  if (length > 280) ok = false;
  console.log(`${String(i + 1).padStart(2)}: ${length}${length > 280 ? "  <-- over 280" : ""}`);
});
process.exit(ok ? 0 : 1);
