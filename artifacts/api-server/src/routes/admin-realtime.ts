import { Router, type IRouter, type Request, type Response } from "express";
import { authenticateAdmin } from "./admin-auth";

const router: IRouter = Router();
const adminConnections = new Set<Response>();

type FlushableResponse = Response & {
  flush?: () => void;
};

function flushResponse(response: Response): void {
  (response as FlushableResponse).flush?.();
}

function openStream(response: Response, event: string): void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.setHeader("Content-Encoding", "identity");
  response.flushHeaders();
  response.write(`retry: 15000\nevent: ${event}\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  flushResponse(response);
}

function addAdminStream(request: Request, response: Response, event: string): void {
  openStream(response, event);
  adminConnections.add(response);

  const heartbeat = setInterval(() => {
    try {
      response.write(":heartbeat\n\n");
      flushResponse(response);
    } catch {
      clearInterval(heartbeat);
      adminConnections.delete(response);
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    adminConnections.delete(response);
  };
  request.on("close", cleanup);
  request.on("error", cleanup);
}

function addMessageStream(request: Request, response: Response, payload: unknown): void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.setHeader("Content-Encoding", "identity");
  response.flushHeaders();
  response.write(`retry: 15000\ndata: ${JSON.stringify(payload)}\n\n`);
  flushResponse(response);
  adminConnections.add(response);

  const heartbeat = setInterval(() => {
    try {
      response.write(":heartbeat\n\n");
      flushResponse(response);
    } catch {
      clearInterval(heartbeat);
      adminConnections.delete(response);
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    adminConnections.delete(response);
  };
  request.on("close", cleanup);
  request.on("error", cleanup);
}

router.use(authenticateAdmin);

router.get("/drivers/events", (request, response) => {
  addAdminStream(request, response, "connected");
});

router.get("/sport-center/events", (request, response) => {
  addMessageStream(request, response, { type: "connected" });
});

router.get("/alerts/stream", (request, response) => {
  openStream(response, "message");
  response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  flushResponse(response);
  adminConnections.add(response);

  const heartbeat = setInterval(() => {
    try {
      response.write(":heartbeat\n\n");
      flushResponse(response);
    } catch {
      clearInterval(heartbeat);
      adminConnections.delete(response);
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    adminConnections.delete(response);
  };
  request.on("close", cleanup);
  request.on("error", cleanup);
});

export default router;
