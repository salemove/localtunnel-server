const http = require('http');
const url = require('url');
const assert = require('assert');
const localtunnel = require('localtunnel');

const localtunnel_server = require('../src/server')({
  max_tcp_sockets: 2,
  host: 'localhost.tld'
});

let lt_server_port;

suite('simple');

test('set up localtunnel server', function(done) {
  const server = localtunnel_server.listen(function() {
    lt_server_port = server.address().port;
    done();
  });
});

test('set up local http server', function(done) {
  const server = http.createServer(function(req, res) {
    res.end('hello world!');
  });

  server.listen(function() {
    test._fake_port = server.address().port;
    done();
  });
});

test('set up localtunnel client', function(done) {
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

test('should respond to request', function(done) {
  const hostname = url.parse(test._fake_url).hostname;
  const opt = {
    host: 'localhost',
    port: lt_server_port,
    headers: {
      host: hostname + '.tld'
    }
  };

  http.get(opt, function(res) {
    let body = '';
    res.setEncoding('utf-8');
    res.on('data', function(chunk) {
      body += chunk;
    });

    res.on('end', function() {
      assert.equal(body, 'hello world!');
      done();
    });
  });
});
