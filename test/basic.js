const http = require('http');
const url = require('url');
const assert = require('assert');
const localtunnel = require('localtunnel');

const localtunnel_server = require('../src/server')();

suite('basic');

let lt_server_port;

before('set up localtunnel server', function(done) {
  const server = localtunnel_server.listen(function() {
    lt_server_port = server.address().port;
    done();
  });
});

test('landing page', function(done) {
  const opt = {
    host: 'localhost',
    port: lt_server_port,
    headers: {
      host: 'example.com'
    },
    path: '/'
  };

  const req = http.request(opt, function(res) {
    res.setEncoding('utf8');
    let body = '';

    res.on('data', function(chunk) {
      body += chunk;
    });

    res.on('end', function() {
      assert(body.indexOf('Redirecting to https://localtunnel.github.io/www/') > 0);
      done();
    });
  });

  req.end();
});

before('set up local http server', function(done) {
  const server = http.createServer();
  server.on('request', function(req, res) {
    res.write('foo');
    res.end();
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

  const opt = {
    host: 'localhost',
    port: lt_server_port,
    headers: {
      host: hostname + '.tld'
    },
    path: '/'
  };

  const req = http.request(opt, function(res) {
    res.setEncoding('utf8');
    let body = '';

    res.on('data', function(chunk) {
      body += chunk;
    });

    res.on('end', function() {
      assert.equal('foo', body);

            // TODO(shtylman) shutdown client
      done();
    });
  });

  req.end();
});

test('request specific domain', function(done) {
  const opt = {
    host: 'http://localhost:' + lt_server_port,
    subdomain: 'abcd'
  };

  localtunnel(test._fake_port, opt, function(err, tunnel) {
    assert.ifError(err);
    const url = tunnel.url;
    assert.ok(new RegExp('^http://.*localhost:' + lt_server_port + '$').test(url));
    test._fake_url = url;
    done(err);
  });
});

test('request domain that is too long', function(done) {
  const opt = {
    host: 'http://localhost:' + lt_server_port,
    subdomain: 'thisdomainisoutsidethesizeofwhatweallowwhichissixtythreecharacters'
  };

  localtunnel(test._fake_port, opt, function(err, tunnel) {
    assert(err);
    assert.equal(err.message, 'Invalid subdomain. ' +
          'Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
    done();
  });
});

test('request uppercase domain', function(done) {
  const opt = {
    host: 'http://localhost:' + lt_server_port,
    subdomain: 'ABCD'
  };

  localtunnel(test._fake_port, opt, function(err, tunnel) {
    assert(err);
    assert.equal(err.message, 'Invalid subdomain. ' +
          'Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
    done();
  });
});

after('shutdown', function() {
  localtunnel_server.close();
});
