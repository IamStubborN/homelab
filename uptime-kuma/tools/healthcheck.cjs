const http = require("node:http");
const request = http.get("http://127.0.0.1:3001/api/entry-page", (response) => {
  let body = "";
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    try {
      const data = JSON.parse(body);
      process.exit(response.statusCode === 200 && data.type === "entryPage" ? 0 : 1);
    } catch { process.exit(1); }
  });
});
request.setTimeout(3000, () => request.destroy());
request.on("error", () => process.exit(1));
