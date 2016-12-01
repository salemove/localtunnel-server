const url = require('url');
const assert = require('assert');
const localtunnel = require('localtunnel');
const WebSocket = require('ws');
const WebSocketServer = require('ws').Server;

const localtunnel_server = require('../src/server')({
  max_tcp_sockets: 2
});

let lt_server_port;

suite('websocket');

before('set up localtunnel server', function(done) {
  const server = localtunnel_server.listen(function() {
    lt_server_port = server.address().port;
    done();
  });
});

before('set up local websocket server', function(done) {
  const wss = new WebSocketServer({port: 0}, function() {
    test._fake_port = wss._server.address().port;
    done();
  });

  wss.on('error', function(err) {
    done(err);
  });

  wss.on('connection', function connection(ws) {
    ws.on('error', function(err) {
      done(err);
    });

    ws.on('message', function incoming(message) {
      ws.send(message);
    });
  });
});

before('set up localtunnel client', function(done) {
  const opt = {
    host: 'http://localhost:' + lt_server_port
  };

  localtunnel(test._fake_port, opt, function(err, tunnel) {
    assert.ifError(err);
    const url = tunnel.url;
    assert.ok(new RegExp('^http://.*localhost:' + lt_server_port + '$').test(url));
    test._fake_url = url;
    done(err);
  });
});

test('websocket server request', function(done) {
  const hostname = url.parse(test._fake_url).hostname;
  const ws = new WebSocket('http://localhost:' + lt_server_port, {
    headers: {
      host: hostname + '.tld'
    }
  });

  ws.on('message', function(msg) {
    assert.equal(msg, 'something');
    done();
  });

  ws.on('open', function open() {
    ws.send('something');
  });
});
