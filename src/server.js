import express from 'express';
import Debug from 'debug';
import http from 'http';
import R from 'ramda';
import generateId from 'uuid/v4';

import createTunnel from './Tunnel';
import TunnelKeeper from './TunnelKeeper';

const debug = new Debug('localtunnel:server');
const tunnels = new TunnelKeeper();

function findTunnel(configuredHost, req) {
  const hostname = req.headers.host;
  const configuredHostIndex = hostname.lastIndexOf(configuredHost);
  const tunnelId = hostname.slice(0, configuredHostIndex - 1);
  return tunnels.find(tunnelId);
}

function newTunnel(id, cb) {
  const endCallback = () => tunnels.remove(id);
  const startCallback = info => cb(R.merge(info, {id}));
  const tunnel = createTunnel(id, {endCallback, startCallback});
  tunnels.add(id, tunnel);
}

module.exports = function(opt) {
  const schema = opt.secure ? 'https' : 'http';
  const app = express();
  const server = http.createServer();
  const configuredHost = opt.host;

  const useProxy = req => {
    const hostname = req.headers.host;
    const missingHostname = !hostname;
    const pointsToRootHost = configuredHost === hostname;
    const includesConfiguredHost = hostname.lastIndexOf(configuredHost) === -1;
    return !(missingHostname || pointsToRootHost || includesConfiguredHost);
  };

  app.get('/', function(req, res) {
    if (req.query.new === undefined) {
      res.json({hello: 'Hello, this is localtunnel server'});
    } else {
      const id = generateId();
      debug('making new tunnel with id %s', id);

      newTunnel(id, function(info) {
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

    if (useProxy(req)) {
      const tunnel = findTunnel(configuredHost, req);

      if (tunnel) {
        tunnel.forwardHTTPRequest(req, res);
      } else {
        res.statusCode = 502;
        res.end(`No tunnel for ${req.headers.host}`);
        req.connection.destroy();
      }
    } else {
      app(req, res);
    }
  });

  server.on('upgrade', function(req, socket, head) {
    debug('upgrade %s', req.url);

    if (useProxy(req)) {
      const tunnel = findTunnel(configuredHost, req);

      if (tunnel)
        tunnel.forwardSocket(req, socket, head);
      else
        socket.destroy();
    } else {
      socket.destroy();
    }
  });

  return server;
};
