var http = require('http');
var url = require('url');
var assert = require('assert');
var localtunnel = require('localtunnel');

var localtunnel_server = require('../src/server')();

suite('basic');

var lt_server_port;

before('set up localtunnel server', function(done) {
    var server = localtunnel_server.listen(function() {
        lt_server_port = server.address().port;
        done();
    });
});

test('landing page', function(done) {
    var opt = {
        host: 'localhost',
        port: lt_server_port,
        headers: {
            host: 'example.com'
        },
        path: '/'
    };

    var req = http.request(opt, function(res) {
        res.setEncoding('utf8');
        var body = '';

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
    var server = http.createServer();
    server.on('request', function(req, res) {
        res.write('foo');
        res.end();
    });
    server.listen(function() {
        var port = server.address().port;

        test._fake_port = port;
        done();
    });
});

before('set up localtunnel client', function(done) {
    var opt = {
        host: 'http://localhost:' + lt_server_port
    };

    localtunnel(test._fake_port, opt, function(err, tunnel) {
        assert.ifError(err);
        var url = tunnel.url;
        assert.ok(new RegExp('^http:\/\/.*localhost:' + lt_server_port + '$').test(url));
        test._fake_url = url;
        done(err);
    });
});

test('query localtunnel server w/ ident', function(done) {
    var uri = test._fake_url;
    var hostname = url.parse(uri).hostname;

    var opt = {
        host: 'localhost',
        port: lt_server_port,
        headers: {
            host: hostname + '.tld'
        },
        path: '/'
    };

    var req = http.request(opt, function(res) {
        res.setEncoding('utf8');
        var body = '';

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
    var opt = {
        host: 'http://localhost:' + lt_server_port,
        subdomain: 'abcd'
    };

    localtunnel(test._fake_port, opt, function(err, tunnel) {
        assert.ifError(err);
        var url = tunnel.url;
        assert.ok(new RegExp('^http:\/\/.*localhost:' + lt_server_port + '$').test(url));
        test._fake_url = url;
        done(err);
    });
});

test('request domain that is too long', function(done) {
    var opt = {
        host: 'http://localhost:' + lt_server_port,
        subdomain: 'thisdomainisoutsidethesizeofwhatweallowwhichissixtythreecharacters'
    };

    localtunnel(test._fake_port, opt, function(err, tunnel) {
        assert(err);
        assert.equal(err.message, 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
        done();
    });
});

test('request uppercase domain', function(done) {
    var opt = {
        host: 'http://localhost:' + lt_server_port,
        subdomain: 'ABCD'
    };

    localtunnel(test._fake_port, opt, function(err, tunnel) {
        assert(err);
        assert.equal(err.message, 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
        done();
    });
});

after('shutdown', function() {
    localtunnel_server.close();
});
