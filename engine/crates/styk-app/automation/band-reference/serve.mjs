import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../../../..');
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png'};
export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream'}); fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
