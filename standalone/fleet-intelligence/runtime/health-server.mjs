import { createServer } from "node:http";
import { assertFleetEnvironmentIsolation } from "./environment.mjs";

const env = assertFleetEnvironmentIsolation(process.env);
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer.");

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "fleet-intelligence",
      environment: env.appEnv,
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ service: "fleet-intelligence", port, environment: env.appEnv }));
});
