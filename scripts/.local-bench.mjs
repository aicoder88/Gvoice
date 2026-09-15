import { readFileSync } from "node:fs";
// Pull the real cleanup system prompt out of the source so the benchmark uses
// the same instructions the app sends, not a stand-in.
const src = readFileSync(new URL("../src/cleanup.js", import.meta.url), "utf8");
const start = src.indexOf("return `OUTPUT FORMAT");
const end = src.indexOf("`;", start);
let sys = src.slice(start + "return `".length, end);
sys = sys.replace(/\$\{selfCorrectionOn \? `([\s\S]*?)` : ""\}/g, "$1")
         .replace(/\$\{selfCorrectionOn \? "(.*?)" : "(.*?)"\}/g, "$1")
         .replace(/\\n/g, "\n").replace(/\`/g, "`");
console.log("system prompt chars:", sys.length, " ~tokens:", Math.round(sys.length / 4));

const cases = [
  "Install AutoHotkey and set up. The Mac copy and paste shortcuts.",
  "Sometimes I pause while. Dictating and the transcription. Adds entirely too many periods."
];
const model = process.argv[2] || "gemma-4-e2b-uncensored-hauhaucs-aggressive";
for (const text of cases) {
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: "Clean up the dictation transcript below using the rules. YOUR RESPONSE MUST BE ONLY THE CLEANED TRANSCRIPT.\n\n<<<TRANSCRIPT>>>\n" + text + "\n<<<END>>>" }
      ]
    })
  });
  const data = await res.json();
  const ms = Date.now() - t0;
  console.log("\nIN :", text);
  console.log("OUT:", JSON.stringify(data.choices?.[0]?.message?.content ?? data));
  console.log("ms :", ms, " usage:", JSON.stringify(data.usage || {}));
}
