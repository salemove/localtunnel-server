import {expect} from 'chai';
import TunnelKeeper from '../src/TunnelKeeper';

suite('tunnelkeeper');

describe('TunnelKeeper', () => {
  describe('#find', () => {
    it('returns null for a non-existing tunnel', function() {
      const tunnelKeeper = new TunnelKeeper();
      const tunnel = tunnelKeeper.find('non-existing-subdomain');
      expect(tunnel).to.eql(null);
    });

    it('returns a tunnel using id', () => {
      const tunnelKeeper = new TunnelKeeper();
      const tunnel = 'a-tunnel';
      tunnelKeeper.add('id', tunnel);

      const result = tunnelKeeper.find('id');
      expect(result).to.eql(tunnel);
    });

    it('returns null when tunnel has been removed', () => {
      const tunnelKeeper = new TunnelKeeper();
      const tunnel = 'a-tunnel';
      tunnelKeeper.add('id', tunnel);
      tunnelKeeper.remove('id');

      const result = tunnelKeeper.find('id');
      expect(result).to.eql(null);
    });
  });

  describe('#count', () => {
    it('returns tunnel count', () => {
      const tunnelKeeper = new TunnelKeeper();
      tunnelKeeper.add('id1', 'first');
      tunnelKeeper.add('id2', 'second');

      const result = tunnelKeeper.count();
      expect(result).to.eql(2);
    });
  });
});
