import net from 'net';
import Debug from 'debug';
import {isFinished} from 'on-finished';
import BindingAgent from './BindingAgent';
import Rx from 'rxjs/Rx';
import R from 'ramda';
import httpProxy from 'http-proxy';

export default function createTunnel(id, maxConnCount, {endCallback, startCallback}) {
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

    requests.next(socket => {
      if (isFinished(res)) {
        // the request already finished or tunnel disconnected
        debug('already finished, destroying connection');
        req.connection.destroy();
        return Promise.resolve({});
      }

      const agent = new BindingAgent({socket: socket});
      const apiProxy = httpProxy.createProxyServer({
        agent: agent,
        target: {
          host: socket.address().address,
          port: socket.address().port
        }
      });

      return new Promise((resolve, reject) => {
        apiProxy.web(req, res, err => {
          if (err) {
            debug('proxy error', err);
            reject();
          } else {
            resolve();
          }
        });
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
    startCallback({port: port, max_conn_count: maxConnCount});
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
