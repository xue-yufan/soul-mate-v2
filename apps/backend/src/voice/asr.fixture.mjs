import fs from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : "";
if (!output) {
  console.error("fixture requires --output");
  process.exit(2);
}
fs.writeFileSync(`${output}.txt`, "你好，这是本地语音识别。\n");
