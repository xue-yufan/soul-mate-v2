import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of lines) {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      v: 1,
      ok: true,
      image: Buffer.from("processed-image").toString("base64"),
      mime_type: "image/jpeg",
      metrics: {
        blur_variance: 120,
        brightness: 90,
        contrast: 35,
        width: 1024,
        height: 768,
      },
      applied: ["fixture"],
      elapsed_ms: 2,
      input_image: request.image,
    })}\n`,
  );
}
