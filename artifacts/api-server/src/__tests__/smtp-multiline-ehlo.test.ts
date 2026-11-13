import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it } from "vitest";
import { waitForResponse } from "../lib/smtp";

describe("SMTP reply parsing", () => {
  it("preserves AUTH capabilities from intermediate EHLO response lines", async () => {
    const socket = new EventEmitter() as unknown as net.Socket;
    const pending = waitForResponse(socket);
    socket.emit("data", Buffer.from(
      "250-smtp.example.test\r\n250-PIPELINING\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n",
    ));
    const result = await pending;
    expect(result.code).toBe(250);
    expect(result.text).toContain("250-AUTH LOGIN PLAIN");
    expect(result.text).toContain("250 SIZE 10485760");
  });

  it("accumulates a multiline response split across network chunks", async () => {
    const socket = new EventEmitter() as unknown as net.Socket;
    const pending = waitForResponse(socket);
    socket.emit("data", Buffer.from("250-smtp.example.test\r\n250-AU"));
    socket.emit("data", Buffer.from("TH LOGIN\r\n250 HELP\r\n"));
    const result = await pending;
    expect(result.code).toBe(250);
    expect(result.text).toContain("250-AUTH LOGIN");
    expect(result.text.split("\n")).toHaveLength(3);
  });
});
