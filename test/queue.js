const http = require('http');
const url = require('url');
const assert = require('assert');
const localtunnel = require('localtunnel');

suite('queue');

const localtunnel_server = require('../src/server')({
  max_tcp_sockets: 1
});

let server;
let lt_server_port;

before('set up localtunnel server', function(done) {
  const lt_server = localtunnel_server.listen(function() {
    lt_server_port = lt_server.address().port;
    done();
  });
});

before('set up local http server', function(done) {
  server = http.createServer();
  server.on('request', function(req, res) {
        // respond sometime later
    setTimeout(function() {
      res.setHeader('x-count', req.headers['x-count']);
      res.end('foo');
    }, 500);
  });

  server.listen(function() {
    const port = server.address().port;

    test._fake_port = port;
    done();
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

test('query localtunnel server w/ ident', function(done) {
  const uri = test._fake_url;
  const hostname = url.parse(uri).hostname;

  let count = 0;
  const opt = {
    host: 'localhost',
    port: lt_server_port,
    agent: false,
    headers: {
      host: hostname + '.tld'
    },
    path: '/'
  };

  const num_requests = 2;
  let responses = 0;

  function maybe_done() {
    if (++responses >= num_requests) {
      done();
    }
  }

  function make_req() {
    opt.headers['x-count'] = count++;
    http.get(opt, function(res) {
      res.setEncoding('utf8');
      let body = '';

      res.on('data', function(chunk) {
        body += chunk;
      });

      res.on('end', function() {
        assert.equal('foo', body);
        maybe_done();
      });
    });
  }

  for (let i = 0; i < num_requests; ++i) {
    make_req();
  }
});

after('shutdown', function() {
  localtunnel_server.close();
});

