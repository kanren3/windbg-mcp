import { mkdirSync, cpSync } from "node:fs";

mkdirSync("dist/data", { recursive: true });
cpSync("src/data/catalog.json", "dist/data/catalog.json");
