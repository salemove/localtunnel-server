import net from 'net';
import Debug from 'debug';
import on_finished from 'on-finished';
import BindingAgent from './BindingAgent';
import http from 'http';
import Rx from 'rxjs/Rx';
import R from 'ramda';

export default function createTunnel(id, {endCallback, startCallback}) {
  const debug = new Debug(`localtunnel:server:${id}`);
  const logError = new Debug(`localtunnel:server:error:${id}`);

  let sockets = [];
  const server = net.createServer();

  const socketsChange = new Rx.ReplaySubject(1);
  const serverClose = new Rx.Subject();
  const requests = new Rx.Subject();

  const markSocketAsInactive = socket => {
    socket.active = false;
    socketsChange.next(sockets);
  };

  const markSocketAsActive = socket => {
    socket.active = true;
    socketsChange.next(sockets);
  };

  const inactivityTimer = Rx.Observable.timer(5000);

  const activity = socketsChange.filter(sockets => sockets.length !== 0);
  const inactivity = socketsChange.startWith([]).filter(sockets => sockets.length === 0)
    .flatMap(() => inactivityTimer.takeUntil(activity));

  const getActiveSocket = socketsChange
    .map(R.filter(R.propEq('active', true)))
    .filter(sockets => sockets.length > 0)
    .map(R.last)
    .take(1);

  const stop = Rx.Observable.merge(inactivity, serverClose).take(1);

  function handleSocket(socket) {
    debug('new connection from: %s:%s', socket.address().address, socket.address().port);

    socket.once('close', function(had_error) {
      sockets = R.reject(s => s === socket, sockets);
      socketsChange.next(sockets);

      debug('closed socket (error: %s, remaining: %s)', had_error, sockets.length);
    });

    // close will be emitted after this
    socket.on('error', function(err) {
      debug('connection error: %s', err);
      socket.destroy();
    });

    socket.active = true;
    sockets = R.append(socket, sockets);
    socketsChange.next(sockets);
  }

  function forwardRequest(req, res) {
    debug('processing http request');

    let finished = false;
    // flag if we already finished before we get a socket
    // we can't respond to these requests
    on_finished(res, function(err) {
      debug('already finished, destroying connection');
      finished = true;
      req.connection.destroy();
    });

    requests.next(socket => {
      // the request already finished or tunnel disconnected
      if (finished) return Promise.resolve({});

      const agent = new BindingAgent({socket: socket});

      const opt = {
        path: req.url,
        agent: agent,
        method: req.method,
        headers: req.headers
      };

      return new Promise(resolve => {
        // what if error making this request?
        const client_req = http.request(opt, function(client_res) {
          // write response code and headers
          res.writeHead(client_res.statusCode, client_res.headers);

          client_res.pipe(res);
          on_finished(client_res, function(err) {
            if (err) logError('client_res error', err);
            resolve();
          });
        });

        // happens if the other end dies while we are making the request
        // so we just end the req and move on
        // we can't really do more with the response here because headers
        // may already be sent
        client_req.on('error', err => {
          logError('client request error', err);
          req.connection.destroy();
        });

        req.pipe(client_req);
      });
    });
  }

  server.on('close', () => serverClose.next());
  server.on('connection', socket => handleSocket(socket));

  server.on('error', function(err) {
    // where do these errors come from?
    // other side creates a connection and then is killed?
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      return;
    }

    logError(err);
  });

  server.listen(() => {
    const port = server.address().port;
    debug('tcp server listening on port: %d', port);

    // Adding max_conn_count as this is required by the client
    startCallback({port: port, max_conn_count: 10});
  });

  stop.subscribe(() => {
    debug('closed tcp socket for client');
    try {
      server.close();
    } catch (err) {}
    endCallback();
  });

  requests
    .takeUntil(stop)
    .flatMap(request =>
      getActiveSocket
        .do(markSocketAsInactive)
        .map(socket => ({request, socket})))
    .subscribe(
      ({request, socket}) =>
        request(socket).then(() => markSocketAsActive(socket)),
      err => logError('Error forwarding request', err)
    );

  return {forwardRequest};
}
