import net from 'net';
import Debug from 'debug';
import on_finished from 'on-finished';
import BindingAgent from './BindingAgent';
import http from 'http';

const logError = new Debug('localtunnel:server:error');

const Tunnel = function(opt, {endCallback}) {
  const self = this;

  self.endCallback = endCallback;
  self.sockets = [];
  self.waiting = [];
  self.id = opt.id;

  // default max is 10
  self.max_tcp_sockets = opt.maxTCPSockets || 10;

  // new tcp server to service requests for this client
  self.server = net.createServer();

  // track initial user connection setup
  self.conn_timeout = undefined;

  self.debug = new Debug(`localtunnel:server:${self.id}`);
};

Tunnel.prototype.start = function(cb) {
  const self = this;
  const server = self.server;

  server.on('close', self._cleanup.bind(self));
  server.on('connection', self._handle_socket.bind(self));

  server.on('error', function(err) {
    // where do these errors come from?
    // other side creates a connection and then is killed?
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      return;
    }

    logError(err);
  });

  server.listen(function() {
    const port = server.address().port;
    self.debug('tcp server listening on port: %d', port);

    cb({port: port, max_conn_count: self.max_tcp_sockets});
  });

  self._maybe_destroy();
};

Tunnel.prototype._maybe_destroy = function() {
  const self = this;

  clearTimeout(self.conn_timeout);
  self.conn_timeout = setTimeout(function() {
        // sometimes the server is already closed but the event has not fired?
    try {
      clearTimeout(self.conn_timeout);
      self.server.close();
    } catch (err) {
      self._cleanup();
    }
  }, 5000);
};

// new socket connection from client for tunneling requests to client
Tunnel.prototype._handle_socket = function(socket) {
  const self = this;

  // no more socket connections allowed
  if (self.sockets.length >= self.max_tcp_sockets) {
    return socket.end();
  }

  self.debug('new connection from: %s:%s', socket.address().address, socket.address().port);

  // a single connection is enough to keep client id slot open
  clearTimeout(self.conn_timeout);

  socket.once('close', function(had_error) {
    self.debug('closed socket (error: %s)', had_error);

    // what if socket was servicing a request at this time?
    // then it will be put back in available after right?
    // we need a list of sockets servicing requests?

    // remove this socket
    const idx = self.sockets.indexOf(socket);
    if (idx >= 0) {
      self.sockets.splice(idx, 1);
    }

    // need to track total sockets, not just active available
    self.debug('remaining client sockets: %s', self.sockets.length);

    // no more sockets for this ident
    if (self.sockets.length === 0) {
      self.debug('all sockets disconnected');
      self._maybe_destroy();
    }
  });

  // close will be emitted after this
  socket.on('error', function(err) {
    // we don't log here to avoid logging crap for misbehaving clients
    socket.destroy();
  });

  self.sockets.push(socket);
  self._process_waiting();
};

Tunnel.prototype._process_waiting = function() {
  const self = this;
  const wait_cb = self.waiting.shift();
  if (wait_cb) {
    self.debug('handling queued request');
    self.next_socket(wait_cb);
  }
};

Tunnel.prototype._cleanup = function() {
  const self = this;
  self.debug('closed tcp socket for client(%s)', self.id);

  clearTimeout(self.conn_timeout);

  // clear waiting by ending responses, (requests?)
  self.waiting.forEach(handler => handler(null));

  self.endCallback();
};

Tunnel.prototype.forwardHTTPRequest = function(req, res) {
  const self = this;

  let finished = false;
  // flag if we already finished before we get a socket
  // we can't respond to these requests
  on_finished(res, function(err) {
    finished = true;
    req.connection.destroy();
  });

  self.next_socket(async socket => {
    // the request already finished or tunnel disconnected
    if (finished) return;

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
      res.statusCode = 504;
      res.end();
      req.connection.destroy();
      return;
    }

    const agent = new BindingAgent({socket: socket});

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
};

Tunnel.prototype.forwardSocket = function(req, sock, head) {
  const self = this;

  let finished = false;
  sock.once('end', () => {
    finished = true;
  });

  self.next_socket(async socket => {
    // the request already finished or tunnel disconnected
    if (finished)
      return;

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
      sock.destroy();
      req.connection.destroy();
      return;
    }

    // websocket requests are special in that we simply re-create the header info
    // and directly pipe the socket data
    // avoids having to rebuild the request and handle upgrades via the http client
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
  });
};

Tunnel.prototype.next_socket = function(handler) {
  const self = this;

  // socket is a tcp connection back to the user hosting the site
  const sock = self.sockets.shift();

  if (!sock) {
    self.debug('no more client, queue callback');
    self.waiting.push(handler);
    return;
  }

  const onRequestProcessed = () => {
    if (!sock.destroyed) {
      self.debug('retuning socket');
      self.sockets.push(sock);
    }

    // no sockets left to process waiting requests
    if (self.sockets.length === 0) {
      return;
    }

    self._process_waiting();
  };

  self.debug('processing request');
  handler(sock)
    .then(onRequestProcessed)
    .catch(err => {
      logError(err);
      onRequestProcessed();
    });
};

export default Tunnel;
