import net from 'net';
import Debug from 'debug';
import on_finished from 'on-finished';
import BindingAgent from './BindingAgent';
import http from 'http';

const logError = new Debug('localtunnel:server:error');

export default function createTunnel(id, {endCallback, startCallback}) {
  let sockets = [];
  let waiting = [];
  const debug = new Debug(`localtunnel:server:${id}`);

  // new tcp server to service requests for this client
  const server = net.createServer();

  // track initial user connection setup
  let conn_timeout;

  server.on('close', _cleanup);
  server.on('connection', _handle_socket);

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
    debug('tcp server listening on port: %d', port);

    // Adding max_conn_count as this is required by the client
    startCallback({port: port, max_conn_count: 10});
  });

  _maybe_destroy();

  function _maybe_destroy() {
    clearTimeout(conn_timeout);
    conn_timeout = setTimeout(function() {
      // sometimes the server is already closed but the event has not fired?
      try {
        clearTimeout(conn_timeout);
        server.close();
      } catch (err) {
        _cleanup();
      }
    }, 5000);
  }

  // new socket connection from client for tunneling requests to client
  function _handle_socket(socket) {
    debug('new connection from: %s:%s', socket.address().address, socket.address().port);

    // a single connection is enough to keep client id slot open
    clearTimeout(conn_timeout);

    socket.once('close', function(had_error) {
      debug('closed socket (error: %s)', had_error);

      // what if socket was servicing a request at this time?
      // then it will be put back in available after right?
      // we need a list of sockets servicing requests?

      // remove this socket
      const idx = sockets.indexOf(socket);
      if (idx >= 0) {
        sockets.splice(idx, 1);
      }

      // need to track total sockets, not just active available
      debug('remaining client sockets: %s', sockets.length);

      // no more sockets for this ident
      if (sockets.length === 0) {
        debug('all sockets disconnected');
        _maybe_destroy();
      }
    });

    // close will be emitted after this
    socket.on('error', function(err) {
      // we don't log here to avoid logging crap for misbehaving clients
      socket.destroy();
    });

    sockets.push(socket);
    _process_waiting();
  }

  function _process_waiting() {
    const wait_cb = waiting.shift();
    if (wait_cb) {
      debug('handling queued request');
      next_socket(wait_cb);
    }
  }

  function _cleanup() {
    debug('closed tcp socket for client');

    clearTimeout(conn_timeout);

    // clear waiting by ending responses, (requests?)
    waiting.forEach(handler => handler(null));

    endCallback();
  }

  function forwardHTTPRequest(req, res) {
    let finished = false;
    // flag if we already finished before we get a socket
    // we can't respond to these requests
    on_finished(res, function(err) {
      finished = true;
      req.connection.destroy();
    });

    next_socket(async socket => {
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
  }

  function forwardSocket(req, sock, head) {
    let finished = false;
    sock.once('end', () => {
      finished = true;
    });

    next_socket(async socket => {
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
  }

  function next_socket(handler) {
    // socket is a tcp connection back to the user hosting the site
    const sock = sockets.shift();

    if (!sock) {
      debug('no more client, queue callback');
      waiting.push(handler);
      return;
    }

    const onRequestProcessed = () => {
      if (!sock.destroyed) {
        debug('retuning socket');
        sockets.push(sock);
      }

      // no sockets left to process waiting requests
      if (sockets.length === 0) {
        return;
      }

      _process_waiting();
    };

    debug('processing request');
    handler(sock)
      .then(onRequestProcessed)
      .catch(err => {
        logError(err);
        onRequestProcessed();
      });
  }

  return {forwardHTTPRequest, forwardSocket};
}
