import express from 'express';
import on_finished from 'on-finished';
import Debug from 'debug';
import http from 'http';
import Promise from 'bluebird';
import R from 'ramda';

import Tunnel from './Tunnel';
import generateId from 'uuid/v4';
import BindingAgent from './BindingAgent';
import TunnelKeeper from './TunnelKeeper';

const debug = new Debug('localtunnel:server');

const tunnels = new TunnelKeeper();

function maybeProxyRequestToClient(configuredHost, req, res, sock, head) {
  const hostname = req.headers.host;
  if (!hostname) return false;

  const configuredHostIndex = hostname.lastIndexOf(configuredHost);
  if (configuredHostIndex === -1) return false;

  const tunnelId = hostname.slice(0, configuredHostIndex - 1);
  const client = tunnels.find(tunnelId);

  if (!client) {
    if (res) {
      res.statusCode = 502;
      res.end(`no active client for '${tunnelId}'`);
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
    endCallback: () => tunnels.remove(id)
  });

  tunnel.start((err, info) => {
    if (err) {
      tunnels.remove(id);
      cb(err);
      return;
    }

    tunnels.add(id, tunnel);

    cb(err, R.merge(info, {id}));
  });
}

module.exports = function(opt) {
  const schema = opt.secure ? 'https' : 'http';
  const app = express();
  const server = http.createServer();
  const configuredHost = opt.host;

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
    res.json({tunnels: tunnels.count()});
  });

  server.on('request', function(req, res) {
    debug('request %s', req.url);

    if (configuredHost !== req.headers.host && maybeProxyRequestToClient(configuredHost, req, res, null, null))
      return;

    app(req, res);
  });

  server.on('upgrade', function(req, socket, head) {
    debug('upgrade %s', req.url);

    if (maybeProxyRequestToClient(configuredHost, req, null, socket, head))
      return;

    socket.destroy();
  });

  return server;
};
