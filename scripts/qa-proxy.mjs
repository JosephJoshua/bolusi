#!/usr/bin/env node
// QA-only request log in front of the lane server, loopback only. `pnpm qa:mobile up` starts it and
// builds the app against it, so every QA run records which requests the app sent and what came back.
//   QA_PROXY_PORT (default 3091) -> QA_UPSTREAM_PORT (default 3000), both on 127.0.0.1.
// One line per request: ISO time, method, path (query dropped), status, ms, request/response byte
// counts. Bodies, headers and tokens are never logged. WebSocket upgrades (/v1/realtime) are piped
// through; only their method, path and status are logged.
import http from 'node:http';
import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = Number(process.env.QA_PROXY_PORT ?? 3091);
const UP_PORT = Number(process.env.QA_UPSTREAM_PORT ?? 3000);
const pathOf = (url) => (url ?? '').split('?')[0];
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  let reqBytes = 0;
  let resBytes = 0;
  const up = http.request(
    { host: HOST, port: UP_PORT, method: req.method, path: req.url, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on('data', (chunk) => {
        resBytes += chunk.length;
      });
      ur.pipe(res);
      ur.on('end', () =>
        log(
          `${req.method} ${pathOf(req.url)} ${ur.statusCode} ${Date.now() - t0}ms req=${reqBytes}B res=${resBytes}B`,
        ),
      );
    },
  );
  up.on('error', (error) => {
    log(`${req.method} ${pathOf(req.url)} PROXY_ERROR ${error.code}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on('data', (chunk) => {
    reqBytes += chunk.length;
  });
  req.pipe(up);
});

// Replay the raw request head upstream, then pipe both sockets.
server.on('upgrade', (req, client, head) => {
  const upstream = net.connect(UP_PORT, HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.once('data', (chunk) => {
      const status = chunk.toString('latin1').split('\r\n')[0].split(' ')[1] ?? '?';
      log(`UPGRADE ${req.method} ${pathOf(req.url)} ${status}`);
    });
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', (error) => {
    log(`UPGRADE ${req.method} ${pathOf(req.url)} PROXY_ERROR ${error.code}`);
    close();
  });
  client.on('error', close);
  upstream.on('close', close);
  client.on('close', close);
});

server.listen(PORT, HOST, () => log(`qa-proxy listening ${HOST}:${PORT} -> ${HOST}:${UP_PORT}`));
