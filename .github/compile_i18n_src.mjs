import { writeFile } from "node:fs/promises";
import translations from "../src/locales/en.mjs";

await writeFile(
    new URL("../src/locales/en.json", import.meta.url),
    JSON.stringify(translations, null, 2) + "\n"
);