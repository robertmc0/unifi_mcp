/**
 * A synthetic UniFi console for the container network tests: HTTPS on 8443 with the test
 * certificate, answering only the documented Network application-info read, and only to
 * the synthetic key. Every request is printed as one JSON line. It has no dependency and
 * runs in the service image (`node /probe/console.ts`).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const key = readFileSync('/pki/network.key', 'utf8').trim();
createServer(
  { key: readFileSync('/pki/console.key'), cert: readFileSync('/pki/console.pem') },
  (req, res) => {
    const authorised = req.headers['x-api-key'] === key;
    console.log(
      JSON.stringify({
        method: req.method,
        url: req.url,
        remote: req.socket.remoteAddress,
        authorised,
      }),
    );
    const send = (status: number, body: object): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!authorised) send(401, { statusCode: 401, statusName: 'UNAUTHORIZED' });
    else if (req.method === 'GET' && req.url === '/proxy/network/integration/v1/info') {
      send(200, { applicationVersion: '11.0.97' });
    } else send(404, { statusCode: 404, statusName: 'NOT_FOUND' });
  },
).listen(8443, '0.0.0.0', () => {
  console.log(JSON.stringify({ listening: 8443 }));
});
