import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basePath = "/bizportal/";
const cookie = `session=${"x".repeat(24_000)}`;
const startupTimeoutMs = 15_000;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine an available preview port."));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function requestPreview(url) {
  return fetch(url, {
    headers: {
      Cookie: cookie,
    },
  });
}

async function waitForEntrypoint(url, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastStatus;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `BizPortal preview exited before becoming ready.\n${output.join("")}`,
      );
    }

    try {
      const response = await requestPreview(url);
      lastStatus = response.status;

      if (response.status === 431) {
        throw new Error(
          "BizPortal preview returned HTTP 431 for the large session cookie.",
        );
      }

      if (response.ok) {
        return response.text();
      }

      await response.text();
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 431")) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `BizPortal preview did not return its entrypoint within ${startupTimeoutMs}ms` +
      (lastStatus ? ` (last status: ${lastStatus}).` : "."),
  );
}

const port = await getAvailablePort();
const previewUrl = `http://127.0.0.1:${port}${basePath}`;
const output = [];
const child = spawn("pnpm", ["run", "dev"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    BASE_PATH: basePath,
    NODE_ENV: "development",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

try {
  const entrypoint = await waitForEntrypoint(previewUrl, child, output);
  const moduleMatch = entrypoint.match(
    /<script\s+type="module"\s+src="([^"]+)"/,
  );

  if (!moduleMatch) {
    throw new Error("BizPortal entrypoint did not declare a JavaScript module.");
  }

  const moduleUrl = new URL(moduleMatch[1], previewUrl).toString();
  const moduleResponse = await requestPreview(moduleUrl);

  if (moduleResponse.status === 431) {
    throw new Error(
      "BizPortal JavaScript module returned HTTP 431 for the large session cookie.",
    );
  }

  if (!moduleResponse.ok) {
    throw new Error(
      `BizPortal JavaScript module returned HTTP ${moduleResponse.status}.`,
    );
  }

  await moduleResponse.text();
  console.log(
    `BizPortal preview smoke passed: entrypoint and module accepted a ${cookie.length}-byte cookie.`,
  );
} finally {
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        child.kill("SIGTERM");
      }
    }
  }
}