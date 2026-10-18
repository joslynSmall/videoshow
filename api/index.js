import { createServer } from "../src/server.js";

const server = createServer();

export default function handler(req, res) {
  server.emit("request", req, res);
}
