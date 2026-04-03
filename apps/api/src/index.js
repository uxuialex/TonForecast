import { createServer } from "node:http";
import { handleRequest } from "./server.js";

const port = Number(process.env.PORT ?? "3001");

const server = createServer(async (req, res) => {
  const requestUrl = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const request = new Request(requestUrl, {
    method: req.method,
    headers: req.headers,
  });

  const response = await handleRequest(request);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(await response.text());
});

server.listen(port, () => {
  console.log(`API listening on :${port}`);
});
