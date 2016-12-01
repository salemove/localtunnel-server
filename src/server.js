import express from 'express';
import tldjs from 'tldjs';
import on_finished from 'on-finished';
import Debug from 'debug';
import http_proxy from 'http-proxy';
import http from 'http';
import Promise from 'bluebird';
import R from 'ramda';

import Tunnel from './Tunnel';
import generateId from 'uuid/v4';
import BindingAgent from './BindingAgent';

const debug = new Debug('localtunnel:server');
const logError = new Debug('localtunnel:server:error');

const proxy = http_proxy.createProxyServer({
  target: 'http://localtunnel.github.io'
});

proxy.on('error', function(err) {
  logError(err);
});

proxy.on('proxyReq', function(proxyReq, req, res, options) {
    // rewrite the request so it hits the correct url on github
    // also make sure host header is what we expect
  proxyReq.path = '/www' + proxyReq.path;
  proxyReq.setHeader('host', 'localtunnel.github.io');
});

let tunnels = {};

function maybeProxyRequestToClient(req, res, sock, head) {
  // without a hostname, we won't know who the request is for
  const hostname = req.headers.host;
  if (!hostname) {
    return false;
  }

  let subdomain = tldjs.getSubdomain(hostname);
  if (!subdomain) {
    return false;
  }

  let client = tunnels[subdomain];

  if (!client || subdomain.indexOf('.') !== -1) {
    subdomain = subdomain.split('.');

    for (let i = 0; i <= subdomain.length; i++) {
      const client_id = subdomain.slice(0, i).join('.');
      client = tunnels[client_id];

      if (client) {
        break;
      }
    }
  }

  // no such subdomain
  // we use 502 error to the client to signify we can't service the request
  if (!client) {
    if (res) {
      res.statusCode = 502;
      res.end(`no active client for '${subdomain}'`);
      req.connection.destroy();
    } else if (sock) {
      sock.destroy();
    }

    return true;
  }

  let finished = false;
  if (sock) {
    sock.once('end', function() {
      finished = true;
    });
  } else if (res) {
    // flag if we already finished before we get a socket
    // we can't respond to these requests
    on_finished(res, function(err) {
      finished = true;
      req.connection.destroy();
    });
  } else {
    // not something we are expecting, need a sock or a res
    req.connection.destroy();
    return true;
  }

  // TODO add a timeout, if we run out of sockets, then just 502

  // get client port
  client.next_socket(async socket => {
    // the request already finished or client disconnected
    if (finished) {
      return;
    }

    // happens when client upstream is disconnected (or disconnects)
    // and the proxy iterates the waiting list and clears the callbacks
    // we gracefully inform the user and kill their conn
    // without this, the browser will leave some connections open
    // and try to use them again for new requests
    // we cannot have this as we need bouncy to assign the requests again
    // TODO(roman) we could instead have a timeout above
    // if no socket becomes available within some time,
    // we just tell the user no resource available to service request
    if (!socket) {
      if (res) {
        res.statusCode = 504;
        res.end();
      }

      if (sock) {
        sock.destroy();
      }

      req.connection.destroy();
      return;
    }

    // websocket requests are special in that we simply re-create the header info
    // and directly pipe the socket data
    // avoids having to rebuild the request and handle upgrades via the http client
    if (res === null) {
      const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < (req.rawHeaders.length - 1); i += 2) {
        arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }

      arr.push('');
      arr.push('');

      socket.pipe(sock).pipe(socket);
      socket.write(arr.join('\r\n'));

      await new Promise(resolve => {
        socket.once('end', resolve);
      });

      return;
    }

    // regular http request

    const agent = new BindingAgent({
      socket: socket
    });

    const opt = {
      path: req.url,
      agent: agent,
      method: req.method,
      headers: req.headers
    };

    await new Promise(resolve => {
      // what if error making this request?
      const client_req = http.request(opt, function(client_res) {
        // write response code and headers
        res.writeHead(client_res.statusCode, client_res.headers);

        client_res.pipe(res);
        on_finished(client_res, function(err) {
          resolve();
        });
      });

      // happens if the other end dies while we are making the request
      // so we just end the req and move on
      // we can't really do more with the response here because headers
      // may already be sent
      client_req.on('error', err => {
        req.connection.destroy();
      });

      req.pipe(client_req);
    });
  });

  return true;
}

function newTunnel(id, maxTCPSockets, cb) {
  const opts = {id, maxTCPSockets};
  const tunnel = new Tunnel(opts, {
    endCallback: () => {
      tunnels = R.dissoc(id, tunnels);
    }
  });

  tunnel.start((err, info) => {
    if (err) {
      tunnels = R.dissoc(id, tunnels);
      cb(err);
      return;
    }

    tunnels = R.assoc(id, tunnel, tunnels);

    cb(err, R.merge(info, {id}));
  });
}

module.exports = function(opt = {}) {
  const schema = opt.secure ? 'https' : 'http';
  const app = express();
  const server = http.createServer();

  app.get('/', function(req, res) {
    if (req.query.new === undefined) {
      res.json({hello: 'Hello, this is localtunnel server'});
    } else {
      const id = generateId();
      debug('making new client with id %s', id);

      newTunnel(id, opt.max_tcp_sockets, function(err, info) {
        if (err) {
          res.statusCode = 500;
          return res.end(err.message);
        }

        const url = schema + '://' + id + '.' + req.headers.host;
        res.json(R.merge(info, {url: url}));
      });
    }
  });

  app.get('/api/status', function(_req, res) {
    res.json({tunnels: R.keys(tunnels).length});
  });

  server.on('request', function(req, res) {
    debug('request %s', req.url);

    const configuredHost = opt.host;
    if (configuredHost !== req.headers.host && maybeProxyRequestToClient(req, res, null, null))
      return;

    app(req, res);
  });

  server.on('upgrade', function(req, socket, head) {
    debug('upgrade %s', req.url);

    if (maybeProxyRequestToClient(req, null, socket, head))
      return;

    socket.destroy();
  });

  return server;
};
